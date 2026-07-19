import { describe, expect, it } from "vitest";
import { matchMenuItem, type MatchableItem } from "../src/agent/matcher.js";

const MENU: MatchableItem[] = [
  { id: "pepperoni", name: "Pepperoni Pizza" },
  { id: "margherita", name: "Margherita Pizza" },
  { id: "meatlovers", name: "Meat Lovers Pizza" },
  { id: "veggie-pizza", name: "Veggie Pizza" },
  { id: "bbq-chicken-pizza", name: "BBQ Chicken Pizza" },
  { id: "hawaiian", name: "Hawaiian Pizza" },
  { id: "cheese-pizza", name: "Cheese Pizza" },
  { id: "buffalo-chicken-pizza", name: "Buffalo Chicken Pizza" },
  { id: "italian-sub", name: "Italian Sub" },
  { id: "meatball-sub", name: "Meatball Sub" },
  { id: "chicken-parm-sub", name: "Chicken Parm Sub" },
  { id: "philly-sub", name: "Philly Cheesesteak Sub" },
  { id: "veggie-sub", name: "Veggie Sub" },
  { id: "caesar-salad", name: "Caesar Salad" },
  { id: "garden-salad", name: "Garden Salad" },
  { id: "greek-salad", name: "Greek Salad" },
  { id: "garlic-knots", name: "Garlic Knots" },
  { id: "mozz-sticks", name: "Mozzarella Sticks" },
  { id: "fries", name: "French Fries" },
  { id: "wings", name: "Chicken Wings 10pc" },
  { id: "soda", name: "Fountain Soda" },
  { id: "water", name: "Bottled Water" },
  { id: "iced-tea", name: "Iced Tea" },
  { id: "cannoli", name: "Cannoli" },
  { id: "tiramisu", name: "Tiramisu" },
];

describe("matchMenuItem — hard acceptance tests (SPEC.md §4.1)", () => {
  it('"pepperoni pizza" scores >= 95 and matches', () => {
    const r = matchMenuItem("pepperoni pizza", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("pepperoni");
    expect(r.item!.score).toBeGreaterThanOrEqual(95);
  });

  it('"large pepperoni pizza" scores >= 90 with detectedSize=large', () => {
    const r = matchMenuItem("large pepperoni pizza", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("pepperoni");
    expect(r.item!.score).toBeGreaterThanOrEqual(90);
    expect(r.detectedSize).toBe("large");
  });

  it('"peproni pizza" (typo) scores >= 80', () => {
    const r = matchMenuItem("peproni pizza", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("pepperoni");
    expect(r.item!.score).toBeGreaterThanOrEqual(80);
  });

  it('"a large peperoni pie please" matches Pepperoni Pizza, size large', () => {
    const r = matchMenuItem("a large peperoni pie please", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("pepperoni");
    expect(r.detectedSize).toBe("large");
  });

  it('"meat lovers" scores >= 85', () => {
    const r = matchMenuItem("meat lovers", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("meatlovers");
    expect(r.item!.score).toBeGreaterThanOrEqual(85);
  });

  it('"no onions large veggie pizza" matches Veggie Pizza with negations=[onions], size=large', () => {
    const r = matchMenuItem("no onions large veggie pizza", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("veggie-pizza");
    expect(r.detectedNegations).toEqual(["onions"]);
    expect(r.detectedSize).toBe("large");
  });

  it('"pizza" alone is NOT a single confident match', () => {
    const r = matchMenuItem("pizza", MENU);
    expect(["ambiguous", "candidates"]).toContain(r.status);
  });

  it('"chicken parm" matches Chicken Parm Sub with score >= 70', () => {
    const r = matchMenuItem("chicken parm", MENU);
    expect(r.status).toBe("match");
    expect(r.item?.id).toBe("chicken-parm-sub");
    expect(r.item!.score).toBeGreaterThanOrEqual(70);
  });

  it.each(["sushi", "pad thai", "big mac"])('"%s" is not_found (score < 45)', (phrase) => {
    const r = matchMenuItem(phrase, MENU);
    expect(r.status).toBe("not_found");
  });
});
