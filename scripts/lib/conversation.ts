// Shared adaptive conversation driver for scripts/live-tests.ts and
// scripts/test-suite.ts. A real Claude agent doesn't follow a rigid fixed
// turn count — it always makes exactly one upsell after the first item
// lands (per the prompt's STEPS) before asking for a pickup name and
// reading the order back. This drives a conversation to completion by
// reacting to what the assistant actually asks, instead of assuming a
// fixed script, and phrases the pickup name clearly ("put it under X")
// rather than as a bare word that risks being misheard as a menu item.
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export async function chat(targetUrl: string, sessionId: string, tenantSlug: string, message: string): Promise<ChatResponse> {
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, tenantSlug, message }),
  });
  if (!res.ok) {
    throw new Error(`chat request failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ChatResponse>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UPSELL_KEYWORDS = ["drink", "soda", "side", "fries", "garlic knots", "dessert", "cannoli", "wings", "add-on", "add on"];
const NAME_ASK_KEYWORDS = ["pickup name", "name for", "name should", "your name", "who should", "what name", "name is it"];
const CONFIRM_ASK_KEYWORDS = ["look good", "sound good", "does that", "all set", "correct?"];

export function looksLikeUpsellOffer(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("?") && UPSELL_KEYWORDS.some((kw) => lower.includes(kw));
}

function asksForName(lower: string): boolean {
  return NAME_ASK_KEYWORDS.some((kw) => lower.includes(kw));
}

function asksForConfirmation(lower: string): boolean {
  return CONFIRM_ASK_KEYWORDS.some((kw) => lower.includes(kw)) || (lower.includes("total") && lower.includes("$"));
}

export interface DriveOptions {
  targetUrl: string;
  tenantSlug: string;
  sessionId: string;
  /** Sent verbatim, in order, before the adaptive loop starts. */
  openingLines: string[];
  pickupName: string;
  /** Set true if openingLines already handled the upsell decision (accept or decline). */
  upsellAlreadyHandled?: boolean;
  maxAdaptiveTurns?: number;
  interTurnDelayMs?: number;
  /** Called after every turn; the loop stops early once this returns true. */
  isDone: () => Promise<boolean>;
}

export async function driveOrderConversation(opts: DriveOptions): Promise<Turn[]> {
  const delay = opts.interTurnDelayMs ?? 1100;
  const transcript: Turn[] = [];
  let nameSent = false;
  let upsellHandled = opts.upsellAlreadyHandled ?? false;
  let lastReply = "";

  async function send(line: string): Promise<void> {
    transcript.push({ role: "user", content: line });
    const res = await chat(opts.targetUrl, opts.sessionId, opts.tenantSlug, line);
    transcript.push({ role: "assistant", content: res.reply });
    lastReply = res.reply;
    await sleep(delay);
  }

  for (const line of opts.openingLines) {
    await send(line);
    if (await opts.isDone()) return transcript;
  }

  const maxTurns = opts.maxAdaptiveTurns ?? 6;
  for (let i = 0; i < maxTurns; i++) {
    if (await opts.isDone()) break;

    const lower = lastReply.toLowerCase();
    const parts: string[] = [];

    if (!upsellHandled && looksLikeUpsellOffer(lastReply)) {
      parts.push("No thanks, that's everything.");
      upsellHandled = true;
    }
    if (!nameSent && asksForName(lower)) {
      parts.push(`Put it under ${opts.pickupName}.`);
      nameSent = true;
    }
    if (asksForConfirmation(lower)) {
      parts.push("Yes, that's correct.");
    }
    if (parts.length === 0) {
      // Nothing recognized — supply the pickup name if not sent yet (most
      // common remaining gap), else a generic affirmative.
      if (!nameSent) {
        parts.push(`Put it under ${opts.pickupName}.`);
        nameSent = true;
      } else {
        parts.push("Yes.");
      }
    }

    await send(parts.join(" "));
  }

  return transcript;
}
