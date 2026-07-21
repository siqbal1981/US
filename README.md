# DSP Restaurant Agent

A multi-tenant AI restaurant order-taking system. A customer calls a
restaurant's phone number; Claude answers, takes the full pickup order,
makes one upsell, reads the order back, and — on an explicit yes —
submits it and texts the restaurant and the customer. One codebase serves
many restaurants; every table is tenant-scoped and cross-tenant joins are
blocked at the database level by compound foreign keys.

Scope (v1): pickup only, pay at pickup, English only, no POS integration
(order delivery = SMS), no dashboard (tenants onboarded via CLI), no
delivery/reservations/loyalty. See `SPEC.md` for the full specification.

## Stack

Node.js 20+, TypeScript (strict, ESM), Fastify + `@fastify/websocket`,
PostgreSQL via Prisma, Redis via ioredis, `@anthropic-ai/sdk`
(`claude-sonnet-4-6`), Zod, Vitest, pino, the Twilio SDK (SMS only — voice
is plain webhooks + a websocket, no SDK required).

## Local development

Prerequisites: Node 20+, a PostgreSQL database, and (optionally in dev) a
Redis server — without `REDIS_URL` the session store falls back to an
in-memory Map and per-tenant rate/concurrency limits are skipped.

```bash
cp .env.example .env
# fill in DATABASE_URL at minimum; ANTHROPIC_API_KEY to actually take orders

npm install
npx prisma migrate deploy   # or `npx prisma migrate dev` the first time
npm run seed                # seeds Tony's Pizza & Grill (25 items)

npm run dev                 # tsx watch src/server.ts
```

`GET /health` should report `{"ok":true,"db":true,"redis":true}` (or
`redis:true` even without Redis — the in-memory fallback always reports
healthy in dev).

### Tests and scripts

```bash
npm test               # vitest: matcher, pricing, hours unit tests
npm run score-table    # 15-phrase matcher eyeball table
npm run test:suite     # DSP 25-Order Test Suite against POST /chat
npm run test:live      # 10 live-API conversations (needs ANTHROPIC_API_KEY)
npm run add-tenant -- examples/casa-maria.json   # onboard a new tenant
npx tsx scripts/isolation-test.ts                # cross-tenant isolation proof
npx tsx scripts/concurrency-test.ts              # 5 parallel /chat sessions
npx tsx scripts/cost-report.ts                   # $/call from CallLog
```

`npm run test:suite`, `test:live`, `isolation-test.ts`, and
`concurrency-test.ts` all talk to a running server — start `npm run dev`
(or point `CHAT_URL`/target at a deployed instance) first.

## Deploying to Railway

1. Create a new Railway project; add the **Postgres** and **Redis**
   plugins.
2. Add this repo as a service. Railway will build it with the included
   `Dockerfile`; `railway.json` wires up the release phase
   (`npx prisma migrate deploy`), start command (`node dist/server.js`),
   and healthcheck (`/health`).
3. Set the service's environment variables (see `.env.example`):
   `DATABASE_URL` and `REDIS_URL` are provided by the plugins —
   reference them, don't hardcode. Set `ANTHROPIC_API_KEY`,
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_HOST` (the
   deployed hostname, no scheme, e.g. `dsp-agent.up.railway.app`), and
   `MODEL` (defaults to `claude-sonnet-4-6`).
4. Deploy. Confirm `https://{PUBLIC_HOST}/health` is green.
5. Seed the database: `railway run npm run seed` (or
   `railway run npm run add-tenant -- examples/your-tenant.json` for a
   real tenant).
6. In the **Twilio Console**, open the phone number you want to use and
   set its Voice webhook to `https://{PUBLIC_HOST}/voice/incoming`
   (HTTP POST). Set that tenant's `twilioNumber` (via the seed data or
   `add-tenant` JSON) to match, in E.164 format.
7. Place a real call to the Twilio number.

**Rule: the first real phone call happens against Railway, never a
tunnel.** A previous demo died on an ngrok 408 mid-call — Twilio's
`ConversationRelay` websocket needs a stable, low-latency public
endpoint, which a tunnel does not reliably provide.

### Launch checklist

- `/health` green on Railway
- A real call completes an order end-to-end
- Restaurant SMS and customer confirmation SMS both received
- An interruption (talking over the agent's TTS) is handled cleanly
- A silence timeout produces "Are you still there?" without cutting off
  mid-reply
- Hanging up and calling back within 15 minutes resumes the in-progress
  cart
- The 25-Order suite scores at least 23/25 against the deployed URL
