import { prisma } from "./client.js";

interface ModifierSeed {
  group: string;
  name: string;
  priceDeltaCents: number;
}

interface MenuItemSeed {
  name: string;
  category: string;
  basePriceCents: number;
  available?: boolean;
  altSuggestion?: string;
  modifiers: ModifierSeed[];
}

const PIZZA_SIZES: ModifierSeed[] = [
  { group: "size", name: "Small", priceDeltaCents: 0 },
  { group: "size", name: "Medium", priceDeltaCents: 300 },
  { group: "size", name: "Large", priceDeltaCents: 500 },
];

const PIZZA_TOPPINGS: ModifierSeed[] = [
  { group: "topping", name: "Extra Cheese", priceDeltaCents: 200 },
  { group: "topping", name: "Mushrooms", priceDeltaCents: 150 },
  { group: "topping", name: "Onions", priceDeltaCents: 150 },
  { group: "topping", name: "Sausage", priceDeltaCents: 200 },
  { group: "topping", name: "Jalapeños", priceDeltaCents: 150 },
];

const SUB_OPTIONS: ModifierSeed[] = [
  { group: "option", name: "Toasted", priceDeltaCents: 0 },
  { group: "option", name: "Extra Meat", priceDeltaCents: 300 },
];

const SALAD_OPTIONS: ModifierSeed[] = [
  { group: "option", name: "Add Chicken", priceDeltaCents: 400 },
];

const WING_SAUCE_OPTIONS: ModifierSeed[] = [
  { group: "option", name: "Buffalo", priceDeltaCents: 0 },
  { group: "option", name: "BBQ", priceDeltaCents: 0 },
  { group: "option", name: "Plain", priceDeltaCents: 0 },
];

const SODA_OPTIONS: ModifierSeed[] = [
  { group: "option", name: "Coke", priceDeltaCents: 0 },
  { group: "option", name: "Sprite", priceDeltaCents: 0 },
  { group: "option", name: "Root Beer", priceDeltaCents: 0 },
];

const TONYS_MENU: MenuItemSeed[] = [
  // PIZZAS (8)
  { name: "Pepperoni Pizza", category: "Pizzas", basePriceCents: 1299, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  { name: "Margherita Pizza", category: "Pizzas", basePriceCents: 1199, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  { name: "Meat Lovers Pizza", category: "Pizzas", basePriceCents: 1599, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  { name: "Veggie Pizza", category: "Pizzas", basePriceCents: 1249, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  { name: "BBQ Chicken Pizza", category: "Pizzas", basePriceCents: 1499, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  {
    name: "Hawaiian Pizza",
    category: "Pizzas",
    basePriceCents: 1349,
    available: false,
    altSuggestion: "BBQ Chicken Pizza",
    modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS],
  },
  { name: "Cheese Pizza", category: "Pizzas", basePriceCents: 1199, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },
  { name: "Buffalo Chicken Pizza", category: "Pizzas", basePriceCents: 1549, modifiers: [...PIZZA_SIZES, ...PIZZA_TOPPINGS] },

  // SUBS (5)
  { name: "Italian Sub", category: "Subs", basePriceCents: 999, modifiers: [...SUB_OPTIONS] },
  { name: "Meatball Sub", category: "Subs", basePriceCents: 1099, modifiers: [...SUB_OPTIONS] },
  { name: "Chicken Parm Sub", category: "Subs", basePriceCents: 1199, modifiers: [...SUB_OPTIONS] },
  { name: "Philly Cheesesteak Sub", category: "Subs", basePriceCents: 1299, modifiers: [...SUB_OPTIONS] },
  { name: "Veggie Sub", category: "Subs", basePriceCents: 999, modifiers: [...SUB_OPTIONS] },

  // SALADS (3)
  { name: "Caesar Salad", category: "Salads", basePriceCents: 799, modifiers: [...SALAD_OPTIONS] },
  { name: "Garden Salad", category: "Salads", basePriceCents: 699, modifiers: [...SALAD_OPTIONS] },
  { name: "Greek Salad", category: "Salads", basePriceCents: 849, modifiers: [...SALAD_OPTIONS] },

  // SIDES (4)
  { name: "Garlic Knots", category: "Sides", basePriceCents: 599, modifiers: [] },
  { name: "Mozzarella Sticks", category: "Sides", basePriceCents: 799, modifiers: [] },
  { name: "French Fries", category: "Sides", basePriceCents: 499, modifiers: [] },
  { name: "Chicken Wings 10pc", category: "Sides", basePriceCents: 1299, modifiers: [...WING_SAUCE_OPTIONS] },

  // DRINKS (3)
  { name: "Fountain Soda", category: "Drinks", basePriceCents: 249, modifiers: [...SODA_OPTIONS] },
  { name: "Bottled Water", category: "Drinks", basePriceCents: 199, modifiers: [] },
  { name: "Iced Tea", category: "Drinks", basePriceCents: 299, modifiers: [] },

  // DESSERTS (2)
  { name: "Cannoli", category: "Desserts", basePriceCents: 499, modifiers: [] },
  {
    name: "Tiramisu",
    category: "Desserts",
    basePriceCents: 699,
    available: false,
    altSuggestion: "Cannoli",
    modifiers: [],
  },
];

async function seedTenantMenu(tenantId: string, menu: MenuItemSeed[]) {
  await prisma.modifier.deleteMany({ where: { tenantId } });
  await prisma.menuItem.deleteMany({ where: { tenantId } });

  for (const item of menu) {
    const created = await prisma.menuItem.create({
      data: {
        tenantId,
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
          tenantId,
          menuItemId: created.id,
          group: m.group,
          name: m.name,
          priceDeltaCents: m.priceDeltaCents,
        })),
      });
    }
  }
}

async function main() {
  const tonys = await prisma.tenant.upsert({
    where: { slug: "tonys" },
    update: {},
    create: {
      slug: "tonys",
      name: "Tony's Pizza & Grill",
      twilioNumber: "+14632923334",
      taxRateBps: 825,
      timezone: "America/New_York",
      openHour: 11,
      closeHour: 22,
      payAtPickup: true,
      fallbackSmsNumber: "+15555550101",
      upsellRule: "Offer one drink or side, once per call, never repeat if declined.",
      greeting: "Thanks for calling Tony's Pizza & Grill! What can I get started for you?",
    },
  });

  await seedTenantMenu(tonys.id, TONYS_MENU);

  const itemCount = await prisma.menuItem.count({ where: { tenantId: tonys.id } });
  const outOfStockCount = await prisma.menuItem.count({ where: { tenantId: tonys.id, available: false } });

  // eslint-disable-next-line no-console
  console.log(`Seeded tenant "${tonys.name}" (${tonys.slug}): ${itemCount} items, ${outOfStockCount} 86'd.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
