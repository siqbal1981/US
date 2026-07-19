import { describe, expect, it } from "vitest";
import { fmt, priceOrder, spokenPrice, type MenuMap } from "../src/tenant/pricing.js";

function buildMenuMap(): MenuMap {
  const items = new Map([
    ["item-pizza", { id: "item-pizza", tenantId: "t1", name: "Pepperoni Pizza", basePriceCents: 1200, available: true }],
    ["item-sub", { id: "item-sub", tenantId: "t1", name: "Italian Sub", basePriceCents: 900, available: true }],
    ["item-other-tenant", { id: "item-other-tenant", tenantId: "t2", name: "Casa Item", basePriceCents: 1000, available: true }],
  ]);
  const modifiers = new Map([
    ["mod-large", { id: "mod-large", tenantId: "t1", menuItemId: "item-pizza", name: "Large", priceDeltaCents: 500 }],
    ["mod-cheese", { id: "mod-cheese", tenantId: "t1", menuItemId: "item-pizza", name: "Extra Cheese", priceDeltaCents: 200 }],
    ["mod-mushroom", { id: "mod-mushroom", tenantId: "t1", menuItemId: "item-pizza", name: "Mushrooms", priceDeltaCents: 150 }],
    ["mod-toasted", { id: "mod-toasted", tenantId: "t1", menuItemId: "item-sub", name: "Toasted", priceDeltaCents: 0 }],
    ["mod-huge-discount", { id: "mod-huge-discount", tenantId: "t1", menuItemId: "item-sub", name: "Bogus", priceDeltaCents: -2000 }],
  ]);
  return { items, modifiers };
}

describe("priceOrder (SPEC.md §4.2)", () => {
  it("base price only, qty 1", () => {
    const result = priceOrder([{ menuItemId: "item-pizza", quantity: 1, modifierIds: [] }], buildMenuMap(), 825);
    expect(result.lines[0].unitCents).toBe(1200);
    expect(result.subtotalCents).toBe(1200);
  });

  it("applies a size delta", () => {
    const result = priceOrder(
      [{ menuItemId: "item-pizza", quantity: 1, modifierIds: ["mod-large"] }],
      buildMenuMap(),
      825,
    );
    expect(result.lines[0].unitCents).toBe(1700); // 1200 + 500
  });

  it("sums multiple topping deltas", () => {
    const result = priceOrder(
      [{ menuItemId: "item-pizza", quantity: 1, modifierIds: ["mod-large", "mod-cheese", "mod-mushroom"] }],
      buildMenuMap(),
      825,
    );
    expect(result.lines[0].unitCents).toBe(1200 + 500 + 200 + 150); // 2050
  });

  it("quantity multiplies unit price with modifiers applied", () => {
    const result = priceOrder(
      [{ menuItemId: "item-pizza", quantity: 3, modifierIds: ["mod-large"] }],
      buildMenuMap(),
      825,
    );
    expect(result.lines[0].unitCents).toBe(1700);
    expect(result.lines[0].lineCents).toBe(5100); // 1700 * 3
    expect(result.subtotalCents).toBe(5100);
  });

  it("multiple line items sum into one subtotal", () => {
    const result = priceOrder(
      [
        { menuItemId: "item-pizza", quantity: 1, modifierIds: [] },
        { menuItemId: "item-sub", quantity: 2, modifierIds: ["mod-toasted"] },
      ],
      buildMenuMap(),
      825,
    );
    expect(result.subtotalCents).toBe(1200 + 900 * 2);
  });

  it("tax rounds to nearest cent (edge: $10.01 @ 825bps)", () => {
    const menuMap: MenuMap = {
      items: new Map([["item-x", { id: "item-x", tenantId: "t1", name: "X", basePriceCents: 1001, available: true }]]),
      modifiers: new Map(),
    };
    const result = priceOrder([{ menuItemId: "item-x", quantity: 1, modifierIds: [] }], menuMap, 825);
    expect(result.subtotalCents).toBe(1001);
    // 1001 * 825 / 10000 = 82.5825 -> rounds to 83
    expect(result.taxCents).toBe(83);
    expect(result.totalCents).toBe(1084);
  });

  it("notes are never charged (half-toppings / no-X are text only)", () => {
    const result = priceOrder(
      [{ menuItemId: "item-pizza", quantity: 1, modifierIds: [], note: "no onions on half" }],
      buildMenuMap(),
      825,
    );
    expect(result.lines[0].unitCents).toBe(1200);
    expect(result.lines[0].note).toBe("no onions on half");
  });

  it("throws on unknown menu item id", () => {
    expect(() => priceOrder([{ menuItemId: "item-does-not-exist", quantity: 1, modifierIds: [] }], buildMenuMap(), 825)).toThrow();
  });

  it("throws on unknown modifier id", () => {
    expect(() =>
      priceOrder([{ menuItemId: "item-pizza", quantity: 1, modifierIds: ["mod-does-not-exist"] }], buildMenuMap(), 825),
    ).toThrow();
  });

  it("throws when a modifier belongs to a different item (cross-item rejection)", () => {
    expect(() =>
      priceOrder([{ menuItemId: "item-sub", quantity: 1, modifierIds: ["mod-large"] }], buildMenuMap(), 825),
    ).toThrow();
  });

  it("throws on negative unit price", () => {
    expect(() =>
      priceOrder([{ menuItemId: "item-sub", quantity: 1, modifierIds: ["mod-huge-discount"] }], buildMenuMap(), 825),
    ).toThrow();
  });

  it("fmt() and spokenPrice() format cents for display and voice", () => {
    expect(fmt(1250)).toBe("$12.50");
    expect(fmt(2000)).toBe("$20.00");
    expect(spokenPrice(1250)).toBe("twelve fifty");
    expect(spokenPrice(1200)).toBe("twelve dollars");
  });
});
