// 5 parallel /chat sessions, asserting zero history cross-talk (SPEC.md §9).
import { getSession, closeSessionStore } from "../src/session/store.js";

const TARGET_URL = process.env.CHAT_URL ?? "http://127.0.0.1:3000/chat";
const TENANT_SLUG = process.env.TENANT_SLUG ?? "tonys";

interface ChatResponse {
  reply: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

async function chat(sessionId: string, message: string): Promise<ChatResponse> {
  const res = await fetch(TARGET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, tenantSlug: TENANT_SLUG, message }),
  });
  if (!res.ok) {
    throw new Error(`chat request failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<ChatResponse>;
}

async function runSession(index: number): Promise<{ sessionId: string; replies: string[] }> {
  const sessionId = `concurrency-${Date.now()}-${index}`;
  const utterance = `session ${index}: I'd like item number ${index}`;
  const replies: string[] = [];
  const r1 = await chat(sessionId, utterance);
  replies.push(r1.reply);
  const r2 = await chat(sessionId, "what did I just say?");
  replies.push(r2.reply);
  return { sessionId, replies };
}

async function main() {
  console.log(`Running 5 concurrent /chat sessions against ${TARGET_URL} ...`);

  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => runSession(i)));

  const sessionIds = results.map((r) => r.sessionId);
  const distinct = new Set(sessionIds);
  const distinctOk = distinct.size === 5;
  console.log(`Distinct sessions: ${distinct.size}/5 — ${distinctOk ? "PASS" : "FAIL"}`);

  let crossTalk = false;
  for (let i = 0; i < results.length; i++) {
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      const a = results[i].replies.join(" ").toLowerCase();
      const otherSessionMarker = `session ${j}:`;
      if (a.includes(otherSessionMarker)) {
        console.error(`FAIL: session ${i}'s replies mention session ${j}'s utterance — cross-talk detected.`);
        crossTalk = true;
      }
    }
  }
  console.log(`Cross-talk check: ${crossTalk ? "FAIL" : "PASS"}`);

  results.forEach((r, i) => {
    console.log(`\nsession ${i} (${r.sessionId}):`);
    r.replies.forEach((reply, turn) => console.log(`  turn ${turn}: ${reply}`));
  });

  // Stronger, LLM-independent check: read each session's persisted Redis
  // history directly and confirm it only ever contains its own utterances.
  console.log("\nDirect Redis session history check:");
  let historyCrossTalk = false;
  for (let i = 0; i < results.length; i++) {
    const session = await getSession(results[i].sessionId);
    const historyText = (session?.history ?? []).map((m) => m.content).join(" ").toLowerCase();
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      if (historyText.includes(`session ${j}:`)) {
        console.error(`FAIL: session ${i}'s persisted history contains session ${j}'s utterance.`);
        historyCrossTalk = true;
      }
    }
    const ownMarkerPresent = historyText.includes(`session ${i}:`);
    console.log(`  session ${i}: own utterance present=${ownMarkerPresent}, history turns=${session?.history.length ?? 0}`);
  }
  console.log(`Direct history cross-talk check: ${historyCrossTalk ? "FAIL" : "PASS"}`);

  const ok = distinctOk && !crossTalk && !historyCrossTalk;
  console.log(`\n${ok ? "CONCURRENCY TEST: PASS" : "CONCURRENCY TEST: FAIL"}`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSessionStore();
  });
