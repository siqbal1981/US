// Avg tokens + estimated $ per completed call from CallLog (SPEC.md §9).
// Ship bar: < $0.35/call.
import { prisma } from "../src/db/client.js";

// Claude Sonnet pricing (per million tokens).
const INPUT_COST_PER_MTOK = 3.0;
const OUTPUT_COST_PER_MTOK = 15.0;
const COST_BAR_PER_CALL = 0.35;

async function main() {
  const completedCalls = await prisma.callLog.findMany({ where: { outcome: "completed" } });

  if (completedCalls.length === 0) {
    console.log("No completed calls in CallLog yet — nothing to report.");
    console.log("(Run scripts/test-suite.ts or make some real/simulated calls first.)");
    return;
  }

  const totalInput = completedCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutput = completedCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalLatency = completedCalls.reduce((s, c) => s + c.latencyMsAvg, 0);
  const n = completedCalls.length;

  const avgInputTokens = totalInput / n;
  const avgOutputTokens = totalOutput / n;
  const avgLatencyMs = totalLatency / n;

  const avgCostPerCall = (avgInputTokens / 1_000_000) * INPUT_COST_PER_MTOK + (avgOutputTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;

  console.log(`Completed calls analyzed: ${n}`);
  console.log(`Avg input tokens/call:  ${avgInputTokens.toFixed(1)}`);
  console.log(`Avg output tokens/call: ${avgOutputTokens.toFixed(1)}`);
  console.log(`Avg latency/turn (ms):  ${avgLatencyMs.toFixed(0)}`);
  console.log(`Estimated avg cost/call: $${avgCostPerCall.toFixed(4)}`);
  console.log(`Ship bar (< $${COST_BAR_PER_CALL.toFixed(2)}/call): ${avgCostPerCall < COST_BAR_PER_CALL ? "PASS" : "FAIL"}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
