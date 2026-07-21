import pino from "pino";
import { config } from "./config.js";

export const logger = pino(
  config.isDev
    ? {
        level: "info",
        transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
      }
    : { level: "info" },
);
