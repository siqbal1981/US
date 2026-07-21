// Anthropic conversation loop (SPEC.md §5.4).
import Anthropic from "@anthropic-ai/sdk";
import type { Tenant } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db/client.js";
import { getOrCreateSession, saveSession } from "../session/store.js";
import { loadMenu } from "../tenant/menu.js";
import { isOpen } from "../tenant/hours.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "./tools.js";

const MAX_TOOL_ROUNDTRIPS = 5;
const RETRY_BACKOFFS_MS = [500, 2000];

const anthropic = config.hasAnthropic ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

export interface RunTurnOptions {
  voiceMode?: boolean;
}

export interface RunTurnResult {
  reply: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  toolsUsed: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: unknown): boolean {
  return status === 429 || status === 529;
}

const UPSELL_KEYWORDS = [
  "drink",
  "soda",
  "side",
  "fries",
  "garlic knots",
  "dessert",
  "cannoli",
  "wings",
  "add on",
  "add-on",
];

/** No dedicated tool marks an upsell as made — detect it from the reply text so the
 * prompt's "never again this call" rule (fed by session.upsellOffered) has something to key off. */
function looksLikeUpsellOffer(replyText: string): boolean {
  const lower = replyText.toLowerCase();
  const asksSomething = lower.includes("?");
  const mentionsUpsellItem = UPSELL_KEYWORDS.some((kw) => lower.includes(kw));
  return asksSomething && mentionsUpsellItem;
}

async function createMessageWithRetry(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      return await anthropic!.messages.create(params);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: unknown })?.status;
      if (!isRetryableStatus(status) || attempt === RETRY_BACKOFFS_MS.length) {
        throw err;
      }
      await sleep(RETRY_BACKOFFS_MS[attempt]);
    }
  }
  throw lastErr;
}

async function appendToCallLog(sessionId: string, userText: string, replyText: string, latencyMs: number, usage: { inputTokens: number; outputTokens: number }) {
  const callLog = await prisma.callLog.findUnique({ where: { callSid: sessionId } }).catch(() => null);
  if (!callLog) return;

  const transcript = Array.isArray(callLog.transcriptJson) ? (callLog.transcriptJson as unknown[]) : [];
  const turnsBefore = transcript.length / 2;
  transcript.push({ role: "user", content: userText }, { role: "assistant", content: replyText });
  const newAvgLatency = Math.round((callLog.latencyMsAvg * turnsBefore + latencyMs) / (turnsBefore + 1));

  await prisma.callLog.update({
    where: { callSid: sessionId },
    data: {
      transcriptJson: transcript as never,
      latencyMsAvg: newAvgLatency,
      inputTokens: { increment: usage.inputTokens },
      outputTokens: { increment: usage.outputTokens },
    },
  });
}

export async function runTurn(
  sessionId: string,
  tenant: Tenant,
  userText: string,
  options: RunTurnOptions = {},
): Promise<RunTurnResult> {
  const start = Date.now();
  const session = await getOrCreateSession(sessionId, tenant.id);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolsUsed: string[] = [];
  let replyText: string;

  if (!anthropic) {
    replyText = "Sorry, I'm having trouble taking orders right now — let me get someone to call you back.";
    session.escalated = true;
    session.history.push({ role: "user", content: userText }, { role: "assistant", content: replyText });
    await saveSession(sessionId, session);
    const latencyMs = Date.now() - start;
    await appendToCallLog(sessionId, userText, replyText, latencyMs, usage);
    return { reply: replyText, latencyMs, usage, toolsUsed };
  }

  const menu = await loadMenu(tenant.id);
  const open = isOpen(tenant);

  const systemPrompt = buildSystemPrompt(tenant, menu, {
    orderSubmitted: session.orderSubmitted,
    orderId: session.orderId,
    orderTotalCents: session.orderTotalCents,
    upsellOffered: session.upsellOffered,
    isOpen: open,
    voiceMode: options.voiceMode ?? false,
  });

  const messages: Anthropic.MessageParam[] = session.history.map((m) => ({ role: m.role, content: m.content }));
  messages.push({ role: "user", content: userText });

  const ctx: ToolContext = { tenant, sessionId, session };

  let roundTrips = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let response: Anthropic.Message;
    try {
      response = await createMessageWithRetry({
        model: config.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOL_DEFINITIONS,
        messages,
      });
    } catch {
      session.escalated = true;
      replyText = "Sorry — I'm having trouble right now. Let me connect you with someone who can help.";
      await prisma.callLog
        .update({ where: { callSid: sessionId }, data: { outcome: "escalated" } })
        .catch(() => undefined);
      break;
    }

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");

    if (toolUseBlocks.length === 0 || roundTrips >= MAX_TOOL_ROUNDTRIPS) {
      replyText = textBlocks.map((b) => b.text).join(" ").trim() || "Got it.";
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      toolsUsed.push(block.name);
      const result = await executeTool(block.name, block.input, ctx);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
    roundTrips += 1;
  }

  if (!session.upsellOffered && looksLikeUpsellOffer(replyText)) {
    session.upsellOffered = true;
  }

  session.history.push({ role: "user", content: userText }, { role: "assistant", content: replyText });
  await saveSession(sessionId, session);

  const latencyMs = Date.now() - start;
  await appendToCallLog(sessionId, userText, replyText, latencyMs, usage);

  return { reply: replyText, latencyMs, usage, toolsUsed };
}
