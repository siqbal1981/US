// Zod order input schema (SPEC.md §5.2). Deliberately has NO price fields —
// the LLM can never send, and the server never trusts, a price or total.
import { z } from "zod";

export const orderItemSchema = z.object({
  menuItemId: z.string().min(1),
  quantity: z.number().int().min(1).max(20),
  modifierIds: z.array(z.string()).default([]),
  note: z.string().max(200).optional(),
});

export const submitOrderSchema = z
  .object({
    items: z.array(orderItemSchema).min(1).max(25),
    orderType: z.enum(["pickup", "delivery"]).default("pickup"),
    pickupName: z.string().min(1),
    customerPhone: z.string().optional(),
    deliveryAddress: z.string().min(1).max(200).optional(),
    deliveryAptSuite: z.string().max(50).optional(),
    deliveryInstructions: z.string().max(300).optional(),
  })
  .refine((v) => v.orderType !== "delivery" || Boolean(v.deliveryAddress), {
    message: "deliveryAddress is required when orderType is delivery",
    path: ["deliveryAddress"],
  })
  .refine((v) => v.orderType !== "delivery" || Boolean(v.customerPhone), {
    message: "customerPhone is required when orderType is delivery",
    path: ["customerPhone"],
  });

export type OrderItemInput = z.infer<typeof orderItemSchema>;
export type SubmitOrderInput = z.infer<typeof submitOrderSchema>;
