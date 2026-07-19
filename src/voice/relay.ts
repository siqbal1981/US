// ConversationRelay websocket handler (SPEC.md §7).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastifyInstance = import("fastify").FastifyInstance<any, any, any, any, any>;
import type { WebSocket } from "ws";
import type { Tenant } from "@prisma/client";
import { prisma } from "../db/client.js";
import { runTurn } from "../agent/brain.js";
import { getSession, saveSession, getResumeSessionId, setResumeSession } from "../session/store.js";
import { logger } from "../logger.js";

const SILENCE_TIMEOUT_MS = 8000;

interface RelayState {
  callSid?: string;
  tenant?: Tenant;
  callerNumber?: string;
  ttsEstimateTimer?: NodeJS.Timeout;
  silenceTimer?: NodeJS.Timeout;
  silenceStrikes: number;
  startedAt: number;
  outcomeOverride?: "abandoned" | "completed" | "escalated";
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function clearTimers(state: RelayState): void {
  if (state.ttsEstimateTimer) {
    clearTimeout(state.ttsEstimateTimer);
    state.ttsEstimateTimer = undefined;
  }
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = undefined;
  }
}

/**
 * Prescribed timer scheme (SPEC.md §7): a prior build's silence timer fired
 * while the agent was still speaking. Arm the 8s silence timer only AFTER
 * an estimated TTS duration has elapsed, never immediately after sending text.
 */
function armSilenceAfterReply(socket: WebSocket, state: RelayState, replyText: string): void {
  clearTimers(state);
  const ttsEstimateMs = Math.max(2000, (replyText.length / 14) * 1000);
  state.ttsEstimateTimer = setTimeout(() => {
    state.silenceTimer = setTimeout(() => {
      void onSilenceTimeout(socket, state);
    }, SILENCE_TIMEOUT_MS);
  }, ttsEstimateMs);
}

async function onSilenceTimeout(socket: WebSocket, state: RelayState): Promise<void> {
  state.silenceStrikes += 1;

  if (state.silenceStrikes === 1) {
    const text = "Are you still there?";
    sendJson(socket, { type: "text", token: text, last: true });
    armSilenceAfterReply(socket, state, text);
    return;
  }

  if (state.silenceStrikes === 2) {
    const text = "Would you like me to connect you with someone instead?";
    sendJson(socket, { type: "text", token: text, last: true });
    armSilenceAfterReply(socket, state, text);
    return;
  }

  const text = "Okay, goodbye!";
  sendJson(socket, { type: "text", token: text, last: true });
  state.outcomeOverride = "abandoned";
  sendJson(socket, { type: "end" });
  setTimeout(() => socket.close(), 300);
}

async function markLastReplyInterrupted(callSid: string): Promise<void> {
  const session = await getSession(callSid);
  if (!session || session.history.length === 0) return;
  const last = session.history[session.history.length - 1];
  if (last.role === "assistant" && !last.content.endsWith(" [interrupted]")) {
    last.content += " [interrupted]";
    await saveSession(callSid, session);
  }
}

async function handleSetup(socket: WebSocket, state: RelayState, msg: Record<string, unknown>): Promise<void> {
  const callSid = String(msg.callSid ?? "");
  const to = String(msg.to ?? "");
  const from = msg.from ? String(msg.from) : undefined;

  state.callSid = callSid;
  state.callerNumber = from;

  const tenant = await prisma.tenant.findUnique({ where: { twilioNumber: to } });
  if (!tenant) {
    logger.warn({ to }, "voice/relay setup: unknown tenant number");
    sendJson(socket, { type: "text", token: "Sorry, this number isn't in service. Goodbye.", last: true });
    sendJson(socket, { type: "end" });
    socket.close();
    return;
  }
  state.tenant = tenant;

  if (from && callSid) {
    const resumeSessionId = await getResumeSessionId(tenant.id, from);
    if (resumeSessionId && resumeSessionId !== callSid) {
      const existing = await getSession(resumeSessionId);
      if (existing && !existing.orderSubmitted) {
        await saveSession(callSid, existing);
        const summary =
          existing.cart.length > 0
            ? existing.cart.map((c) => `${c.quantity}x ${c.name}`).join(", ")
            : "your order";
        const greeting = `Welcome back — you had ${summary} in your order, want to pick up where we left off?`;
        sendJson(socket, { type: "text", token: greeting, last: true });
        armSilenceAfterReply(socket, state, greeting);
      }
    }
    await setResumeSession(tenant.id, from, callSid);
  }
}

async function handlePrompt(socket: WebSocket, state: RelayState, msg: Record<string, unknown>): Promise<void> {
  clearTimers(state);
  state.silenceStrikes = 0;

  if (!state.tenant || !state.callSid) return;

  const voicePrompt = typeof msg.voicePrompt === "string" ? msg.voicePrompt : "";
  if (!voicePrompt) return;

  const result = await runTurn(state.callSid, state.tenant, voicePrompt, { voiceMode: true });

  logger.info(
    {
      sessionId: state.callSid,
      tenantId: state.tenant.id,
      tools: result.toolsUsed,
      latencyMs: result.latencyMs,
      inTok: result.usage.inputTokens,
      outTok: result.usage.outputTokens,
    },
    "agent turn",
  );

  sendJson(socket, { type: "text", token: result.reply, last: true });
  armSilenceAfterReply(socket, state, result.reply);
}

function handleInterrupt(state: RelayState): void {
  clearTimers(state);
  if (state.callSid) {
    void markLastReplyInterrupted(state.callSid);
  }
}

function handleError(socket: WebSocket, state: RelayState, msg: Record<string, unknown>): void {
  logger.error({ msg }, "conversation relay error event");
  const text = "Sorry, I didn't catch that — could you say that again?";
  sendJson(socket, { type: "text", token: text, last: true });
  armSilenceAfterReply(socket, state, text);
}

async function handleClose(state: RelayState): Promise<void> {
  clearTimers(state);
  if (!state.callSid) return;

  const durationSec = Math.round((Date.now() - state.startedAt) / 1000);
  const session = await getSession(state.callSid);

  let outcome: string;
  if (state.outcomeOverride) outcome = state.outcomeOverride;
  else if (session?.orderSubmitted) outcome = "completed";
  else if (session?.escalated) outcome = "escalated";
  else outcome = "abandoned";

  await prisma.callLog
    .update({ where: { callSid: state.callSid }, data: { durationSec, outcome } })
    .catch((err) => logger.error({ err, callSid: state.callSid }, "failed to finalize CallLog on close"));
}

export function registerVoiceRelay(app: AnyFastifyInstance): void {
  app.get("/voice/relay", { websocket: true }, (socket: WebSocket) => {
    const state: RelayState = { silenceStrikes: 0, startedAt: Date.now() };

    socket.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "setup":
          void handleSetup(socket, state, msg);
          break;
        case "prompt":
          void handlePrompt(socket, state, msg);
          break;
        case "interrupt":
          handleInterrupt(state);
          break;
        case "error":
          handleError(socket, state, msg);
          break;
        default:
          break;
      }
    });

    socket.on("close", () => {
      void handleClose(state);
    });
  });
}
