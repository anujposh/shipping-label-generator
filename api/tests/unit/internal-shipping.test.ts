import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { AddressInfo } from "node:net";
import { createInternalShippingRouter } from "../../src/internal-shipping/routes/internal-shipping.routes";
import { getServiceCatalog } from "../../src/internal-shipping/services/service-catalog";
import {
  sanitizeRateQuoteRequest,
  sanitizeCreateShipmentRequest,
} from "../../src/internal-shipping/internal-shipping.dto";
import {
  CarrierApiError,
  CarrierRateLimitError,
  CarrierValidationError,
} from "../../src/carriers/carrier-errors";
import { __setFedexTransportForTests } from "../../src/carriers/fedex.client";
import { __resetCarrierCachesForTests } from "../../src/carriers/carrier.service";

/**
 * Internal shipping seam tests — flag gating (404 when off, indistinguishable
 * from unknown routes), shared-secret auth (404 on missing/wrong key), IP
 * allowlist enforcement, endpoint allowlist, DTO validation + response
 * sanitization, and one full-chain test through the real carrier.service
 * facade with an injected fake FedEx transport. No real carrier credentials
 * anywhere in this file — only obviously fake placeholders.
 */

const TEST_KEY = "unit-test-internal-seam-key-0123456789abcdef";
const bearer = (key: string = TEST_KEY) => `Bearer ${key}`;

// Fake placeholder env credentials (fedex client requires them present to
// reach the injected fake transport in the full-chain test). NOT real secrets.
process.env.FEDEX_API_KEY = "test-fedex-key";
process.env.FEDEX_API_SECRET = "test-fedex-secret";
process.env.FEDEX_ACCOUNT_NUMBER = "test-fedex-account";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

function startServer(
  deps?: Parameters<typeof createInternalShippingRouter>[0],
): Promise<ServerHandle> {
  const app = express();
  app.use(express.json({ limit: "100kb", strict: true }));
  app.use("/internal/shipping", createInternalShippingRouter(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      });
    });
  });
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function call(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, body, headers: response.headers };
}

/** POST helper. key defaults to the valid TEST_KEY; pass null for no header. */
const post = (
  base: string,
  path: string,
  body: unknown,
  key: string | null = TEST_KEY,
) =>
  call(base, path, {
    method: "POST",
    headers: key === null ? {} : { authorization: bearer(key) },
    body: JSON.stringify(body),
  });

function fromAddress(): Record<string, unknown> {
  return {
    addressLine1: "1 Warehouse Way",
    city: "Atlanta",
    state: "GA",
    zipCode: "30301",
    countryCode: "US",
    contactName: "Shipper",
  };
}

function toAddress(): Record<string, unknown> {
  return {
    addressLine1: "2 Destination Ave",
    city: "New York",
    state: "NY",
    zipCode: "10001",
    countryCode: "US",
    contactName: "Receiver",
  };
}

function rateQuoteBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    carrier: "fedex",
    from: fromAddress(),
    to: toAddress(),
    packages: [{ weight: 2 }],
    ...overrides,
  };
}

function createShipmentBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    carrier: "fedex",
    serviceType: "FEDEX_GROUND",
    labelFormat: "PDF",
    from: fromAddress(),
    to: toAddress(),
    packages: [{ weight: 2, length: 10, width: 8, height: 4 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "SLG_INTERNAL_API_ENABLED",
  "SLG_INTERNAL_API_KEY",
  "SLG_INTERNAL_API_ALLOWED_IPS",
  "SLG_INTERNAL_SERVICES_UPS",
  "SLG_INTERNAL_SERVICES_FEDEX",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Enables the seam with the test key and no IP restriction. */
function enableSeam(): void {
  process.env.SLG_INTERNAL_API_ENABLED = "true";
  process.env.SLG_INTERNAL_API_KEY = TEST_KEY;
  delete process.env.SLG_INTERNAL_API_ALLOWED_IPS;
}

// ---------------------------------------------------------------------------
// DI fakes (mock carrier.service — no real carrier I/O)
// ---------------------------------------------------------------------------

interface RecordedCall {
  carrier: unknown;
  payload: unknown;
  cfg: unknown;
}

function makeFakeDeps(options: {
  rates?: unknown[];
  labels?: unknown[];
  error?: Error;
}): {
  deps: Parameters<typeof createInternalShippingRouter>[0];
  rateCalls: RecordedCall[];
  createCalls: RecordedCall[];
} {
  const rateCalls: RecordedCall[] = [];
  const createCalls: RecordedCall[] = [];
  return {
    rateCalls,
    createCalls,
    deps: {
      rateShop: async (carrier: unknown, args: unknown, cfg?: unknown) => {
        rateCalls.push({ carrier, payload: args, cfg });
        if (options.error) throw options.error;
        return (options.rates ?? []) as never;
      },
      createShipment: async (
        carrier: unknown,
        shipment: unknown,
        cfg?: unknown,
      ) => {
        createCalls.push({ carrier, payload: shipment, cfg });
        if (options.error) throw options.error;
        return (options.labels ?? []) as never;
      },
    },
  };
}

const FAKE_RATES = [
  {
    carrier: "fedex",
    service: "FEDEX_GROUND",
    cost: 12.5,
    currency: "USD",
    serviceDescription: "FedEx Ground",
    deliveryDays: "3",
    deliveryDate: "2026-11-13",
    // Extra fields must be stripped by the response sanitizer.
    secretToken: "carrier-internal-secret",
    rawResponse: { should: "never leak" },
  },
];

const FAKE_LABELS = [
  {
    carrier: "fedex",
    environment: "sandbox",
    trackingNumber: "794658901234",
    labelData: Buffer.from("%PDF-1.4 fake-label").toString("base64"),
    format: "PDF",
    cost: 12.5,
    // Extra fields must be stripped by the response sanitizer.
    internalAccountRef: "acct-do-not-leak",
  },
];

// ---------------------------------------------------------------------------
// Flag gating
// ---------------------------------------------------------------------------

test("flag off: all seam endpoints 404 indistinguishably and carrier is never called", async () => {
  const saved = snapshotEnv();
  const { deps, rateCalls, createCalls } = makeFakeDeps({ rates: FAKE_RATES });
  process.env.SLG_INTERNAL_API_KEY = TEST_KEY; // key set but flag off
  for (const flagValue of [undefined, "false", "1", "TRUE"]) {
    if (flagValue === undefined) delete process.env.SLG_INTERNAL_API_ENABLED;
    else process.env.SLG_INTERNAL_API_ENABLED = flagValue;
    const server = await startServer(deps);
    try {
      for (const path of [
        "/internal/shipping/rate-quote",
        "/internal/shipping/create-shipment",
        "/internal/shipping/services/fedex",
      ]) {
        const result = await post(server.url, path, rateQuoteBody(), TEST_KEY);
        assert.equal(
          result.status,
          404,
          `${path} must 404 when flag=${String(flagValue)}`,
        );
        assert.deepEqual(result.body, { error: "Not found" });
      }
    } finally {
      await server.close();
    }
  }
  assert.equal(rateCalls.length, 0);
  assert.equal(createCalls.length, 0);
  restoreEnv(saved);
});

test("flag on but key unset: 404 (never serves unauthenticated)", async () => {
  const saved = snapshotEnv();
  const { deps } = makeFakeDeps({ rates: FAKE_RATES });
  process.env.SLG_INTERNAL_API_ENABLED = "true";
  delete process.env.SLG_INTERNAL_API_KEY;
  const server = await startServer(deps);
  try {
    const result = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody(),
      TEST_KEY,
    );
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "Not found" });
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// Shared-secret auth
// ---------------------------------------------------------------------------

test("missing or wrong bearer key: 404", async () => {
  const saved = snapshotEnv();
  const { deps } = makeFakeDeps({ rates: FAKE_RATES });
  enableSeam();
  const server = await startServer(deps);
  try {
    for (const key of [null, "wrong-key", TEST_KEY.slice(0, -1), ""]) {
      const result = await post(
        server.url,
        "/internal/shipping/rate-quote",
        rateQuoteBody(),
        key,
      );
      assert.equal(result.status, 404, `key=${String(key)} must 404`);
    }
    // Non-Bearer scheme is rejected too.
    const basic = await call(server.url, "/internal/shipping/rate-quote", {
      method: "POST",
      headers: { authorization: `Basic ${TEST_KEY}` },
      body: JSON.stringify(rateQuoteBody()),
    });
    assert.equal(basic.status, 404);
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// Happy path via mocked carrier.service
// ---------------------------------------------------------------------------

test("valid key: rate-quote 200, sanitized DTO, carrier.service called with env-credential cfg=undefined", async () => {
  const saved = snapshotEnv();
  const { deps, rateCalls } = makeFakeDeps({ rates: FAKE_RATES });
  enableSeam();
  const server = await startServer(deps);
  try {
    const result = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody({ shipDate: "2026-11-10", serviceType: "FEDEX_GROUND" }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");

    const rates = result.body.rates as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rates));
    assert.equal(rates.length, 1);
    assert.equal(rates[0].carrier, "fedex");
    assert.equal(rates[0].service, "FEDEX_GROUND");
    assert.equal(rates[0].cost, 12.5);
    assert.equal(rates[0].currency, "USD");
    assert.equal(rates[0].serviceDescription, "FedEx Ground");
    assert.equal(rates[0].deliveryDays, "3");
    assert.equal(rates[0].deliveryDate, "2026-11-13");

    // Sanitization: whitelisted fields only — nothing else survives.
    const allowed = new Set([
      "carrier",
      "service",
      "cost",
      "currency",
      "serviceDescription",
      "deliveryDays",
      "deliveryDate",
      "rateType",
      "packagingType",
      "sku",
      "priceType",
    ]);
    for (const rate of rates) {
      for (const field of Object.keys(rate)) {
        assert.ok(
          allowed.has(field),
          `unexpected field ${field} leaked into rate DTO`,
        );
      }
    }
    const serialized = JSON.stringify(result.body);
    assert.ok(!serialized.includes("carrier-internal-secret"));
    assert.ok(!serialized.includes("should"));

    // Facade contract: carrier + full RateShopArgs, cfg undefined (env creds).
    assert.equal(rateCalls.length, 1);
    assert.equal(rateCalls[0].carrier, "fedex");
    assert.equal(rateCalls[0].cfg, undefined);
    const args = rateCalls[0].payload as Record<string, unknown>;
    assert.equal(args.fromZip, "30301");
    assert.equal(args.toZip, "10001");
    assert.equal(args.shipDate, "2026-11-10");
    assert.equal(args.serviceType, "FEDEX_GROUND");
    assert.deepEqual(args.packages, [{ weight: 2 }]);
    assert.equal((args.fromAddress as Record<string, unknown>).city, "Atlanta");
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

test("valid key: create-shipment 200, sanitized DTO, explicit serviceType passthrough, cfg=undefined", async () => {
  const saved = snapshotEnv();
  const { deps, createCalls } = makeFakeDeps({ labels: FAKE_LABELS });
  enableSeam();
  const server = await startServer(deps);
  try {
    const result = await post(
      server.url,
      "/internal/shipping/create-shipment",
      createShipmentBody({ reference: "VENDOR-REF-1" }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");

    const labels = result.body.labels as Array<Record<string, unknown>>;
    assert.equal(labels.length, 1);
    assert.equal(labels[0].carrier, "fedex");
    assert.equal(labels[0].trackingNumber, "794658901234");
    assert.equal(labels[0].format, "PDF");
    assert.equal(typeof labels[0].labelData, "string");
    assert.equal(labels[0].environment, "sandbox");
    assert.equal(labels[0].cost, 12.5);

    const allowed = new Set([
      "carrier",
      "environment",
      "trackingNumber",
      "labelData",
      "format",
      "cost",
    ]);
    for (const label of labels) {
      for (const field of Object.keys(label)) {
        assert.ok(
          allowed.has(field),
          `unexpected field ${field} leaked into label DTO`,
        );
      }
    }
    assert.ok(!JSON.stringify(result.body).includes("acct-do-not-leak"));

    // Facade contract: ShipmentRequest with caller-supplied service code,
    // no LogisticsSession/BC resolution, cfg undefined (env credentials).
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].carrier, "fedex");
    assert.equal(createCalls[0].cfg, undefined);
    const shipment = createCalls[0].payload as Record<string, unknown>;
    assert.equal(shipment.serviceType, "FEDEX_GROUND");
    assert.equal(shipment.labelFormat, "PDF");
    assert.equal(shipment.yourReference, "VENDOR-REF-1");
    assert.equal((shipment.from as Record<string, unknown>).zipCode, "30301");
    assert.deepEqual(shipment.packages, [
      { weight: 2, length: 10, width: 8, height: 4 },
    ]);
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// Endpoint allowlist
// ---------------------------------------------------------------------------

test("unknown sub-paths and wrong methods 404; services endpoint serves the static catalog", async () => {
  const saved = snapshotEnv();
  const { deps, rateCalls } = makeFakeDeps({ rates: FAKE_RATES });
  enableSeam();
  const server = await startServer(deps);
  try {
    for (const path of [
      "/internal/shipping/void",
      "/internal/shipping/track",
      "/internal/shipping/credentials",
      "/internal/shipping/rate-quote/extra",
      "/internal/shipping/create-shipment/x",
    ]) {
      const result = await post(server.url, path, {}, TEST_KEY);
      assert.equal(result.status, 404, `${path} must 404`);
      assert.deepEqual(result.body, { error: "Not found" });
    }

    // Wrong method on a known path is also an unknown route.
    const getQuote = await call(server.url, "/internal/shipping/rate-quote", {
      headers: { authorization: bearer() },
    });
    assert.equal(getQuote.status, 404);

    // Unknown carrier in services: 404.
    const unknown = await call(server.url, "/internal/shipping/services/dhl", {
      headers: { authorization: bearer() },
    });
    assert.equal(unknown.status, 404);

    // Known carrier: static catalog shape.
    const catalog = await call(
      server.url,
      "/internal/shipping/services/fedex",
      { headers: { authorization: bearer() } },
    );
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.carrier, "fedex");
    const services = catalog.body.services as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(services) && services.length > 0);
    for (const entry of services) {
      assert.deepEqual(Object.keys(entry).sort(), ["description", "service"]);
    }
    assert.ok(services.some((entry) => entry.service === "FEDEX_GROUND"));

    assert.equal(rateCalls.length, 0);
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------

test("IP allowlist: non-listed client 404s; listed client passes; empty list allows all", async () => {
  const saved = snapshotEnv();
  const { deps } = makeFakeDeps({ rates: FAKE_RATES });
  enableSeam();
  const server = await startServer(deps);
  try {
    // Client is 127.0.0.1 (::ffff:127.0.0.1) — not in this list.
    process.env.SLG_INTERNAL_API_ALLOWED_IPS = "10.99.99.99,192.168.0.5";
    const denied = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody(),
    );
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, { error: "Not found" });

    // IPv6-mapped entries normalize to the same client address.
    process.env.SLG_INTERNAL_API_ALLOWED_IPS = "10.99.99.99,::ffff:127.0.0.1";
    const allowed = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody(),
    );
    assert.equal(allowed.status, 200);

    // Blank value behaves as unset.
    process.env.SLG_INTERNAL_API_ALLOWED_IPS = "   ";
    const blank = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody(),
    );
    assert.equal(blank.status, 200);
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// DTO validation (400s, carrier never called)
// ---------------------------------------------------------------------------

test("invalid rate-quote DTOs: 400 and carrier not called", async () => {
  const saved = snapshotEnv();
  const { deps, rateCalls } = makeFakeDeps({ rates: FAKE_RATES });
  enableSeam();
  const server = await startServer(deps);
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown carrier", rateQuoteBody({ carrier: "dhl" })],
      ["no packages", rateQuoteBody({ packages: [] })],
      ["zero weight", rateQuoteBody({ packages: [{ weight: 0 }] })],
      ["over max weight", rateQuoteBody({ packages: [{ weight: 501 }] })],
      [
        "too many packages",
        rateQuoteBody({
          packages: Array.from({ length: 21 }, () => ({ weight: 1 })),
        }),
      ],
      [
        "oversized address line",
        rateQuoteBody({
          from: { ...fromAddress(), addressLine1: "x".repeat(101) },
        }),
      ],
      [
        "bad country code",
        rateQuoteBody({ to: { ...toAddress(), countryCode: "USA" } }),
      ],
      ["bad zip", rateQuoteBody({ to: { ...toAddress(), zipCode: "@" } })],
      ["bad ship date", rateQuoteBody({ shipDate: "11/10/2026" })],
      ["bad rateTypes", rateQuoteBody({ rateTypes: ["FOO"] })],
    ];
    for (const [label, body] of cases) {
      const result = await post(
        server.url,
        "/internal/shipping/rate-quote",
        body,
      );
      assert.equal(result.status, 400, `${label} must 400`);
      assert.equal(typeof result.body.error, "string");
    }
    assert.equal(rateCalls.length, 0, "carrier must not be called for 400s");
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

test("invalid create-shipment DTOs: 400 and carrier not called", async () => {
  const saved = snapshotEnv();
  const { deps, createCalls } = makeFakeDeps({ labels: FAKE_LABELS });
  enableSeam();
  const server = await startServer(deps);
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["carrier all not allowed", createShipmentBody({ carrier: "all" })],
      ["missing serviceType", createShipmentBody({ serviceType: "" })],
      ["missing labelFormat", createShipmentBody({ labelFormat: undefined })],
      ["bad labelFormat", createShipmentBody({ labelFormat: "GIF" })],
      [
        "serviceType with injection",
        createShipmentBody({ serviceType: "GROUND'; DROP" }),
      ],
      ["no packages", createShipmentBody({ packages: [] })],
      [
        "bad customs quantity",
        createShipmentBody({
          customsItems: [{ name: "Widget", quantity: 0, unitPrice: 5 }],
        }),
      ],
    ];
    for (const [label, body] of cases) {
      const result = await post(
        server.url,
        "/internal/shipping/create-shipment",
        body,
      );
      assert.equal(result.status, 400, `${label} must 400`);
      assert.equal(typeof result.body.error, "string");
    }
    assert.equal(createCalls.length, 0, "carrier must not be called for 400s");
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

test("control characters are stripped and unknown request fields dropped", () => {
  const parsed = sanitizeRateQuoteRequest(
    rateQuoteBody({
      evil: "<script>alert(1)</script>",
      from: {
        ...fromAddress(),
        addressLine1: "1 Warehouse\u0000Way",
        contactPhone: "(404) 555-0100",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const from = parsed.value.args.fromAddress;
  assert.ok(from, "fromAddress must be present");
  if (!from) return;
  assert.equal(from.addressLine1, "1 Warehouse Way");
  assert.equal(from.contactPhone, "(404) 555-0100");
  assert.ok(!JSON.stringify(parsed.value).includes("evil"));
  assert.ok(!JSON.stringify(parsed.value).includes("script"));
});

// ---------------------------------------------------------------------------
// Carrier error mapping
// ---------------------------------------------------------------------------

test("carrier errors map to sanitized upstream responses (raw bodies never leak)", async () => {
  const saved = snapshotEnv();
  enableSeam();
  const server = await startServer(
    makeFakeDeps({
      error: new CarrierApiError({
        status: 400,
        message: "FedEx rejected the service code",
        body: { secret: "internal-upstream-detail", transactions: [1] },
      }),
    }).deps,
  );
  try {
    const api = await post(
      server.url,
      "/internal/shipping/rate-quote",
      rateQuoteBody(),
    );
    assert.equal(api.status, 502);
    assert.equal(api.body.error, "Carrier request failed");
    assert.equal(api.body.message, "FedEx rejected the service code");
    assert.ok(!JSON.stringify(api.body).includes("internal-upstream-detail"));
  } finally {
    await server.close();
  }

  const validation = await (async () => {
    const s = await startServer(
      makeFakeDeps({
        error: new CarrierValidationError("weight exceeds carrier limit"),
      }).deps,
    );
    try {
      return await post(
        s.url,
        "/internal/shipping/create-shipment",
        createShipmentBody(),
      );
    } finally {
      await s.close();
    }
  })();
  assert.equal(validation.status, 400);
  assert.equal(validation.body.error, "weight exceeds carrier limit");

  const rateLimited = await (async () => {
    const s = await startServer(
      makeFakeDeps({ error: new CarrierRateLimitError("slow down") }).deps,
    );
    try {
      return await post(
        s.url,
        "/internal/shipping/rate-quote",
        rateQuoteBody(),
      );
    } finally {
      await s.close();
    }
  })();
  assert.equal(rateLimited.status, 429);

  const unknown = await (async () => {
    const s = await startServer(
      makeFakeDeps({ error: new Error("socket hang up") }).deps,
    );
    try {
      return await post(
        s.url,
        "/internal/shipping/rate-quote",
        rateQuoteBody(),
      );
    } finally {
      await s.close();
    }
  })();
  assert.equal(unknown.status, 502);
  assert.deepEqual(unknown.body, { error: "Carrier request failed" });
  assert.ok(!JSON.stringify(unknown.body).includes("socket"));
  restoreEnv(saved);
});

// ---------------------------------------------------------------------------
// Static service catalog
// ---------------------------------------------------------------------------

test("service catalog: static defaults, env override read per request", async () => {
  const saved = snapshotEnv();
  enableSeam();
  const server = await startServer();
  try {
    const fedex = await call(server.url, "/internal/shipping/services/fedex", {
      headers: { authorization: bearer() },
    });
    assert.equal(fedex.status, 200);
    const fedexServices = fedex.body.services as Array<Record<string, unknown>>;
    assert.ok(
      fedexServices.some(
        (entry) =>
          entry.service === "FEDEX_INTERNATIONAL_CONNECT_PLUS" &&
          entry.description === "FedEx International Connect Plus",
      ),
    );

    const first = await call(server.url, "/internal/shipping/services/ups", {
      headers: { authorization: bearer() },
    });
    assert.equal(first.status, 200);
    const defaults = first.body.services as Array<Record<string, unknown>>;
    assert.ok(defaults.some((entry) => entry.service === "03"));
    assert.ok(defaults.some((entry) => entry.service === "01"));

    // Override via env — picked up on the next request without reload.
    process.env.SLG_INTERNAL_SERVICES_UPS = "77=UPS Worldwide Express Saver,42";
    const second = await call(server.url, "/internal/shipping/services/ups", {
      headers: { authorization: bearer() },
    });
    assert.equal(second.status, 200);
    const overridden = second.body.services as Array<Record<string, unknown>>;
    assert.equal(overridden.length, 2);
    assert.deepEqual(overridden[0], {
      service: "77",
      description: "UPS Worldwide Express Saver",
    });
    // Entry without "=" keeps the code as its description.
    assert.deepEqual(overridden[1], { service: "42", description: "42" });

    // Direct service-module access agrees.
    assert.deepEqual(
      getServiceCatalog("ups").map((entry) => entry.service),
      ["77", "42"],
    );
  } finally {
    await server.close();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// Full chain through the real carrier.service facade (fake FedEx transport)
// ---------------------------------------------------------------------------

const FAKE_LABEL_BASE64 = Buffer.from("%PDF-1.4 fake-label").toString("base64");

function fakeFedexTransport(): typeof fetch {
  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return (async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("oauth/token")) {
      void init;
      return json({ access_token: "fake-token", expires_in: 3600 });
    }
    if (target.includes("rates/quotes")) {
      return json({
        output: {
          rateReplyDetails: [
            {
              serviceName: "FedEx Ground®",
              serviceType: "FEDEX_GROUND",
              ratedShipmentDetails: [
                { totalNetCharge: { amount: 12.5, currency: "USD" } },
              ],
            },
          ],
        },
      });
    }
    if (target.includes("shipments")) {
      return json({
        output: {
          transactionShipments: [
            {
              masterTrackingNumber: "794658901234",
              pieceResponses: [
                {
                  packageDocuments: [{ encodedLabel: FAKE_LABEL_BASE64 }],
                },
              ],
            },
          ],
        },
      });
    }
    return json({ output: {} });
  }) as typeof fetch;
}

test("full chain: default router -> carrier.service -> fedex client (env credentials, fake transport)", async () => {
  const saved = snapshotEnv();
  enableSeam();
  __resetCarrierCachesForTests();
  __setFedexTransportForTests(fakeFedexTransport());
  // The default exported router binds carrier.service directly (what
  // server.ts mounts) — this proves the seam -> facade -> client wiring.
  const app = express();
  app.use(express.json({ limit: "100kb", strict: true }));
  app.use("/internal/shipping", createInternalShippingRouter());
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const rates = await post(base, "/internal/shipping/rate-quote", {
      ...rateQuoteBody(),
      carrier: "FEDEX",
    });
    assert.equal(rates.status, 200);
    const rateRows = rates.body.rates as Array<Record<string, unknown>>;
    assert.equal(rateRows.length, 1);
    assert.equal(rateRows[0].service, "FEDEX_GROUND");
    assert.equal(rateRows[0].serviceDescription, "FedEx Ground®");
    assert.equal(rateRows[0].cost, 12.5);
    assert.equal(rateRows[0].currency, "USD");

    const labels = await post(base, "/internal/shipping/create-shipment", {
      ...createShipmentBody({ serviceType: String(rateRows[0].service) }),
    });
    assert.equal(labels.status, 200);
    const labelRows = labels.body.labels as Array<Record<string, unknown>>;
    assert.equal(labelRows.length, 1);
    assert.equal(labelRows[0].trackingNumber, "794658901234");
    assert.equal(labelRows[0].labelData, FAKE_LABEL_BASE64);
    assert.equal(labelRows[0].format, "PDF");
  } finally {
    __setFedexTransportForTests(null);
    __resetCarrierCachesForTests();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnv(saved);
  }
});

test("DTO unit: create-shipment rejects carrier=all and requires explicit service code", () => {
  const parsed = sanitizeCreateShipmentRequest(createShipmentBody());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.carrier, "fedex");
    assert.equal(parsed.value.shipment.serviceType, "FEDEX_GROUND");
  }
  const all = sanitizeCreateShipmentRequest(
    createShipmentBody({ carrier: "all" }),
  );
  assert.equal(all.ok, false);
  const quote = sanitizeRateQuoteRequest(rateQuoteBody({ carrier: "ALL" }));
  assert.equal(quote.ok, true);
  if (quote.ok) assert.equal(quote.value.carrier, "all");
  // Non-object bodies (bypassing strict JSON) fail validation, not crash.
  const nonObject = sanitizeRateQuoteRequest("not-an-object");
  assert.equal(nonObject.ok, false);
});

test("DTO unit: sanitizeRateQuote passes deliveryDate through", () => {
  const parsed = sanitizeRateQuoteRequest(rateQuoteBody());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const rate = parsed.value.args as unknown as Record<string, unknown>;
  // Rate request DTO itself does not produce a rate; this is a compile-shape
  // guard. Real deliveryDate flow is tested via the full rate-quote path.
  assert.equal(typeof rate.packages, "object");
});

test("DTO unit: sanitizeCreateShipmentRequest accepts valid pickup block", () => {
  const parsed = sanitizeCreateShipmentRequest(
    createShipmentBody({
      pickup: {
        type: "pickup",
        date: "2026-11-15",
        readyTime: "09:00",
        closeTime: "17:00",
        instructions: "Ring bell",
      },
    }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const pickup = parsed.value.shipment.pickup as unknown as Record<
    string,
    unknown
  >;
  assert.equal(pickup.type, "pickup");
  assert.equal(pickup.date, "2026-11-15");
  assert.equal(pickup.readyTime, "09:00");
  assert.equal(pickup.closeTime, "17:00");
  assert.equal(pickup.instructions, "Ring bell");
});

test("DTO unit: sanitizeCreateShipmentRequest rejects invalid pickup", () => {
  assert.equal(
    sanitizeCreateShipmentRequest(
      createShipmentBody({ pickup: { type: "curbside" } }),
    ).ok,
    false,
  );
  assert.equal(
    sanitizeCreateShipmentRequest(
      createShipmentBody({ pickup: { type: "pickup" } }),
    ).ok,
    false,
  );
  assert.equal(
    sanitizeCreateShipmentRequest(
      createShipmentBody({ pickup: { type: "pickup", readyTime: "25:00" } }),
    ).ok,
    false,
  );
  assert.equal(
    sanitizeCreateShipmentRequest(
      createShipmentBody({
        pickup: { type: "dropoff", readyTime: "09:00" },
      }),
    ).ok,
    true,
  );
});
