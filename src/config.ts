import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  PUBLIC_HOST: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  MODEL: z.string().default("claude-sonnet-4-6"),
  NODE_ENV: z.string().default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const config = {
  databaseUrl: parsed.data.DATABASE_URL,
  redisUrl: parsed.data.REDIS_URL,
  anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
  twilioAccountSid: parsed.data.TWILIO_ACCOUNT_SID,
  twilioAuthToken: parsed.data.TWILIO_AUTH_TOKEN,
  publicHost: parsed.data.PUBLIC_HOST,
  port: parsed.data.PORT,
  model: parsed.data.MODEL,
  isDev: parsed.data.NODE_ENV !== "production",
  hasTwilio: Boolean(parsed.data.TWILIO_ACCOUNT_SID && parsed.data.TWILIO_AUTH_TOKEN),
  hasRedis: Boolean(parsed.data.REDIS_URL),
  hasAnthropic: Boolean(parsed.data.ANTHROPIC_API_KEY),
};
