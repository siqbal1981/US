// Fastify app + routes (SPEC.md §6).
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db/client.js";
import { pingSessionStore, getRedisClient, closeSessionStore } from "./session/store.js";
import { runTurn } from "./agent/brain.js";
import { buildConnectRelayTwiml, buildRejectTwiml } from "./voice/twiml.js";
import { registerVoiceRelay } from "./voice/relay.js";

const CONCURRENCY_LIMIT = 20;
const RATE_LIMIT_PER_MIN = 60;
const SESSION_TTL_SECONDS = 900;

const app = Fastify({ loggerInstance: logger });

await app.register(websocketPlugin);

// ---- rate / concurrency limiting (Redis counters; skipped in dev fallback) ----

async function checkTenantLimits(tenantId: string): Promise<{ ok: boolean; reason?: string }> {
  const redis = getRedisClient();
  if (!redis) return { ok: true }; // dev fallback: skip limits

  const now = Date.now();
  const concurrencyKey = `concurrency:${tenantId}`;
  await redis.zremrangebyscore(concurrencyKey, 0, now);
  const activeCount = await redis.zcard(concurrencyKey);
  if (activeCount >= CONCURRENCY_LIMIT) {
    return { ok: false, reason: "too many concurrent sessions for this restaurant, please try again shortly" };
  }

  const minuteBucket = Math.floor(now / 60000);
  const rateKey = `ratelimit:${tenantId}:${minuteBucket}`;
  const count = await redis.incr(rateKey);
  if (count === 1) await redis.expire(rateKey, 60);
  if (count > RATE_LIMIT_PER_MIN) {
    return { ok: false, reason: "too many requests right now, please try again in a moment" };
  }

  return { ok: true };
}

async function markSessionActive(tenantId: string, sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.zadd(`concurrency:${tenantId}`, Date.now() + SESSION_TTL_SECONDS * 1000, sessionId);
}

// ---- routes ----

app.get("/health", async (_req, reply) => {
  const [dbOk, redisOk] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false),
    pingSessionStore(),
  ]);
  const ok = dbOk && redisOk;
  reply.code(ok ? 200 : 503).send({ ok, db: dbOk, redis: redisOk });
});

interface ChatBody {
  sessionId: string;
  tenantSlug: string;
  message: string;
}

app.post<{ Body: ChatBody }>("/chat", async (req, reply) => {
  const { sessionId, tenantSlug, message } = req.body ?? ({} as ChatBody);

  if (!sessionId || !tenantSlug || !message) {
    return reply.code(400).send({ error: "sessionId, tenantSlug, and message are required" });
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    return reply.code(404).send({ error: `Unknown tenant: ${tenantSlug}` });
  }

  const limit = await checkTenantLimits(tenant.id);
  if (!limit.ok) {
    return reply.code(429).send({ error: limit.reason });
  }
  await markSessionActive(tenant.id, sessionId);

  const result = await runTurn(sessionId, tenant, message, { voiceMode: false });

  req.log.info(
    {
      sessionId,
      tenantId: tenant.id,
      tools: result.toolsUsed,
      latencyMs: result.latencyMs,
      inTok: result.usage.inputTokens,
      outTok: result.usage.outputTokens,
    },
    "agent turn",
  );

  return reply.send({ reply: result.reply, latencyMs: result.latencyMs, usage: result.usage });
});

app.post("/voice/incoming", async (req, reply) => {
  const body = req.body as Record<string, string> | undefined;
  const to = body?.To ?? "";
  const from = body?.From ?? "";
  const callSid = body?.CallSid ?? "";

  const tenant = await prisma.tenant.findUnique({ where: { twilioNumber: to } });

  if (!tenant) {
    req.log.warn({ to }, "voice/incoming: unknown tenant number");
    reply.type("text/xml").send(buildRejectTwiml("Sorry, this number is not in service. Goodbye."));
    return;
  }

  await prisma.callLog.create({
    data: { tenantId: tenant.id, callSid, callerNumber: from || null },
  });

  const publicHost = config.publicHost ?? req.headers.host ?? "localhost";
  reply.type("text/xml").send(buildConnectRelayTwiml(publicHost, tenant.greeting));
});

registerVoiceRelay(app);

// ---- content type parsing for Twilio's form-encoded webhooks ----
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  try {
    const params = new URLSearchParams(body as string);
    const parsed: Record<string, string> = {};
    for (const [key, value] of params) parsed[key] = value;
    done(null, parsed);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// ---- graceful shutdown ----

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  try {
    await app.close();
    await prisma.$disconnect();
    await closeSessionStore();
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main(): Promise<void> {
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  logger.error({ err }, "failed to start server");
  process.exit(1);
});

export { app };
