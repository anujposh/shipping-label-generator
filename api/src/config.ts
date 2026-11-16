import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Lazy getters: importing config (e.g. transitively from store unit tests
// with fake-knex) must not throw; fail-fast happens on first real access
// at server startup.
export const config = {
  get nodeEnv() {
    return process.env.NODE_ENV || "development";
  },
  get logLevel() {
    return process.env.LOG_LEVEL || "info";
  },
  get databaseUrl() {
    return requireEnv("DATABASE_URL");
  },
  get testDatabaseUrl() {
    return process.env.TEST_DATABASE_URL;
  },
  get internalApiBaseUrl() {
    return requireEnv("SLG_INTERNAL_API_BASE_URL");
  },
  get internalApiKey() {
    return requireEnv("SLG_INTERNAL_API_KEY");
  },
  get jwtSecret() {
    return requireEnv("JWT_SECRET");
  },
  get apiPort() {
    return parseIntSafe(process.env.API_PORT, 3010);
  },
  get appPort() {
    return parseIntSafe(process.env.APP_PORT, 3011);
  },
  get redisHost() {
    return process.env.REDIS_HOST || "127.0.0.1";
  },
  get redisPort() {
    return parseIntSafe(process.env.REDIS_PORT, 6379);
  },
  get redisPassword() {
    return process.env.REDIS_PASSWORD;
  },
  get smtpHost() {
    return process.env.SMTP_HOST || "";
  },
  get smtpPort() {
    return parseIntSafe(process.env.SMTP_PORT, 587);
  },
  get smtpSecure() {
    return process.env.SMTP_SECURE === "true";
  },
  get smtpUser() {
    return process.env.SMTP_USER || "";
  },
  get smtpPassword() {
    return process.env.SMTP_PASSWORD || "";
  },
  get smtpFrom() {
    return process.env.SMTP_FROM || "";
  },
  // Business Central companies directory (admin link-creation company
  // dropdown). All optional/empty-string: unset means BC is unconfigured and
  // GET /admin/companies reports configured:false.
  get bcTenantId() {
    return process.env.BC_TENANT_ID || "";
  },
  get bcClientId() {
    return process.env.BC_CLIENT_ID || "";
  },
  get bcClientSecret() {
    return process.env.BC_CLIENT_SECRET || "";
  },
  get bcBaseUrl() {
    return (
      process.env.BC_BASE_URL || "https://api.businesscentral.dynamics.com/v2.0"
    );
  },
  get bcEnvironment() {
    return process.env.BC_ENVIRONMENT || "Sandbox";
  },
};

if (process.env.NODE_ENV === "production") {
  if (requireEnv("JWT_SECRET").length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }
  if (requireEnv("SLG_INTERNAL_API_KEY").length < 34) {
    throw new Error(
      "SLG_INTERNAL_API_KEY must be at least 32 characters in production",
    );
  }
}

function parseIntSafe(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}
