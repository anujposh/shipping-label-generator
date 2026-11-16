import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { createAdminRouter } from "../../src/routes/admin.routes";
import { signAdminToken } from "../../src/core/jwt";
import { fakeKnex } from "./fake-knex";
import * as dbModule from "../../src/db";
import * as linksStore from "../../src/store/links.store";

function isoFuture(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function makeLink(
  token: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    vendor_id: 1,
    token_hash: linksStore.hashToken(token),
    expires_at: isoFuture(7),
    revoked_at: null,
    max_uses: null,
    use_count: 0,
    created_by: "admin@test.com",
    ship_from: {
      name: "Legacy Warehouse",
      street: "1 Legacy St",
      city: "Austin",
      state: "TX",
      zip: "73301",
      country: "US",
    },
    vendor_details: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeApp(seamClient: any) {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = `req-${Math.random().toString(36).slice(2)}`;
    next();
  });
  app.use(express.json({ limit: "10mb" }));
  app.use("/v1", createVendorRouter({ seamClient }));
  return app;
}

function makeAdminApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.requestId = `req-${Math.random().toString(36).slice(2)}`;
    next();
  });
  app.use(express.json());
  app.use("/admin/v1", createAdminRouter({}));
  return app;
}

async function httpRequest(
  app: ReturnType<typeof makeApp>,
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
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            server.close(() => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: text ? JSON.parse(text) : null,
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

function validDetails(overrides: Record<string, unknown> = {}) {
  return {
    companyName: "Acme Shipper LLC",
    contactName: "Alex Shipper",
    contactEmail: "alex@acme.example",
    contactPhone: "512-555-0100",
    addressLine1: "1 Shipper St",
    city: "Austin",
    state: "TX",
    zipCode: "73301",
    countryCode: "US",
    taxIds: [{ number: "EIN123", tinType: "BUSINESS_NATIONAL" }],
    ...overrides,
  };
}

function domesticBody(overrides: Record<string, unknown> = {}) {
  return {
    shipTo: {
      addressLine1: "2 Recipient St",
      city: "Town",
      state: "CA",
      zipCode: "90210",
      countryCode: "US",
    },
    packages: [{ weight: 2 }],
    carrier: "ups",
    serviceType: "GROUND",
    vendorDetails: validDetails(),
    ...overrides,
  };
}

const validCustoms = {
  isDocumentOnly: false,
  shipmentPurpose: "COMMERCIAL",
  invoiceNumber: "INV-100",
  termsOfSale: "DDP",
  currency: "USD",
  commodities: [
    {
      name: "Widget",
      description: "Widget",
      intendedUse: "Resale",
      quantity: 2,
      quantityUnits: "EA",
      weight: 2,
      weightUnits: "LB",
      unitPrice: 25,
      currency: "USD",
      hsCode: "6404.11.2030",
      countryOfManufacture: "US",
    },
  ],
  totalCustomsValue: { amount: 50, currency: "USD" },
  dutiesPayment: { paymentType: "SENDER" },
  // Browser may submit a different (here invalid) exporter; server must
  // ignore it before validation and override it with vendorDetails.
  exporter: {
    companyName: "Browser Exporter",
    contactName: "Imposter",
    address: {
      addressLine1: "9 Wrong St",
      city: "Nowhere",
      state: "ZZ",
      zipCode: "00000",
      countryCode: "USA",
    },
  },
  shipperTaxIds: [{ number: "BROWSER-TIN", tinType: "FEDERAL" }],
};

function internationalBody(overrides: Record<string, unknown> = {}) {
  return {
    carrier: "fedex",
    serviceType: "INTERNATIONAL_PRIORITY",
    shipTo: {
      addressLine1: "2 Recipient St",
      city: "Toronto",
      state: "ON",
      zipCode: "M5V2T6",
      countryCode: "CA",
      contactName: "Recipient",
    },
    packages: [{ weight: 5 }],
    customs: validCustoms,
    vendorDetails: validDetails(),
    ...overrides,
  };
}

function fakeSeam() {
  const captured: {
    rate?: any;
    shipment?: any;
    duty?: any;
    rateCalls: number;
    shipmentCalls: number;
    dutyCalls: number;
  } = { rateCalls: 0, shipmentCalls: 0, dutyCalls: 0 };
  return {
    captured,
    client: {
      rateQuote: async (req: any) => {
        captured.rateCalls += 1;
        captured.rate = req;
        return { rates: [] };
      },
      createShipment: async (req: any) => {
        captured.shipmentCalls += 1;
        captured.shipment = req;
        return {
          labels: [
            {
              carrier: req.carrier,
              trackingNumber: "TRACK-DETAILS-1",
              labelData: Buffer.from("%PDF-1.4 label").toString("base64"),
              format: "PDF",
              documents: [],
            },
          ],
        };
      },
      dutyTaxEstimate: async (req: any) => {
        captured.dutyCalls += 1;
        captured.duty = req;
        return { estimate: { nonGuaranteed: true } };
      },
    },
  };
}

describe("shared-link vendor details", () => {
  let realDb: typeof dbModule.db;
  before(() => {
    realDb = dbModule.db;
  });
  after(() => {
    dbModule.setDb(realDb);
  });

  function setState(rows: any[]) {
    const state = fakeKnex({ rows });
    dbModule.setDb(state as unknown as typeof dbModule.db);
    return state as any;
  }

  it("status returns the current link vendorDetails (null before submit)", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.link.vendorDetails, null);
    assert.equal(res.body.link.shipFromCountryCode, null);
    assert.equal(res.headers["cache-control"], "no-store");
  });

  it("status derives shipFromCountryCode only from saved vendorDetails", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const rates = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody(),
    });
    assert.equal(rates.status, 200);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.link.shipFromCountryCode, "US");
    assert.equal(res.body.link.vendorDetails.companyName, "Acme Shipper LLC");
  });

  it("status cannot leak another link's vendorDetails", async () => {
    const token = linksStore.generateToken();
    setState([
      makeLink(token),
      makeLink(linksStore.generateToken(), {
        id: 2,
        vendor_details: validDetails({ companyName: "Other Vendor" }),
      }),
    ]);
    const app = makeApp(fakeSeam().client);
    const res = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.link.vendorDetails, null);
  });

  it("rejects missing mandatory fields with vendorDetails.* fieldErrors", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const details = { ...validDetails() } as Record<string, unknown>;
    delete details.contactEmail;
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({ vendorDetails: details }),
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.fieldErrors["vendorDetails.contactEmail"]);
    assert.equal(state.rows[0].vendor_details, null);
  });

  it("rejects whitespace-only and malformed mandatory fields", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({
        vendorDetails: validDetails({
          companyName: "   ",
          contactEmail: "not-an-email",
          countryCode: "USA",
          zipCode: "!",
        }),
      }),
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.fieldErrors["vendorDetails.companyName"]);
    assert.ok(res.body.fieldErrors["vendorDetails.contactEmail"]);
    assert.ok(res.body.fieldErrors["vendorDetails.countryCode"]);
    assert.ok(res.body.fieldErrors["vendorDetails.zipCode"]);
  });

  it("requires vendorDetails on rates before any carrier call or write", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const body = { ...domesticBody() } as Record<string, unknown>;
    delete body.vendorDetails;
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body,
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.fieldErrors.vendorDetails);
    assert.equal(seam.captured.rateCalls, 0);
    assert.equal(state.rows[0].vendor_details, null);
  });

  it("requires vendorDetails on shipments before any carrier call or write", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const before = state.rows.length;
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const body = { ...domesticBody() } as Record<string, unknown>;
    delete body.vendorDetails;
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body,
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.fieldErrors.vendorDetails);
    assert.equal(seam.captured.shipmentCalls, 0);
    assert.equal(state.rows.length, before);
    assert.equal(state.rows[0].vendor_details, null);
  });

  it("requires vendorDetails on duty estimates before any carrier call", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/duty-tax-estimate",
      token,
      body: {
        shipTo: internationalBody().shipTo,
        customs: validCustoms,
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.fieldErrors.vendorDetails);
    assert.equal(seam.captured.dutyCalls, 0);
    assert.equal(state.rows[0].vendor_details, null);
  });

  it("rejects invalid tax ids (tinType enum and FedEx 18-char number cap)", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const badType = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({
        vendorDetails: validDetails({
          taxIds: [{ number: "EIN123", tinType: "NOT_A_TYPE" }],
        }),
      }),
    });
    assert.equal(badType.status, 400);
    assert.ok(badType.body.fieldErrors["vendorDetails.taxIds.0.tinType"]);

    const tooLong = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({
        vendorDetails: validDetails({
          taxIds: [{ number: "1".repeat(19), tinType: "FEDERAL" }],
        }),
      }),
    });
    assert.equal(tooLong.status, 400);
    assert.ok(tooLong.body.fieldErrors["vendorDetails.taxIds.0.number"]);
  });

  it("persists valid details only on the authenticated link and uses them as origin", async () => {
    const token = linksStore.generateToken();
    const state = setState([
      makeLink(token),
      makeLink(linksStore.generateToken(), { id: 2 }),
    ]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody(),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.rows[0].vendor_details, validDetails());
    assert.equal(state.rows[1].vendor_details, null);
    // Submitted identity, not legacy ship_from, reaches the carrier.
    assert.equal(seam.captured.rate.from.addressLine1, "1 Shipper St");
    assert.equal(seam.captured.rate.from.companyName, "Acme Shipper LLC");
    assert.equal(seam.captured.rate.from.countryCode, "US");
  });

  it("updates saved details on later submissions", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody(),
    });
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({
        vendorDetails: validDetails({
          companyName: "Acme Renamed LLC",
          addressLine1: "9 New St",
        }),
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(state.rows[0].vendor_details.companyName, "Acme Renamed LLC");
    assert.equal(state.rows[0].vendor_details.addressLine1, "9 New St");
  });

  it("keeps a shipment snapshot after the link details change", async () => {
    const token = linksStore.generateToken();
    const state = setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const first = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: domesticBody({
        vendorDetails: validDetails({ companyName: "Snapshot LLC" }),
      }),
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const shipmentRow = state.rows.find(
      (r: any) => r.link_id === 1 && r.ship_from?.companyName,
    );
    assert.equal(shipmentRow.ship_from.companyName, "Snapshot LLC");
    assert.equal(shipmentRow.ship_from.contactEmail, "alex@acme.example");

    await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody({
        vendorDetails: validDetails({ companyName: "Changed Later LLC" }),
      }),
    });
    assert.equal(state.rows[0].vendor_details.companyName, "Changed Later LLC");

    const status = await httpRequest(app, {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(status.status, 200);
    // Public shipment history intentionally omits shipFrom; the persisted
    // snapshot must keep the original details after the link was updated.
    const snapshot = state.rows.find(
      (r: any) => r.link_id === 1 && r.ship_from?.companyName,
    );
    assert.equal(snapshot.ship_from.companyName, "Snapshot LLC");
    assert.deepEqual(snapshot.ship_from.taxIds, [
      { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
    ]);

    // Admin shipment API exposes the full snapshot (email + tax ids).
    const adminRes = await httpRequest(makeAdminApp(), {
      method: "GET",
      path: `/admin/v1/shipments/${snapshot.id}`,
      token: signAdminToken({
        sub: 1,
        email: "admin@test.com",
        role: "admin",
      }),
    });
    assert.equal(adminRes.status, 200, JSON.stringify(adminRes.body));
    assert.equal(adminRes.body.shipment.shipFrom.companyName, "Snapshot LLC");
    assert.equal(
      adminRes.body.shipment.shipFrom.contactEmail,
      "alex@acme.example",
    );
    assert.deepEqual(adminRes.body.shipment.shipFrom.taxIds, [
      { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
    ]);
  });

  it("domestic FedEx shipper uses vendorDetails and adds no customs", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: domesticBody({
        carrier: "fedex",
        serviceType: "FEDEX_GROUND",
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(seam.captured.shipment.from.companyName, "Acme Shipper LLC");
    assert.equal(seam.captured.shipment.from.contactEmail, "alex@acme.example");
    assert.equal(seam.captured.shipment.from.addressLine1, "1 Shipper St");
    assert.equal(seam.captured.shipment.customs, undefined);
  });

  it("international FedEx forces submitted exporter/contact/address/tins", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: internationalBody(),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const customs = seam.captured.shipment.customs;
    assert.equal(customs.exporter.companyName, "Acme Shipper LLC");
    assert.equal(customs.exporter.contactName, "Alex Shipper");
    assert.equal(customs.exporter.contactEmail, "alex@acme.example");
    assert.equal(customs.exporter.address.addressLine1, "1 Shipper St");
    assert.equal(customs.exporter.address.countryCode, "US");
    assert.deepEqual(customs.exporter.taxIds, [
      { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
    ]);
    assert.deepEqual(customs.shipperTaxIds, [
      { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
    ]);
    // Browser-provided differing exporter cannot survive.
    assert.notEqual(customs.exporter.companyName, "Browser Exporter");
    assert.notEqual(customs.shipperTaxIds[0].number, "BROWSER-TIN");
  });

  it("duty-tax-estimate uses the submitted origin and exporter", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const seam = fakeSeam();
    const app = makeApp(seam.client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/duty-tax-estimate",
      token,
      body: {
        shipTo: internationalBody().shipTo,
        customs: validCustoms,
        vendorDetails: validDetails({ companyName: "Duty Shipper LLC" }),
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(seam.captured.duty.from.addressLine1, "1 Shipper St");
    assert.equal(
      seam.captured.duty.customs.exporter.companyName,
      "Duty Shipper LLC",
    );
    assert.deepEqual(seam.captured.duty.customs.shipperTaxIds, [
      { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
    ]);
  });

  it("does not expose carrier credentials in public responses", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const app = makeApp(fakeSeam().client);
    const res = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: domesticBody(),
    });
    assert.equal(res.status, 200);
    const raw = JSON.stringify(res.body);
    assert.ok(
      !/accountNumber|apiKey|apiSecret|password|clientSecret/i.test(raw),
    );
  });
});
