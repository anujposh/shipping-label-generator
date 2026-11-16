import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { fakeKnex } from "./fake-knex";
import * as dbModule from "../../src/db";
import * as linksStore from "../../src/store/links.store";

function isoFuture(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function makeLink(token: string) {
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
      name: "Warehouse",
      street: "1 Shipper St",
      city: "Austin",
      state: "TX",
      zip: "73301",
      country: "US",
    },
    vendor_details: vendorDetails(),
    created_at: new Date().toISOString(),
  };
}

function vendorDetails(overrides: Record<string, unknown> = {}) {
  return {
    companyName: "Warehouse",
    contactName: "Warehouse Contact",
    contactEmail: "warehouse@example.com",
    contactPhone: "5125550100",
    addressLine1: "1 Shipper St",
    city: "Austin",
    state: "TX",
    zipCode: "73301",
    countryCode: "US",
    taxIds: [],
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

async function httpRequest(
  app: ReturnType<typeof makeApp>,
  opts: { method: string; path: string; token?: string; body?: unknown },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: any;
  raw: Buffer;
}> {
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
              const raw = Buffer.concat(chunks);
              const text = raw.toString("utf8");
              let parsed: unknown;
              try {
                parsed = text ? JSON.parse(text) : null;
              } catch {
                parsed = text;
              }
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: parsed,
                raw,
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
};

function shipmentBody(overrides: Record<string, unknown> = {}) {
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
    vendorDetails: vendorDetails(),
    ...overrides,
  };
}

function baseSeam(overrides: Record<string, unknown> = {}) {
  return {
    getServices: async (carrier: string) => ({ carrier, services: [] }),
    rateQuote: async () => ({ rates: [] }),
    createShipment: async () => ({
      labels: [
        {
          carrier: "fedex",
          trackingNumber: "TRACK1",
          labelData: Buffer.from("%PDF-1.4 label").toString("base64"),
          format: "PDF",
          documents: [
            {
              documentType: "COMMERCIAL_INVOICE",
              docType: "PDF",
              fileName: "COMMERCIAL_INVOICE-TRACK1.pdf",
              contentBase64: Buffer.from("%PDF-1.4 invoice").toString("base64"),
              source: "FEDEX_GENERATED",
            },
          ],
        },
      ],
    }),
    dutyTaxEstimate: async () => ({
      estimate: {
        nonGuaranteed: true,
        disclaimer: "Estimated duties, taxes and fees are non-guaranteed.",
        currency: "USD",
        duties: [{ amount: 2.5, currency: "USD" }],
        fees: [],
        taxes: [],
        summary: { totalDuties: 2.5, totalLandedCost: 52.5, currency: "USD" },
      },
    }),
    ...overrides,
  };
}

describe("vendor international routes", () => {
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
    return state;
  }

  it("exposes shipFromCountryCode in /v1/status", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const res = await httpRequest(makeApp(baseSeam()), {
      method: "GET",
      path: "/v1/status",
      token,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.link.shipFromCountryCode, "US");
  });

  it("adds a real FICP rate when the general quote omits it", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const calls: any[] = [];
    const seam = baseSeam({
      rateQuote: async (args: any) => {
        calls.push(args);
        if (args.serviceType === "FEDEX_INTERNATIONAL_CONNECT_PLUS") {
          return {
            rates: [
              {
                carrier: "fedex",
                service: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
                cost: 144.04,
                currency: "USD",
              },
            ],
          };
        }
        return {
          rates: [
            {
              carrier: "fedex",
              service: "INTERNATIONAL_PRIORITY",
              cost: 251.98,
              currency: "USD",
            },
          ],
        };
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({
        customs: undefined,
        serviceType: undefined,
        packagingType: "FEDEX_PAK",
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].serviceType, "FEDEX_INTERNATIONAL_CONNECT_PLUS");
    assert.ok(calls.every((call) => call.packagingType === "FEDEX_PAK"));
    assert.deepEqual(
      res.body.rates.map((rate: any) => rate.service),
      ["INTERNATIONAL_PRIORITY", "FEDEX_INTERNATIONAL_CONNECT_PLUS"],
    );
  });

  it("keeps other rates when the FICP-specific quote is unavailable", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const calls: any[] = [];
    const seam = baseSeam({
      rateQuote: async (args: any) => {
        calls.push(args);
        if (args.serviceType === "FEDEX_INTERNATIONAL_CONNECT_PLUS") {
          throw new Error("FICP unavailable");
        }
        return {
          rates: [
            {
              carrier: "fedex",
              service: "INTERNATIONAL_PRIORITY",
              cost: 251.98,
              currency: "USD",
            },
          ],
        };
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({ customs: undefined, serviceType: undefined }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      res.body.rates.map((rate: any) => rate.service),
      ["INTERNATIONAL_PRIORITY"],
    );
  });

  it("rejects unsupported packaging types before requesting rates", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    let calls = 0;
    const seam = baseSeam({
      rateQuote: async () => {
        calls += 1;
        return { rates: [] };
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({ customs: undefined, packagingType: "BAG" }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls, 0);
  });

  it("accepts the newest FedEx Extra Small Box packaging type", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const calls: any[] = [];
    const seam = baseSeam({
      rateQuote: async (args: any) => {
        calls.push(args);
        return { rates: [] };
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({
        customs: undefined,
        packagingType: "FEDEX_EXTRA_SMALL_BOX",
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(
      calls.every((call) => call.packagingType === "FEDEX_EXTRA_SMALL_BOX"),
    );
  });

  it("accepts 120-inch dimensions and rejects larger values", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    let calls = 0;
    const seam = baseSeam({
      rateQuote: async () => {
        calls += 1;
        return { rates: [] };
      },
    });
    const app = makeApp(seam);
    const accepted = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({
        customs: undefined,
        packages: [{ weight: 5, length: 120, width: 10, height: 10 }],
      }),
    });
    assert.equal(accepted.status, 200);
    assert.ok(calls > 0);

    const previousCalls = calls;
    const rejected = await httpRequest(app, {
      method: "POST",
      path: "/v1/rates",
      token,
      body: shipmentBody({
        customs: undefined,
        packages: [{ weight: 5, length: 120.01, width: 10, height: 10 }],
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(calls, previousCalls);
  });

  it("rejects FedEx international shipments without customs", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const res = await httpRequest(makeApp(baseSeam()), {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: shipmentBody({ customs: undefined }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "VALIDATION_ERROR");
    assert.ok(res.body.details.some((entry: any) => entry.field === "customs"));
  });

  it("rejects customs on a non-FedEx shipment", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const res = await httpRequest(makeApp(baseSeam()), {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: shipmentBody({ carrier: "ups", serviceType: "03" }),
    });
    assert.equal(res.status, 400);
    assert.ok(
      res.body.details.some(
        (entry: any) =>
          entry.field === "customs" && /FedEx/i.test(entry.message),
      ),
    );
  });

  it("forwards a structured carrier 400 instead of a 502", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const error = Object.assign(new Error("FedEx rejected commodities"), {
      status: 400,
      code: "CARRIER_VALIDATION_ERROR",
      details: [{ field: "customs.commodities.0.hsCode", message: "invalid" }],
    });
    const seam = baseSeam({
      createShipment: async () => {
        throw error;
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: shipmentBody(),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "CARRIER_VALIDATION_ERROR");
    assert.deepEqual(res.body.details, [
      { field: "customs.commodities.0.hsCode", message: "invalid" },
    ]);
  });

  it("persists and serves customs documents for the link", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    let seamParams: any;
    const seam = baseSeam({
      createShipment: async (params: any) => {
        seamParams = params;
        return {
          labels: [
            {
              carrier: "fedex",
              trackingNumber: "TRACK1",
              labelData: Buffer.from("%PDF-1.4 label").toString("base64"),
              format: "PDF",
              documents: [
                {
                  documentType: "COMMERCIAL_INVOICE",
                  docType: "PDF",
                  fileName: "COMMERCIAL_INVOICE-TRACK1.pdf",
                  contentBase64:
                    Buffer.from("%PDF-1.4 invoice").toString("base64"),
                  source: "FEDEX_GENERATED",
                },
              ],
              documentWarnings: ["post upload failed"],
            },
          ],
        };
      },
    });

    const app = makeApp(seam);
    const created = await httpRequest(app, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: shipmentBody(),
    });
    assert.equal(created.status, 201);
    assert.equal(seamParams.customs.invoiceNumber, validCustoms.invoiceNumber);
    assert.deepEqual(seamParams.customs.commodities, validCustoms.commodities);
    // Submitted vendorDetails are forced as the exporter/shipper of record.
    assert.equal(seamParams.customs.exporter.companyName, "Warehouse");
    assert.equal(
      seamParams.customs.exporter.address.addressLine1,
      "1 Shipper St",
    );
    assert.deepEqual(seamParams.customs.shipperTaxIds, []);
    assert.equal(created.body.documents.length, 1);
    assert.equal(created.body.documents[0].documentType, "COMMERCIAL_INVOICE");
    assert.deepEqual(created.body.documentWarnings, ["post upload failed"]);

    const shipmentId = created.body.shipment.id;
    const listed = await httpRequest(app, {
      method: "GET",
      path: `/v1/documents?shipmentId=${shipmentId}`,
      token,
    });
    assert.equal(listed.status, 200);
    const storedDocuments = listed.body.documents.filter(
      (document: any) => document.documentType === "COMMERCIAL_INVOICE",
    );
    assert.equal(storedDocuments.length, 1);
    const documentId = storedDocuments[0].id;
    assert.equal(storedDocuments[0].contentBase64, undefined);

    const download = await httpRequest(app, {
      method: "GET",
      path: `/v1/document?documentId=${documentId}`,
      token,
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers["content-type"], "application/pdf");
    assert.equal(download.raw.toString("utf8"), "%PDF-1.4 invoice");
  });

  it("returns a non-guaranteed duty & tax estimate", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    let seamParams: any;
    const seam = baseSeam({
      dutyTaxEstimate: async (params: any) => {
        seamParams = params;
        return {
          estimate: {
            nonGuaranteed: true,
            disclaimer: "Estimated duties, taxes and fees are non-guaranteed.",
            currency: "USD",
            duties: [{ amount: 2.5, currency: "USD" }],
            fees: [],
            taxes: [],
            summary: {
              totalDuties: 2.5,
              totalLandedCost: 52.5,
              currency: "USD",
            },
          },
        };
      },
    });
    const res = await httpRequest(makeApp(seam), {
      method: "POST",
      path: "/v1/duty-tax-estimate",
      token,
      body: {
        shipTo: shipmentBody().shipTo,
        serviceType: "INTERNATIONAL_PRIORITY",
        selectedRate: {
          service: "INTERNATIONAL_PRIORITY",
          cost: 12.5,
          currency: "USD",
        },
        customs: validCustoms,
        vendorDetails: vendorDetails(),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.estimate.nonGuaranteed, true);
    assert.equal(seamParams.from.addressLine1, "1 Shipper St");
    assert.equal(seamParams.from.countryCode, "US");
    assert.equal(seamParams.shippingCost.amount, 12.5);
    assert.equal(seamParams.customs.invoiceNumber, "INV-100");
  });

  it("rejects duty estimates with invalid customs details", async () => {
    const token = linksStore.generateToken();
    setState([makeLink(token)]);
    const res = await httpRequest(makeApp(baseSeam()), {
      method: "POST",
      path: "/v1/duty-tax-estimate",
      token,
      body: {
        shipTo: shipmentBody().shipTo,
        customs: {
          ...validCustoms,
          commodities: [{ ...validCustoms.commodities[0], currency: "EUR" }],
        },
        vendorDetails: vendorDetails(),
      },
    });
    assert.equal(res.status, 400);
    assert.ok(
      res.body.details.some(
        (entry: any) => entry.field === "customs.commodities[0].currency",
      ),
    );
  });
});
