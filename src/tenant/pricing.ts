// THE pricing engine (SPEC.md §4.2). Money is integer cents, computed ONLY
// here. The LLM never sends, receives as authoritative, or computes a price.

export interface PriceMenuItem {
  id: string;
  tenantId: string;
  name: string;
  basePriceCents: number;
  available: boolean;
}

export interface PriceModifier {
  id: string;
  tenantId: string;
  menuItemId: string;
  name: string;
  priceDeltaCents: number;
}

export interface MenuMap {
  items: Map<string, PriceMenuItem>;
  modifiers: Map<string, PriceModifier>;
}

export interface OrderItemInput {
  menuItemId: string;
  quantity: number;
  modifierIds: string[];
  note?: string;
}

export interface PricedLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitCents: number;
  lineCents: number;
  modifiers: { id: string; name: string; priceDeltaCents: number }[];
  note?: string;
}

export interface PricedOrder {
  lines: PricedLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function priceOrder(items: OrderItemInput[], menuMap: MenuMap, taxRateBps: number): PricedOrder {
  const lines: PricedLine[] = [];
  let subtotalCents = 0;

  for (const orderItem of items) {
    const menuItem = menuMap.items.get(orderItem.menuItemId);
    if (!menuItem) {
      throw new Error(`Unknown menu item id: ${orderItem.menuItemId}`);
    }

    const resolvedModifiers = orderItem.modifierIds.map((modifierId) => {
      const modifier = menuMap.modifiers.get(modifierId);
      if (!modifier) {
        throw new Error(`Unknown modifier id: ${modifierId}`);
      }
      if (modifier.menuItemId !== menuItem.id || modifier.tenantId !== menuItem.tenantId) {
        throw new Error(`Modifier ${modifierId} does not belong to menu item ${menuItem.id}`);
      }
      return modifier;
    });

    const deltaSum = resolvedModifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0);
    const unitCents = menuItem.basePriceCents + deltaSum;
    if (unitCents < 0) {
      throw new Error(`Negative unit price for menu item ${menuItem.id}`);
    }

    const lineCents = unitCents * orderItem.quantity;
    subtotalCents += lineCents;

    lines.push({
      menuItemId: menuItem.id,
      name: menuItem.name,
      quantity: orderItem.quantity,
      unitCents,
      lineCents,
      modifiers: resolvedModifiers.map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
      note: orderItem.note,
    });
  }

  const taxCents = Math.round((subtotalCents * taxRateBps) / 10000);
  const totalCents = subtotalCents + taxCents;

  return { lines, subtotalCents, taxCents, totalCents };
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

function wordsForTwoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? TENS[tens] : `${TENS[tens]} ${ONES[ones]}`;
}

function wordsForNumber(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return wordsForTwoDigits(n);
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return rest === 0 ? `${ONES[hundreds]} hundred` : `${ONES[hundreds]} hundred ${wordsForTwoDigits(rest)}`;
  }
  // Restaurant orders don't reach four figures; fall back to plain digits.
  return String(n);
}

/** "twelve fifty" / "twelve dollars" — spoken price for voice replies. */
export function spokenPrice(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const remainder = Math.abs(cents) % 100;

  if (remainder === 0) {
    return `${wordsForNumber(dollars)} dollar${dollars === 1 ? "" : "s"}`;
  }

  const centsWords = remainder < 10 ? `oh ${ONES[remainder]}` : wordsForTwoDigits(remainder);
  return `${wordsForNumber(dollars)} ${centsWords}`;
}
