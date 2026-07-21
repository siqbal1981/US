export interface TenantHours {
  timezone: string;
  openHour: number;
  closeHour: number;
}

export function localHour(timezone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  return hourPart ? Number(hourPart.value) : now.getHours();
}

/** Open iff openHour <= local hour < closeHour. Overnight windows (close < open) wrap past midnight. */
export function isOpen(tenant: TenantHours, now: Date = new Date()): boolean {
  const h = localHour(tenant.timezone, now);
  const { openHour, closeHour } = tenant;

  if (openHour === closeHour) return true; // 24-hour operation
  if (openHour < closeHour) {
    return h >= openHour && h < closeHour;
  }
  // overnight window, e.g. open 22, close 2
  return h >= openHour || h < closeHour;
}
