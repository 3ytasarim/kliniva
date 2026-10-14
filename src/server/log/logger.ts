import "server-only";
import { sanitizeForLog } from "@/server/log/sanitize";

/**
 * Yapılandırılmış (JSON) logger. Her alan sanitizeForLog()'dan geçer — PHI/PII, parola, token, DATABASE_URL,
 * APP_ENCRYPTION_KEY, imza baytları, PDF içeriği log'a yazılamaz.
 *
 * Kural: hasta verisini log'a koymak için "kimlik" (ID) kullanın, içerik değil.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = (): number => LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

export type LogSink = (line: string, level: Level) => void;

let sink: LogSink = (line, level) => {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

/** Testler için: çıktıyı yakalamak üzere hedef değiştirilir. */
export function setLogSink(next: LogSink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

function write(level: Level, event: string, fields?: Fields) {
  if (LEVELS[level] < minLevel()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (sanitizeForLog(fields) as Fields) : {}),
  };
  sink(JSON.stringify(record), level);
}

export const logger = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
