type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLogLevel(): LogLevel {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  return value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
    ? value
    : "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLogLevel()];
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!shouldLog(level)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export function errorDetails(error: unknown): Record<string, unknown> {
  const value = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    stack?: unknown;
  };
  return {
    errorName: value.name ?? null,
    errorCode: value.code ?? null,
    errorMessage: value.message ?? String(error),
    errorStack: value.stack ?? null,
  };
}
