// Redis session store (SPEC.md §5.1), key session:{id}, TTL 900s, JSON.
// Falls back to an in-memory Map when REDIS_URL is unset (dev only —
// NOT multi-instance safe, a warning is logged once at startup).
import { Redis } from "ioredis";
import { config } from "../config.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CartLine {
  menuItemId: string;
  name: string;
  quantity: number;
  modifierIds: string[];
  note?: string;
}

export interface Session {
  tenantId: string;
  history: SessionMessage[]; // capped to last 30
  cart: CartLine[];
  orderSubmitted: boolean; // GUARD LAYER 1 feeds prompt
  orderId?: string;
  orderTotalCents?: number;
  orderType?: "pickup" | "delivery";
  upsellOffered: boolean;
  escalated: boolean;
  startedAt: number;
}

const TTL_SECONDS = 900;
const MAX_HISTORY = 30;

const redis: Redis | null = config.hasRedis ? new Redis(config.redisUrl as string, { maxRetriesPerRequest: 2 }) : null;

if (!redis) {
  // eslint-disable-next-line no-console
  console.warn(
    "[session] REDIS_URL not set — using in-memory session store (dev only, not multi-instance safe)",
  );
}

interface MemEntry {
  value: string;
  expiresAt: number;
}
const memStore = new Map<string, MemEntry>();

function memGet(key: string): string | null {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlSeconds: number): void {
  memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function memDel(key: string): void {
  memStore.delete(key);
}

async function rawGet(key: string): Promise<string | null> {
  if (redis) return redis.get(key);
  return memGet(key);
}

async function rawSet(key: string, value: string, ttlSeconds = TTL_SECONDS): Promise<void> {
  if (redis) {
    await redis.set(key, value, "EX", ttlSeconds);
    return;
  }
  memSet(key, value, ttlSeconds);
}

async function rawDel(key: string): Promise<void> {
  if (redis) {
    await redis.del(key);
    return;
  }
  memDel(key);
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function resumeKey(tenantId: string, callerNumber: string): string {
  return `resume:${tenantId}:${callerNumber}`;
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const raw = await rawGet(sessionKey(sessionId));
  if (!raw) return null;
  return JSON.parse(raw) as Session;
}

export function newSession(tenantId: string): Session {
  return {
    tenantId,
    history: [],
    cart: [],
    orderSubmitted: false,
    upsellOffered: false,
    escalated: false,
    startedAt: Date.now(),
  };
}

export async function getOrCreateSession(sessionId: string, tenantId: string): Promise<Session> {
  const existing = await getSession(sessionId);
  if (existing) return existing;
  const fresh = newSession(tenantId);
  await saveSession(sessionId, fresh);
  return fresh;
}

export async function saveSession(sessionId: string, session: Session): Promise<void> {
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  await rawSet(sessionKey(sessionId), JSON.stringify(session));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await rawDel(sessionKey(sessionId));
}

export async function setResumeSession(tenantId: string, callerNumber: string, sessionId: string): Promise<void> {
  await rawSet(resumeKey(tenantId, callerNumber), sessionId, TTL_SECONDS);
}

export async function getResumeSessionId(tenantId: string, callerNumber: string): Promise<string | null> {
  return rawGet(resumeKey(tenantId, callerNumber));
}

export async function pingSessionStore(): Promise<boolean> {
  if (!redis) return true; // in-memory fallback is always "up"
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/** Exposed for per-tenant rate/concurrency counters in server.ts. Null in dev fallback. */
export function getRedisClient(): Redis | null {
  return redis;
}

export async function closeSessionStore(): Promise<void> {
  if (redis) await redis.quit();
}
