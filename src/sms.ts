// Order SMS — replaces POS for v1 (SPEC.md §8). Fire-and-forget from the
// caller's perspective: failures are logged, never thrown back into the call.
import twilio from "twilio";
import type { Order, Tenant } from "@prisma/client";
import { config } from "./config.js";
import { prisma } from "./db/client.js";
import { fmt } from "./tenant/pricing.js";
import type { PricedLine } from "./tenant/pricing.js";
import { logger } from "./logger.js";

const client = config.hasTwilio ? twilio(config.twilioAccountSid, config.twilioAuthToken) : null;

function shortId(orderId: string): string {
  return orderId.slice(-6).toUpperCase();
}

function lineText(line: PricedLine): string {
  const extras = [...line.modifiers.map((m) => m.name), ...(line.note ? [line.note] : [])];
  const extraText = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `${line.quantity}x ${line.name}${extraText}`;
}

function buildRestaurantMessage(order: Order, lines: PricedLine[]): string {
  const header = `🍕 NEW PICKUP ORDER #${shortId(order.id)} — ${order.pickupName ?? "Guest"}`;
  const body = lines.map(lineText).join("\n");
  const totals = `Subtotal ${fmt(order.subtotalCents)}  Tax ${fmt(order.taxCents)}  TOTAL ${fmt(order.totalCents)}`;
  const footer = order.scheduledForReopen
    ? "⏰ SCHEDULED FOR REOPEN\nPickup ~20 min after reopen. Pay at pickup."
    : "Pickup ~20 min. Pay at pickup.";
  return [header, body, totals, footer].join("\n");
}

function buildCustomerMessage(tenant: Tenant, order: Order): string {
  return `${tenant.name}: order confirmed, total ${fmt(order.totalCents)}, ready in ~20 min. Order #${shortId(order.id)}.`;
}

async function sendWithRetry(params: { to: string; from: string; body: string }, context: { orderId: string; kind: string }): Promise<void> {
  if (!client) {
    logger.info({ orderId: context.orderId, kind: context.kind, to: params.to }, "SMS skipped (Twilio creds unset, dev mode)");
    return;
  }
  try {
    await client.messages.create(params);
  } catch (err) {
    try {
      await client.messages.create(params);
    } catch (err2) {
      logger.error({ err: err2, orderId: context.orderId, kind: context.kind }, "order SMS failed after retry");
    }
  }
}

export interface SendOrderSmsInput {
  tenant: Tenant;
  order: Order;
  lines: PricedLine[];
}

export async function sendOrderSms({ tenant, order, lines }: SendOrderSmsInput): Promise<void> {
  const from = tenant.twilioNumber;

  if (tenant.fallbackSmsNumber) {
    await sendWithRetry(
      { to: tenant.fallbackSmsNumber, from, body: buildRestaurantMessage(order, lines) },
      { orderId: order.id, kind: "restaurant" },
    );
  } else {
    logger.info({ orderId: order.id }, "no fallbackSmsNumber configured — restaurant SMS skipped");
  }

  let customerPhone = order.customerPhone ?? null;
  if (!customerPhone && order.callSid) {
    const callLog = await prisma.callLog.findUnique({ where: { callSid: order.callSid } }).catch(() => null);
    customerPhone = callLog?.callerNumber ?? null;
  }

  if (customerPhone) {
    await sendWithRetry(
      { to: customerPhone, from, body: buildCustomerMessage(tenant, order) },
      { orderId: order.id, kind: "customer" },
    );
  } else {
    logger.info({ orderId: order.id }, "no customer phone available — confirmation SMS skipped");
  }
}
