// CLI tenant onboarding from JSON (SPEC.md §9): tsx scripts/add-tenant.ts <file.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { prisma } from "../src/db/client.js";

const modifierSchema = z.object({
  group: z.string(),
  name: z.string(),
  priceDeltaCents: z.number().int(),
});

const menuItemSchema = z.object({
  name: z.string(),
  category: z.string(),
  basePriceCents: z.number().int().nonnegative(),
  available: z.boolean().optional(),
  altSuggestion: z.string().optional(),
  modifiers: z.array(modifierSchema).default([]),
});

const tenantFileSchema = z.object({
  slug: z.string(),
  name: z.string(),
  twilioNumber: z.string(),
  taxRateBps: z.number().int().optional(),
  timezone: z.string().optional(),
  openHour: z.number().int().optional(),
  closeHour: z.number().int().optional(),
  fallbackSmsNumber: z.string().optional(),
  upsellRule: z.string().optional(),
  greeting: z.string().optional(),
  menu: z.array(menuItemSchema),
});

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: tsx scripts/add-tenant.ts <tenant.json>");
    process.exit(1);
  }

  const path = resolve(process.cwd(), fileArg);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const data = tenantFileSchema.parse(raw);

  const tenant = await prisma.tenant.upsert({
    where: { slug: data.slug },
    update: {
      name: data.name,
      twilioNumber: data.twilioNumber,
      taxRateBps: data.taxRateBps ?? 825,
      timezone: data.timezone ?? "America/New_York",
      openHour: data.openHour ?? 11,
      closeHour: data.closeHour ?? 22,
      fallbackSmsNumber: data.fallbackSmsNumber,
      upsellRule: data.upsellRule,
      greeting: data.greeting,
    },
    create: {
      slug: data.slug,
      name: data.name,
      twilioNumber: data.twilioNumber,
      taxRateBps: data.taxRateBps ?? 825,
      timezone: data.timezone ?? "America/New_York",
      openHour: data.openHour ?? 11,
      closeHour: data.closeHour ?? 22,
      fallbackSmsNumber: data.fallbackSmsNumber,
      upsellRule: data.upsellRule,
      greeting: data.greeting,
    },
  });

  await prisma.modifier.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.menuItem.deleteMany({ where: { tenantId: tenant.id } });

  for (const item of data.menu) {
    const created = await prisma.menuItem.create({
      data: {
        tenantId: tenant.id,
        name: item.name,
        category: item.category,
        basePriceCents: item.basePriceCents,
        available: item.available ?? true,
        altSuggestion: item.altSuggestion,
      },
    });
    if (item.modifiers.length > 0) {
      await prisma.modifier.createMany({
        data: item.modifiers.map((m) => ({
          tenantId: tenant.id,
          menuItemId: created.id,
          group: m.group,
          name: m.name,
          priceDeltaCents: m.priceDeltaCents,
        })),
      });
    }
  }

  console.log(`Tenant "${tenant.name}" (${tenant.slug}) created/updated with ${data.menu.length} items.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
