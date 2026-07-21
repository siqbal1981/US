import { describe, expect, it } from "vitest";
import { isOpen } from "../src/tenant/hours.js";

describe("isOpen (SPEC.md §4.3)", () => {
  it("normal daytime window: open inside range, closed outside (UTC)", () => {
    const tenant = { timezone: "UTC", openHour: 11, closeHour: 22 };
    expect(isOpen(tenant, new Date("2026-01-15T15:00:00Z"))).toBe(true);
    expect(isOpen(tenant, new Date("2026-01-15T23:00:00Z"))).toBe(false);
    expect(isOpen(tenant, new Date("2026-01-15T05:00:00Z"))).toBe(false);
  });

  it("overnight window (close < open) wraps past midnight", () => {
    const tenant = { timezone: "UTC", openHour: 22, closeHour: 2 };
    expect(isOpen(tenant, new Date("2026-01-15T23:00:00Z"))).toBe(true); // 11pm
    expect(isOpen(tenant, new Date("2026-01-16T01:00:00Z"))).toBe(true); // 1am
    expect(isOpen(tenant, new Date("2026-01-15T12:00:00Z"))).toBe(false); // noon
  });

  it("boundary hours: open at openHour, closed at closeHour", () => {
    const tenant = { timezone: "UTC", openHour: 11, closeHour: 22 };
    expect(isOpen(tenant, new Date("2026-01-15T11:00:00Z"))).toBe(true);
    expect(isOpen(tenant, new Date("2026-01-15T22:00:00Z"))).toBe(false);
  });

  it("uses tenant timezone, not server/UTC time", () => {
    // January => America/New_York is EST (UTC-5), no DST ambiguity.
    const tenant = { timezone: "America/New_York", openHour: 11, closeHour: 22 };
    // 15:00 UTC = 10:00 EST -> before opening
    expect(isOpen(tenant, new Date("2026-01-15T15:00:00Z"))).toBe(false);
    // 16:00 UTC = 11:00 EST -> open
    expect(isOpen(tenant, new Date("2026-01-15T16:00:00Z"))).toBe(true);
  });
});
