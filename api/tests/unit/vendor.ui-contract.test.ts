import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { AddressInfo } from "node:net";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { createSeamClient } from "../../src/carriers/seam-client";
import { createInternalShippingRouter } from "../../src/internal-shipping/routes/internal-shipping.routes";
import type { InternalShippingDeps } from "../../src/internal-shipping/routes/internal-shipping.routes";
import { toFedexCustomsMapping } from "../../src/carriers/customs";
import type {
  CustomsDetails,
  ShipmentRequest,
} from "../../src/carriers/carrier-types";
import { fakeKnex } from "./fake-knex";
import * as dbModule from "../../src/db";
import * as linksStore from "../../src/store/links.store";

const TEST_KEY = "ui-contract-seam-key-0123456789abcdef";
process.env.SLG_INTERNAL_API_ENABLED = "true";
process.env.SLG_INTERNAL_API_KEY = TEST_KEY;

function isoFuture(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * The EXACT browser payload shape produced by `app/src/lib/customs.ts`:
 *  - tax ids use `tinType`
 *  - documents use `{etdEnabled, uploadTiming, generatedTypes, uploads}`
 *  - charges use `taxesOrMiscellaneous`
 *  - commodities carry `name` + `intendedUse`
 */
function exactUiCustoms(): Record<string, unknown> {
  return {
    isDocumentOnly: false,
    shipmentPurpose: "COMMERCIAL",
    invoiceNumber: "INV-UI-1",
    shipmentReference: "SO-UI-1",
    termsOfSale: "DDP",
    currency: "USD",
    commodities: [
      {
        name: "Widget",
        description: "Widget description",
        intendedUse: "Resale",
        hsCode: "6404.11.2030",
        countryOfManufacture: "US",
        quantity: 2,
        quantityUnits: "EA",
        weight: 5,
        weightUnits: "LB",
        unitPrice: 50,
        currency: "USD",
        purpose: "BUSINESS",
      },
    ],
    totalCustomsValue: { amount: 100, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    shipperTaxIds: [{ number: "EIN123", tinType: "BUSINESS_NATIONAL" }],
    recipientTaxIds: [{ number: "GST999", tinType: "PERSONAL_NATIONAL" }],
    charges: {
      taxesOrMiscellaneous: { amount: 2.5, currency: "USD" },
    },
    documents: {
      etdEnabled: true,
      uploadTiming: "PRE_SHIPMENT",
      generatedTypes: ["COMMERCIAL_INVOICE", "USMCA_CERTIFICATION_OF_ORIGIN"],
      uploads: [
        {
          fileName: "invoice.pdf",
          contentType: "application/pdf",
          shipDocumentType: "COMMERCIAL_INVOICE",
          contentBase64: Buffer.from("%PDF-1.4 invoice").toString("base64"),
        },
      ],
    },
  };
}

function uiShipmentBody(
  customs: Record<string, unknown> = exactUiCustoms(),
): Record<string, unknown> {
  return {
    shipTo: {
      addressLine1: "2 Recipient St",
      city: "Toronto",
      state: "ON",
      zipCode: "M5V2T6",
      countryCode: "CA",
      contactName: "Recipient",
      contactPhone: "4165550100",
    },
    packages: [{ weight: 10, length: 10, width: 8, height: 4 }],
    carrier: "fedex",
    serviceType: "INTERNATIONAL_PRIORITY",
    labelFormat: "PDF",
    reference: "UI-REF-1",
    // Shared frontend/backend vendor identity contract.
    vendorDetails: {
      companyName: "UI Shipper LLC",
      contactName: "Shipper Person",
      contactEmail: "shipper@example.com",
      contactPhone: "5125550100",
      addressLine1: "1 Shipper St",
      city: "Austin",
      state: "TX",
      zipCode: "73301",
      countryCode: "US",
      taxIds: [{ number: "EIN123", tinType: "BUSINESS_NATIONAL" }],
    },
    customs,
  };
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
    created_at: new Date().toISOString(),
  };
}

async function request(
  app: express.Express,
  opts: { method: string; path: string; token?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const req = http.request(
        {
          host: "127.0.0.1",
          port: addr.port,
          path: opts.path,
          method: opts.method,
          headers: {
            "content-type": "application/json",
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            server.close();
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          });
        },
      );
      req.on("error", (error) => {
        server.close();
        reject(error);
      });
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  });
}

