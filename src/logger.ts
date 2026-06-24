type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configuredLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const activeLevel: LogLevel =
  configuredLevel === "debug" ||
  configuredLevel === "info" ||
  configuredLevel === "warn" ||
  configuredLevel === "error"
    ? configuredLevel
    : "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[activeLevel];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }

  return ` ${JSON.stringify(meta)}`;
}

function write(level: LogLevel, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) {
    return;
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${formatMeta(meta)}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (scope: string, message: string, meta?: Record<string, unknown>) =>
    write("debug", scope, message, meta),
  info: (scope: string, message: string, meta?: Record<string, unknown>) =>
    write("info", scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) =>
    write("warn", scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) =>
    write("error", scope, message, meta),
};

