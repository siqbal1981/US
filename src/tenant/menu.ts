// Menu loader + cache + prompt text builder (SPEC.md §5, §2).
import type { MenuItem, Modifier } from "@prisma/client";
import { prisma } from "../db/client.js";
import type { MatchableItem } from "../agent/matcher.js";
import type { MenuMap, PriceMenuItem, PriceModifier } from "./pricing.js";

export interface MenuData {
  tenantId: string;
  menuMap: MenuMap;
  matchableItems: MatchableItem[];
  itemsById: Map<string, MenuItem>;
  modifiersByItem: Map<string, Modifier[]>;
  promptText: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { data: MenuData; expiresAt: number }>();

export async function loadMenu(tenantId: string, opts: { force?: boolean } = {}): Promise<MenuData> {
  const cached = cache.get(tenantId);
  if (!opts.force && cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const [items, modifiers] = await Promise.all([
    prisma.menuItem.findMany({ where: { tenantId }, orderBy: { category: "asc" } }),
    prisma.modifier.findMany({ where: { tenantId } }),
  ]);

  const itemMap = new Map<string, PriceMenuItem>();
  const itemsById = new Map<string, MenuItem>();
  for (const item of items) {
    itemMap.set(item.id, {
      id: item.id,
      tenantId: item.tenantId,
      name: item.name,
      basePriceCents: item.basePriceCents,
      available: item.available,
    });
    itemsById.set(item.id, item);
  }

  const modifierMap = new Map<string, PriceModifier>();
  const modifiersByItem = new Map<string, Modifier[]>();
  for (const modifier of modifiers) {
    modifierMap.set(modifier.id, {
      id: modifier.id,
      tenantId: modifier.tenantId,
      menuItemId: modifier.menuItemId,
      name: modifier.name,
      priceDeltaCents: modifier.priceDeltaCents,
    });
    if (!modifiersByItem.has(modifier.menuItemId)) modifiersByItem.set(modifier.menuItemId, []);
    modifiersByItem.get(modifier.menuItemId)!.push(modifier);
  }

  const matchableItems: MatchableItem[] = items.map((i) => ({ id: i.id, name: i.name }));
  const promptText = buildPromptText(items, modifiersByItem);

  const data: MenuData = {
    tenantId,
    menuMap: { items: itemMap, modifiers: modifierMap },
    matchableItems,
    itemsById,
    modifiersByItem,
    promptText,
  };

  cache.set(tenantId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

export function invalidateMenuCache(tenantId: string): void {
  cache.delete(tenantId);
}

function buildPromptText(items: MenuItem[], modifiersByItem: Map<string, Modifier[]>): string {
  const byCategory = new Map<string, MenuItem[]>();
  for (const item of items) {
    if (!byCategory.has(item.category)) byCategory.set(item.category, []);
    byCategory.get(item.category)!.push(item);
  }

  const lines: string[] = [];
  for (const [category, catItems] of byCategory) {
    lines.push(`${category}:`);
    for (const item of catItems) {
      const mods = modifiersByItem.get(item.id) ?? [];
      const groups = new Map<string, string[]>();
      for (const m of mods) {
        if (!groups.has(m.group)) groups.set(m.group, []);
        groups.get(m.group)!.push(m.name);
      }
      const optionsText = Array.from(groups.entries())
        .map(([group, names]) => `${group}: ${names.join("/")}`)
        .join("; ");
      const flag = item.available ? "" : ` [86'd${item.altSuggestion ? ` — suggest ${item.altSuggestion} instead` : ""}]`;
      lines.push(`- ${item.name}${flag}${optionsText ? ` (${optionsText})` : ""}`);
    }
  }
  return lines.join("\n");
}
