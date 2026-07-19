// Matcher eyeball table (SPEC.md §4.4): 15 phrases x top-3 items with scores + decision.
import { prisma } from "../src/db/client.js";
import { matchMenuItem, scoreAllItems, type MatchableItem } from "../src/agent/matcher.js";

const PHRASES: { label: string; phrase: string }[] = [
  { label: "exact", phrase: "pepperoni pizza" },
  { label: "exact", phrase: "chicken parm sub" },
  { label: "near-exact", phrase: "meat lovers" },
  { label: "near-exact", phrase: "buffalo chicken pizza" },
  { label: "typo", phrase: "peproni pizza" },
  { label: "typo", phrase: "marherita pizza" },
  { label: "typo", phrase: "moxarella sticks" },
  { label: "slang", phrase: "large peproni za" },
  { label: "slang", phrase: "chicken hoagie" },
  { label: "slang", phrase: "gimme a pop" },
  { label: "partial", phrase: "pizza" },
  { label: "partial", phrase: "sub" },
  { label: "off-menu", phrase: "sushi" },
  { label: "off-menu", phrase: "pad thai" },
  { label: "off-menu", phrase: "big mac" },
];

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: "tonys" } });
  if (!tenant) {
    console.error('Tenant "tonys" not found — run `npm run seed` first.');
    process.exit(1);
  }

  const menuItems = await prisma.menuItem.findMany({ where: { tenantId: tenant.id } });
  const items: MatchableItem[] = menuItems.map((m) => ({ id: m.id, name: m.name }));

  const rows: string[] = [];
  rows.push(
    `${"category".padEnd(10)} ${"phrase".padEnd(28)} ${"decision".padEnd(11)} top-3 (item: score)`,
  );
  rows.push("-".repeat(100));

  for (const { label, phrase } of PHRASES) {
    const { scored } = scoreAllItems(phrase, items);
    const decision = matchMenuItem(phrase, items).status;
    const top3 = scored
      .slice(0, 3)
      .map((c) => `${c.name}: ${c.score}`)
      .join(" | ");
    rows.push(`${label.padEnd(10)} ${phrase.padEnd(28)} ${decision.padEnd(11)} ${top3}`);
  }

  console.log(rows.join("\n"));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
