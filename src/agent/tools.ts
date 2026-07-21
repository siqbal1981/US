// Exactly three tools (SPEC.md §5.2). The agent never emits order JSON as
// text — this is the only surface it uses to touch menu data and the DB.
import type Anthropic from "@anthropic-ai/sdk";
import { Prisma, type Tenant } from "@prisma/client";
import { prisma } from "../db/client.js";
import { matchMenuItem } from "./matcher.js";
import { loadMenu } from "../tenant/menu.js";
import { priceOrder, type PricedLine } from "../tenant/pricing.js";
import { isOpen } from "../tenant/hours.js";
import { submitOrderSchema } from "../schema/order.js";
import { saveSession, type Session } from "../session/store.js";
import { sendOrderSms } from "../sms.js";
import { logger } from "../logger.js";

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "check_menu_item",
    description:
      "Look up a menu item the caller mentioned, by name or description. Call this for EVERY item the caller mentions before adding it to the order — never guess an item's id or price.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What the caller said, verbatim or close to it, e.g. 'large pepperoni pizza no onions'",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "submit_order",
    description:
      "Submit the finalized pickup order. Only call this after reading the full order and total back to the caller and receiving an explicit yes.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              menuItemId: { type: "string", description: "id returned by check_menu_item" },
              quantity: { type: "integer", minimum: 1, maximum: 20 },
              modifierIds: { type: "array", items: { type: "string" } },
              note: { type: "string", description: "free text like 'no onions on half' — never priced" },
            },
            required: ["menuItemId", "quantity", "modifierIds"],
          },
        },
        pickupName: { type: "string" },
        customerPhone: { type: "string", description: "only if different from caller ID" },
      },
      required: ["items", "pickupName"],
    },
  },
  {
    name: "escalate",
    description:
      "Hand off to a human. Use for complaints, refunds, catering, allergy questions you can't answer, two failures on the same item, or an explicit request for a person.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        stage: { type: "string", enum: ["pre_order", "mid_order"] },
      },
      required: ["reason", "stage"],
    },
  },
];

export interface ToolContext {
  tenant: Tenant;
  sessionId: string;
  session: Session;
}

async function handleCheckMenuItem(ctx: ToolContext, input: { query: string }) {
  const menu = await loadMenu(ctx.tenant.id);
  const result = matchMenuItem(input.query, menu.matchableItems);

  if (result.status === "match") {
    const item = menu.itemsById.get(result.item!.id)!;

    if (!item.available) {
      return {
        status: "out_of_stock",
        item: { menuItemId: item.id, name: item.name },
        suggest: item.altSuggestion ?? null,
      };
    }

    const mods = menu.modifiersByItem.get(item.id) ?? [];
    return {
      status: "match",
      item: {
        menuItemId: item.id,
        name: item.name,
        basePrice: item.basePriceCents,
        modifiers: mods.map((m) => ({ modifierId: m.id, name: m.name, delta: m.priceDeltaCents })),
      },
      detectedSize: result.detectedSize,
      detectedNegations: result.detectedNegations,
      instruction: "apply detectedSize if it matches a size modifier; add negations as a note",
    };
  }

  if (result.status === "ambiguous" || result.status === "candidates") {
    return {
      status: "clarify",
      candidates: (result.candidates ?? []).map((c) => c.name),
      instruction: "ask which one — do not guess",
    };
  }

  return { status: "not_found", instruction: "say we don't have it; mention closest category" };
}

const ALREADY_SUBMITTED_INSTRUCTION =
  "it's already in — briefly confirm, give pickup time, do NOT re-confirm or apologize at length";

async function handleSubmitOrder(ctx: ToolContext, rawInput: unknown) {
  // GUARD LAYER 2
  if (ctx.session.orderSubmitted) {
    return {
      status: "already_submitted",
      orderId: ctx.session.orderId,
      total: ctx.session.orderTotalCents,
      instruction: ALREADY_SUBMITTED_INSTRUCTION,
    };
  }

  const parsed = submitOrderSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: "invalid", errors: parsed.error.issues.map((i) => i.message) };
  }

  const menu = await loadMenu(ctx.tenant.id);

  for (const line of parsed.data.items) {
    const item = menu.itemsById.get(line.menuItemId);
    if (!item) {
      return { status: "invalid", errors: [`Unknown menu item id: ${line.menuItemId}`] };
    }
    if (!item.available) {
      return { status: "invalid", errors: [`${item.name} is currently unavailable`] };
    }
  }

  let priced: { lines: PricedLine[]; subtotalCents: number; taxCents: number; totalCents: number };
  try {
    priced = priceOrder(parsed.data.items, menu.menuMap, ctx.tenant.taxRateBps);
  } catch (err) {
    return { status: "invalid", errors: [(err as Error).message] };
  }

  const open = isOpen(ctx.tenant);

  try {
    const order = await prisma.order.create({
      data: {
        tenantId: ctx.tenant.id,
        callSid: ctx.sessionId,
        itemsJson: priced.lines as unknown as Prisma.InputJsonValue,
        subtotalCents: priced.subtotalCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        customerPhone: parsed.data.customerPhone,
        pickupName: parsed.data.pickupName,
        pickupEtaMinutes: 20,
        scheduledForReopen: !open,
      },
    });

    ctx.session.orderSubmitted = true;
    ctx.session.orderId = order.id;
    ctx.session.orderTotalCents = order.totalCents;
    // save session BEFORE returning so the guard survives a crash right after submit
    await saveSession(ctx.sessionId, ctx.session);

    sendOrderSms({ tenant: ctx.tenant, order, lines: priced.lines }).catch((err) => {
      logger.error({ err, orderId: order.id }, "order SMS failed");
    });

    return {
      status: "submitted",
      orderId: order.id,
      subtotal: priced.subtotalCents,
      tax: priced.taxCents,
      total: priced.totalCents,
      pickupEtaMinutes: 20,
      scheduledForReopen: !open,
      instruction: "thank by name, state total + ~20 min pickup, wrap up; NEVER ask to place the order again",
    };
  } catch (err) {
    // GUARD LAYER 3 — unique(tenantId, callSid) caught a race/duplicate submit
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.order.findUnique({
        where: { tenantId_callSid: { tenantId: ctx.tenant.id, callSid: ctx.sessionId } },
      });
      if (existing) {
        ctx.session.orderSubmitted = true;
        ctx.session.orderId = existing.id;
        ctx.session.orderTotalCents = existing.totalCents;
        await saveSession(ctx.sessionId, ctx.session);
      }
      return {
        status: "already_submitted",
        orderId: existing?.id,
        total: existing?.totalCents,
        instruction: ALREADY_SUBMITTED_INSTRUCTION,
      };
    }
    throw err;
  }
}

async function handleEscalate(ctx: ToolContext, input: { reason: string; stage: "pre_order" | "mid_order" }) {
  ctx.session.escalated = true;
  await saveSession(ctx.sessionId, ctx.session);

  await prisma.callLog
    .update({ where: { callSid: ctx.sessionId }, data: { outcome: "escalated" } })
    .catch(() => undefined);

  const instruction =
    input.stage === "mid_order"
      ? "your order so far is saved, someone will pick up / call back shortly"
      : "connecting you now";

  return { status: "escalated", stage: input.stage, instruction };
}

export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "check_menu_item":
      return handleCheckMenuItem(ctx, input as { query: string });
    case "submit_order":
      return handleSubmitOrder(ctx, input);
    case "escalate":
      return handleEscalate(ctx, input as { reason: string; stage: "pre_order" | "mid_order" });
    default:
      return { status: "error", message: `Unknown tool: ${name}` };
  }
}