async function startSeam(deps: InternalShippingDeps): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "40mb" }));
  app.use("/internal/shipping", createInternalShippingRouter(deps));
  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, "127.0.0.1", () => resolve(created));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("exact browser UI customs contract", () => {
  let realDb: typeof dbModule.db;

  before(() => {
    realDb = dbModule.db;
  });

  after(() => {
    dbModule.setDb(realDb);
  });

  it("traverses public Zod → vendor → seam sanitize → customs → FedEx mapping", async () => {
    const token = linksStore.generateToken();
    dbModule.setDb(
      fakeKnex({ rows: [makeLink(token)] }) as unknown as typeof dbModule.db,
    );

    // --- Seam boundary: capture the shipment AFTER seam DTO sanitization.
    let seamShipment: ShipmentRequest | undefined;
    const seamDeps: InternalShippingDeps = {
      createShipment: async (_carrier, shipment) => {
        seamShipment = shipment;
        return [
          {
            carrier: "fedex",
            trackingNumber: "TRACK-UI-1",
            labelData: Buffer.from("%PDF-1.4 label").toString("base64"),
            format: "PDF",
            documents: [
              {
                documentType: "COMMERCIAL_INVOICE",
                docType: "PDF",
                fileName: "COMMERCIAL_INVOICE-TRACK-UI-1.pdf",
                contentBase64:
                  Buffer.from("%PDF-1.4 invoice").toString("base64"),
                source: "FEDEX_GENERATED",
              },
            ],
          },
        ];
      },
    };
    const seam = await startSeam(seamDeps);
    try {
      const seamClient = createSeamClient({
        baseUrl: seam.url,
        apiKey: TEST_KEY,
      });
      const vendorApp = express();
      vendorApp.use((req, _res, next) => {
        req.requestId = `req-${Math.random().toString(36).slice(2)}`;
        next();
      });
      vendorApp.use(express.json({ limit: "40mb" }));
      vendorApp.use("/v1", createVendorRouter({ seamClient }));

      const response = await request(vendorApp, {
        method: "POST",
        path: "/v1/shipment",
        token,
        body: uiShipmentBody(),
      });

      // Stage 1+2: public Zod accepted the exact UI shape; vendor validation
      // passed it to the seam rather than rejecting `documents`/`tinType`.
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok(seamShipment?.customs, "seam received customs");
      const customs = seamShipment.customs as CustomsDetails;

      // Stage 3: seam sanitize normalized the UI document shape.
      assert.equal(customs.customsDocuments?.mode, "PRE_SHIPMENT");
      assert.equal(customs.customsDocuments?.uploads.length, 1);
      assert.deepEqual(customs.generatedDocuments, [
        "COMMERCIAL_INVOICE",
        "USMCA_CERTIFICATION_OF_ORIGIN",
      ]);
      assert.deepEqual(customs.shipperTaxIds, [
        { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
      ]);
      // Shared vendorDetails identity is forced onto the exporter/shipper.
      assert.equal(customs.exporter?.companyName, "UI Shipper LLC");
      assert.equal(customs.exporter?.contactName, "Shipper Person");
      assert.equal(customs.exporter?.contactEmail, "shipper@example.com");
      assert.equal(customs.exporter?.address?.addressLine1, "1 Shipper St");
      assert.equal(customs.exporter?.address?.countryCode, "US");
      assert.deepEqual(customs.exporter?.taxIds, [
        { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
      ]);
      assert.deepEqual(customs.commodities[0], {
        name: "Widget",
        description: "Widget description",
        intendedUse: "Resale",
        quantity: 2,
        quantityUnits: "EA",
        weight: 5,
        weightUnits: "LB",
        unitPrice: 50,
        currency: "USD",
        hsCode: "6404.11.2030",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      });
      assert.deepEqual(customs.charges, {
        taxesOrMiscellaneous: { amount: 2.5, currency: "USD" },
      });

      // Documents persisted on the public response (metadata only).
      assert.equal(response.body.documents.length, 1);
      assert.equal(
        response.body.documents[0].documentType,
        "COMMERCIAL_INVOICE",
      );
      assert.equal(response.body.documents[0].contentBase64, undefined);

      // Stage 4: FedEx wire mapping from the seam-sanitized value.
      const mapping = toFedexCustomsMapping(customs);
      const detail = mapping.customsClearanceDetail as Record<string, any>;
      assert.deepEqual(detail.commercialInvoice.taxesOrMiscellaneousCharge, {
        amount: 2.5,
        currency: "USD",
      });
      assert.equal(
        detail.commercialInvoice.taxesOrMiscellaneousChargeType,
        "OTHER",
      );
      assert.equal(detail.commodities[0].name, "Widget");
      assert.equal(
        detail.commodities[0].description,
        "Widget description — Resale",
      );
      assert.equal(detail.commodities[0].harmonizedCode, "6404.11.2030");
      assert.deepEqual(mapping.shipperTins, [
        { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
      ]);
      // tinType OTHER never reaches the wire; every type is official.
      assert.equal(
        (mapping.shipperTins ?? []).some((tin) => tin.tinType === "OTHER"),
        false,
      );
    } finally {
      await seam.close();
    }
  });

  it("returns fieldErrors (Record<path,message>) for OTHER tinType", async () => {
    const token = linksStore.generateToken();
    dbModule.setDb(
      fakeKnex({ rows: [makeLink(token)] }) as unknown as typeof dbModule.db,
    );
    const seam = await startSeam({
      createShipment: async () => {
        throw new Error("must not reach carrier");
      },
    });
    try {
      const vendorApp = express();
      vendorApp.use((req, _res, next) => {
        req.requestId = `req-${Math.random().toString(36).slice(2)}`;
        next();
      });
      vendorApp.use(express.json({ limit: "40mb" }));
      vendorApp.use(
        "/v1",
        createVendorRouter({
          seamClient: createSeamClient({ baseUrl: seam.url, apiKey: TEST_KEY }),
        }),
      );

      // Browser shipper identity is ignored now; recipient tins still must
      // use the official FedEx enum, so keep the OTHER rejection coverage.
      const customs = exactUiCustoms();
      customs.recipientTaxIds = [{ number: "GST999", tinType: "OTHER" }];
      const response = await request(vendorApp, {
        method: "POST",
        path: "/v1/shipment",
        token,
        body: uiShipmentBody(customs),
      });

      assert.equal(response.status, 400);
      assert.equal(response.body.code, "VALIDATION_ERROR");
      assert.equal(
        response.body.fieldErrors["customs.recipientTaxIds[0].tinType"],
        "tinType OTHER is not supported by FedEx; choose PERSONAL_NATIONAL, PERSONAL_STATE, FEDERAL, BUSINESS_NATIONAL, BUSINESS_STATE or BUSINESS_UNION",
      );
      assert.ok(Array.isArray(response.body.details));
    } finally {
      await seam.close();
    }
  });
});
