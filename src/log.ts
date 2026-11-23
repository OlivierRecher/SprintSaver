import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import { paths } from "./config/paths.js";

function build(): pino.Logger {
  const level = process.env.SPRINTSAVER_LOG_LEVEL ?? "info";
  if (process.env.VITEST) return pino({ level: "silent" });
  const file = paths.log();
  mkdirSync(dirname(file), { recursive: true });
  return pino(
    { level },
    pino.multistream([
      { level: level as pino.Level, stream: pino.transport({ target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } }) },
      { level: level as pino.Level, stream: pino.destination({ dest: file, mkdir: true, sync: true }) },
    ]),
  );
}

export const log = build();
