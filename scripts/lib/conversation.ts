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
const CONFIRM_ASK_KEYWORDS = ["look good", "sound good", "does that", "all set", "correct?", "right?", "confirm"];
const PHONE_ASK_KEYWORDS = ["phone number", "callback number", "phone #", "digits", "different one", "this number"];
const FAKE_PHONE_NUMBER = "555-123-4567";

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

function asksForPhone(lower: string): boolean {
  return PHONE_ASK_KEYWORDS.some((kw) => lower.includes(kw));
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
  /**
   * The prompt now asks pickup-vs-delivery as the very first thing after the
   * greeting, before taking any items. Defaults to "pickup" so every
   * existing pickup-only test case keeps working without modification; an
   * explicit opening turn establishes it before openingLines are sent.
   */
  orderType?: "pickup" | "delivery";
  maxAdaptiveTurns?: number;
  interTurnDelayMs?: number;
  /** Called after every turn; the loop stops early once this returns true. */
  isDone: () => Promise<boolean>;
}

export async function driveOrderConversation(opts: DriveOptions): Promise<Turn[]> {
  const delay = opts.interTurnDelayMs ?? 1100;
  const transcript: Turn[] = [];
  let nameSent = false;
  let phoneSent = false;
  let upsellHandled = opts.upsellAlreadyHandled ?? false;
  let lastReply = "";
  let confirmAttempts = 0;

  async function send(line: string): Promise<void> {
    transcript.push({ role: "user", content: line });
    const res = await chat(opts.targetUrl, opts.sessionId, opts.tenantSlug, line);
    transcript.push({ role: "assistant", content: res.reply });
    lastReply = res.reply;
    await sleep(delay);
  }

  function nextReplyFor(lower: string): string {
    const parts: string[] = [];

    if (!upsellHandled && looksLikeUpsellOffer(lastReply)) {
      parts.push("No thanks, that's everything.");
      upsellHandled = true;
    }
    if (!nameSent && asksForName(lower)) {
      parts.push(`Put it under ${opts.pickupName}.`);
      nameSent = true;
    }
    if (!phoneSent && asksForPhone(lower)) {
      parts.push(`You can use ${FAKE_PHONE_NUMBER}.`);
      phoneSent = true;
    }
    if (asksForConfirmation(lower)) {
      confirmAttempts += 1;
      // A real caller gets more insistent after being asked to re-confirm
      // an already-answered read-back more than once.
      parts.push(
        confirmAttempts >= 2
          ? "Yes! Everything is correct — please submit the order right now."
          : "Yes, that's correct — please go ahead and place the order.",
      );
    }
    if (parts.length === 0) {
      // Nothing recognized — supply whatever's still missing, else a generic affirmative.
      if (!nameSent) {
        parts.push(`Put it under ${opts.pickupName}.`);
        nameSent = true;
      } else if (!phoneSent) {
        parts.push(`You can use ${FAKE_PHONE_NUMBER}.`);
        phoneSent = true;
      } else {
        parts.push("Yes.");
      }
    }
    return parts.join(" ");
  }

  const orderType = opts.orderType ?? "pickup";
  await send(orderType === "delivery" ? "This will be delivery." : "This is a pickup order.");
  if (await opts.isDone()) return transcript;

  for (const line of opts.openingLines) {
    await send(line);
    if (await opts.isDone()) return transcript;
  }

  const maxTurns = opts.maxAdaptiveTurns ?? 10;
  for (let i = 0; i < maxTurns; i++) {
    if (await opts.isDone()) break;
    await send(nextReplyFor(lastReply.toLowerCase()));
  }

  // Guaranteed last resort: if the final reply is clearly a read-back asking
  // for confirmation but the loop budget ran out before we answered it,
  // send one more explicit "yes" rather than silently failing the case.
  if (!(await opts.isDone()) && asksForConfirmation(lastReply.toLowerCase())) {
    await send("Yes! Everything is correct — please submit the order right now.");
  }

  return transcript;
}
