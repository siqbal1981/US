import { describe, expect, it } from "vitest";
import { submitOrderSchema } from "../src/schema/order.js";

const baseItems = [{ menuItemId: "item-1", quantity: 1, modifierIds: [] }];

describe("submitOrderSchema — pickup/delivery (SPEC.md extension)", () => {
  it("defaults orderType to pickup when omitted", () => {
    const parsed = submitOrderSchema.parse({ items: baseItems, pickupName: "Alex" });
    expect(parsed.orderType).toBe("pickup");
  });

  it("accepts a pickup order without delivery fields", () => {
    const result = submitOrderSchema.safeParse({
      items: baseItems,
      orderType: "pickup",
      pickupName: "Alex",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a delivery order with no deliveryAddress", () => {
    const result = submitOrderSchema.safeParse({
      items: baseItems,
      orderType: "delivery",
      pickupName: "Alex",
      customerPhone: "555-123-4567",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("deliveryAddress"))).toBe(true);
    }
  });

  it("rejects a delivery order with no customerPhone", () => {
    const result = submitOrderSchema.safeParse({
      items: baseItems,
      orderType: "delivery",
      pickupName: "Alex",
      deliveryAddress: "123 Main St",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("customerPhone"))).toBe(true);
    }
  });

  it("accepts a fully-specified delivery order", () => {
    const result = submitOrderSchema.safeParse({
      items: baseItems,
      orderType: "delivery",
      pickupName: "Alex",
      customerPhone: "555-123-4567",
      deliveryAddress: "123 Main St",
      deliveryAptSuite: "Apt 4B",
      deliveryInstructions: "Gate code 1234",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown orderType value", () => {
    const result = submitOrderSchema.safeParse({
      items: baseItems,
      orderType: "dine-in",
      pickupName: "Alex",
    });
    expect(result.success).toBe(false);
  });
});
