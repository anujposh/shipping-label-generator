import assert from "node:assert/strict";
import test from "node:test";

const REQUIRED: Array<
  [string, keyof typeof import("../../src/config").config]
> = [
  ["DATABASE_URL", "databaseUrl"],
  ["SLG_INTERNAL_API_BASE_URL", "internalApiBaseUrl"],
  ["SLG_INTERNAL_API_KEY", "internalApiKey"],
  ["JWT_SECRET", "jwtSecret"],
];

function setValidEnv(): void {
  process.env.DATABASE_URL = "postgresql://localhost/db";
  process.env.SLG_INTERNAL_API_BASE_URL = "http://localhost:3000";
  process.env.SLG_INTERNAL_API_KEY = "x".repeat(32);
  process.env.JWT_SECRET = "y".repeat(32);
}

function clearSlgEnv(): void {
  for (const [name] of REQUIRED) {
    delete process.env[name];
  }
  delete process.env.NODE_ENV;
}

test("config fails fast when each required env var is missing", () => {
  // config is lazy (getters): importing must not throw, but first access
  // of a missing required var must fail fast.
  clearSlgEnv();

  for (const [name, prop] of REQUIRED) {
    setValidEnv();
    delete process.env[name];
    const { config } = require("../../src/config");
    assert.throws(
      () => {
        void config[prop];
      },
      new RegExp(`Missing required env var: ${name}`),
      `expected throw for missing ${name}`,
    );
  }
});

test("config uses defaults for optional vars", () => {
  clearSlgEnv();
  setValidEnv();
  delete process.env.API_PORT;
  delete process.env.APP_PORT;

  const { config } = require("../../src/config");
  assert.equal(config.apiPort, 3010);
  assert.equal(config.appPort, 3011);
});

test("production enforces secret lengths", () => {
  clearSlgEnv();
  process.env.SLG_INTERNAL_API_KEY = "short";
  process.env.JWT_SECRET = "y".repeat(32);
  process.env.NODE_ENV = "production";
  assert.throws(() => {
    delete require.cache[require.resolve("../../src/config")];
    require("../../src/config");
  }, /SLG_INTERNAL_API_KEY must be at least 32 characters/);
});
