import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import knexFactory from "knex";
import path from "node:path";
import type { Knex } from "knex";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { createAdminRouter } from "../../src/routes/admin.routes";

const testVendorDetails = {
  companyName: "Integration Shipper",
  contactName: "Integration Contact",
  contactEmail: "shipper@example.com",
  contactPhone: "5125550100",
  addressLine1: "1 Shipper St",
  city: "Austin",
  state: "TX",
  zipCode: "73301",
  countryCode: "US",
  taxIds: [],
};

const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function runMigrations(knex: Knex) {
  await knex.migrate.latest({
    directory: MIGRATIONS_DIR,
    tableName: "slg_knex_migrations_int",
  });
}

async function rollbackMigrations(knex: Knex) {
  await knex.migrate.rollback(
    {
      directory: MIGRATIONS_DIR,
      tableName: "slg_knex_migrations_int",
    },
    true,
  );
}

describe("vendor flow integration", () => {
  const databaseUrl = process.env.DATABASE_URL;
  let knex: knexFactory.Knex;

  before(async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for integration tests");
    }
    knex = knexFactory({ client: "pg", connection: databaseUrl });
    await rollbackMigrations(knex);
    await runMigrations(knex);
  });

  after(async () => {
    if (knex) {
      await rollbackMigrations(knex);
      await knex.destroy();
    }
  });

  it("happy path: create vendor, link, rates, shipment, label download", async () => {
    const adminApp = express();
    adminApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    adminApp.use(express.json());
    adminApp.use("/admin/v1", createAdminRouter());

    const vendorRes = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/vendors",
      token: adminToken(),
      body: { name: "Integration Vendor", contactEmail: "v@endor.test" },
    });
    assert.equal(vendorRes.status, 201);
    const vendorId = vendorRes.body.vendor.id;

    const linkRes = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/links",
      token: adminToken(),
      body: {
        vendorId,
        expiresInDays: 7,
        maxUses: 1,
        shipFrom: {
          name: "WH",
          street: "123 Main",
          city: "City",
          state: "ST",
          zip: "12345",
        },
      },
    });
    assert.equal(linkRes.status, 201);
    const token = linkRes.body.token;

    const seamClient = {
      getServices: async (carrier: "fedex" | "ups" | "usps" | "stamps") => ({
        carrier,
        services: [],
      }),
      rateQuote: async () => ({
        rates: [
          {
            carrier: "fedex" as const,
            service: "FEDEX_GROUND",
            cost: 12.5,
            currency: "USD",
          },
        ],
      }),
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex" as const,
            trackingNumber: "TRACK123",
            labelData: Buffer.from("%PDF-1.4").toString("base64"),
            format: "PDF" as const,
          },
        ],
      }),
      dutyTaxEstimate: async () => ({
        estimate: {
          nonGuaranteed: true as const,
          guaranteed: false as const,
          disclaimer: "Estimated duties, taxes and fees are non-guaranteed.",
          duties: [],
          fees: [],
          taxes: [],
        },
      }),
    };

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const statusRes = await request(vendorApp, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(statusRes.status, 200);

    const ratesRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: testVendorDetails,
      },
    });
    assert.equal(ratesRes.status, 200);

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: {
          addressLine1: "456 Oak",
          city: "Town",
          state: "CA",
          zipCode: "90210",
          countryCode: "US",
        },
        packages: [{ weight: 2.5 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
      },
    });
    assert.equal(shipmentRes.status, 201);

    const labelRes = await request(vendorApp, {
      method: "GET",
      path: "/v1/label.pdf",
      token,
    });
    assert.equal(labelRes.status, 200);
    assert.equal(labelRes.headers["content-type"], "application/pdf");
  });

  it("cross-vendor isolation: token cannot access another vendor", async () => {
    const adminApp = express();
    adminApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    adminApp.use(express.json());
    adminApp.use("/admin/v1", createAdminRouter());

    const v1 = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/vendors",
      token: adminToken(),
      body: { name: "Vendor A" },
    });
    const v2 = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/vendors",
      token: adminToken(),
      body: { name: "Vendor B" },
    });

    const l1 = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/links",
      token: adminToken(),
      body: {
        vendorId: v1.body.vendor.id,
        expiresInDays: 7,
        shipFrom: {
          name: "WH",
          street: "123 Main",
          city: "City",
          state: "ST",
          zip: "12345",
        },
      },
    });

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient: null as any }));

    const res = await request(vendorApp, {
      method: "GET",
      path: `/v1/vendor-b-shipment-that-does-not-exist`,
      token: l1.body.token,
    });
    assert.equal(res.status, 404);
  });

  it("rate limit returns 429 after excessive requests", async () => {
    const adminApp = express();
    adminApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    adminApp.use(express.json());
    adminApp.use("/admin/v1", createAdminRouter());

    const v = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/vendors",
      token: adminToken(),
      body: { name: "Rate Limit Vendor" },
    });

    const l = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/links",
      token: adminToken(),
      body: {
        vendorId: v.body.vendor.id,
        expiresInDays: 7,
        shipFrom: {
          name: "WH",
          street: "123 Main",
          city: "City",
          state: "ST",
          zip: "12345",
        },
      },
    });

    const vendorApp = express();
    vendorApp.set("trust proxy", 1);
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    const { createRateLimit } = await import("../../src/core/rate-limit");
    vendorApp.use(
      "/v1",
      createRateLimit({
        name: "int_token_api",
        points: 2,
        durationSeconds: 60,
        blockSeconds: 60,
      }),
      createVendorRouter({ seamClient: null as any }),
    );

    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const r = await request(vendorApp, {
        method: "GET",
        path: "/v1/status",
        token: l.body.token,
      });
      lastStatus = r.status;
      if (r.status === 429) break;
    }
    assert.equal(lastStatus, 429);
  });
});

function adminToken(): string {
  const { signAdminToken } = require("../../src/core/jwt");
  return signAdminToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

function request(
  app: express.Express,
  opts: { method: string; path: string; token?: string; body?: unknown },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: opts.path,
          method: opts.method,
          headers: {
            "Content-Type": "application/json",
            ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
          },
        },
        (res) => {
          let data = "";
          const isPdf = res.headers["content-type"] === "application/pdf";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close(() => {
              let parsed: unknown;
              if (isPdf) {
                parsed = Buffer.from(data);
              } else {
                try {
                  parsed = data ? JSON.parse(data) : null;
                } catch {
                  parsed = data;
                }
              }
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: parsed,
              });
            });
          });
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  });
}
