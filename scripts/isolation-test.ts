// Cross-tenant isolation proof (SPEC.md §9). Exercises the tool handlers
// directly against both tenants — the isolation guarantee lives in the
// per-tenant menu cache + pricing engine + compound FKs, not in the LLM.
import { prisma } from "../src/db/client.js";
import { loadMenu } from "../src/tenant/menu.js";
import { matchMenuItem } from "../src/agent/matcher.js";
import { executeTool, type ToolContext } from "../src/agent/tools.js";
import { newSession, saveSession, closeSessionStore } from "../src/session/store.js";

interface SubmitOrderResult {
  status: string;
  orderId?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  errors?: string[];
}

let failed = false;

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed = true;
}

async function main() {
  const tonys = await prisma.tenant.findUnique({ where: { slug: "tonys" } });
  const casaMaria = await prisma.tenant.findUnique({ where: { slug: "casa-maria" } });
  if (!tonys || !casaMaria) {
    console.error(
      "Missing tenant(s). Run `npm run seed` and `tsx scripts/add-tenant.ts examples/casa-maria.json` first.",
    );
    process.exit(1);
  }

  const tonysMenu = await loadMenu(tonys.id, { force: true });
  const casaMenu = await loadMenu(casaMaria.id, { force: true });

  console.log("=== Cross-tenant matcher isolation ===");
  const crossMatch = matchMenuItem("pepperoni pizza", casaMenu.matchableItems);
  console.log(`  Casa Maria menu searched for "pepperoni pizza": status=${crossMatch.status}`);
  check("Casa Maria's matcher never sees Tony's items (not a match)", crossMatch.status !== "match");

  console.log("\n=== Cross-tenant order attempt (Tony's menuItemId against Casa Maria's tenant) ===");
  const tonysPepperoni = tonysMenu.matchableItems.find((i) => i.name === "Pepperoni Pizza")!;
  const casaSessionId = `isolation-casa-${Date.now()}`;
  const casaSession = newSession(casaMaria.id);
  await saveSession(casaSessionId, casaSession);
  const casaCtx: ToolContext = { tenant: casaMaria, sessionId: casaSessionId, session: casaSession };

  const crossOrderResult = (await executeTool(
    "submit_order",
    { items: [{ menuItemId: tonysPepperoni.id, quantity: 1, modifierIds: [] }], pickupName: "Cross Tenant Attempt" },
    casaCtx,
  )) as SubmitOrderResult;
  console.log(`  submit_order result: ${JSON.stringify(crossOrderResult)}`);
  check("submit_order rejects another tenant's menuItemId", crossOrderResult.status === "invalid");

  console.log("\n=== Per-tenant tax rate proof ===");
  const tonysItem = tonysMenu.matchableItems.find((i) => i.name === "Cheese Pizza")!;
  const tonysSessionId = `isolation-tonys-${Date.now()}`;
  const tonysSession = newSession(tonys.id);
  await saveSession(tonysSessionId, tonysSession);
  const tonysCtx: ToolContext = { tenant: tonys, sessionId: tonysSessionId, session: tonysSession };
  const tonysOrder = (await executeTool(
    "submit_order",
    { items: [{ menuItemId: tonysItem.id, quantity: 1, modifierIds: [] }], pickupName: "Tony Test" },
    tonysCtx,
  )) as SubmitOrderResult;

  const casaItem = casaMenu.matchableItems.find((i) => i.name === "Carne Asada Taco")!;
  const casaSessionId2 = `isolation-casa2-${Date.now()}`;
  const casaSession2 = newSession(casaMaria.id);
  await saveSession(casaSessionId2, casaSession2);
  const casaCtx2: ToolContext = { tenant: casaMaria, sessionId: casaSessionId2, session: casaSession2 };
  const casaOrder = (await executeTool(
    "submit_order",
    { items: [{ menuItemId: casaItem.id, quantity: 1, modifierIds: [] }], pickupName: "Casa Test" },
    casaCtx2,
  )) as SubmitOrderResult;

  console.log(
    `  Tony's order: subtotal=${tonysOrder.subtotal} tax=${tonysOrder.tax} (rate ${tonys.taxRateBps}bps) total=${tonysOrder.total}`,
  );
  console.log(
    `  Casa Maria order: subtotal=${casaOrder.subtotal} tax=${casaOrder.tax} (rate ${casaMaria.taxRateBps}bps) total=${casaOrder.total}`,
  );

  const expectedTonysTax = Math.round(((tonysOrder.subtotal ?? 0) * tonys.taxRateBps) / 10000);
  const expectedCasaTax = Math.round(((casaOrder.subtotal ?? 0) * casaMaria.taxRateBps) / 10000);
  check("Tony's order taxed at Tony's own rate", tonysOrder.tax === expectedTonysTax);
  check("Casa Maria's order taxed at Casa Maria's own rate", casaOrder.tax === expectedCasaTax);
  check("the two tenants actually have different tax rates", tonys.taxRateBps !== casaMaria.taxRateBps);

  console.log("\n=== Proof queries ===");
  const menuCounts = await prisma.menuItem.groupBy({ by: ["tenantId"], _count: { _all: true } });
  for (const c of menuCounts) {
    const tenant = [tonys, casaMaria].find((t) => t.id === c.tenantId);
    console.log(`  MenuItem count for ${tenant?.slug ?? c.tenantId}: ${c._count._all}`);
  }

  const orderCounts = await prisma.order.groupBy({ by: ["tenantId"], _count: { _all: true } });
  for (const c of orderCounts) {
    const tenant = [tonys, casaMaria].find((t) => t.id === c.tenantId);
    console.log(`  Order count for ${tenant?.slug ?? c.tenantId}: ${c._count._all}`);
  }

  console.log("\n  Foreign-key constraint list (compound FK proof):");
  const fkRows = await prisma.$queryRaw<{ conname: string; relname: string }[]>`
    SELECT conname, conrelid::regclass::text AS relname
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    ORDER BY relname, conname;
  `;
  for (const row of fkRows) {
    console.log(`    ${row.relname}: ${row.conname}`);
  }

  // Clean up the orders this proof run created so it stays repeatable.
  const orderIds = [tonysOrder.orderId, casaOrder.orderId].filter((id): id is string => Boolean(id));
  if (orderIds.length > 0) {
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  console.log(`\n${failed ? "ISOLATION TEST: FAIL" : "ISOLATION TEST: ALL CHECKS PASSED"}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise((r) => setTimeout(r, 300)); // let fire-and-forget SMS logging settle
    await prisma.$disconnect();
    await closeSessionStore();
  });
