import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import knexFactory from "knex";
import path from "node:path";
import type { Knex } from "knex";
import { createVendorRouter } from "../../src/routes/vendor.routes";
import { createAdminRouter } from "../../src/routes/admin.routes";
import { setDb } from "../../src/db";
import * as documentsStore from "../../src/store/documents.store";

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
          const chunks: Buffer[] = [];
          const contentType = res.headers["content-type"] ?? "";
          const isBinary =
            contentType.startsWith("application/pdf") ||
            contentType.startsWith("application/octet-stream") ||
            contentType.startsWith("image/") ||
            contentType.startsWith("text/plain");
          res.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          res.on("end", () => {
            server.close(() => {
              const data = Buffer.concat(chunks);
              let parsed: unknown;
              if (isBinary) {
                parsed = data;
              } else {
                try {
                  parsed =
                    data.length > 0 ? JSON.parse(data.toString("utf8")) : null;
                } catch {
                  parsed = data.toString("utf8");
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

describe("vendor international integration", () => {
  const databaseUrl = process.env.DATABASE_URL;
  let knex: knexFactory.Knex;

  before(async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for integration tests");
    }
    knex = knexFactory({ client: "pg", connection: databaseUrl });
    setDb(knex);
    await rollbackMigrations(knex);
    await runMigrations(knex);
  });

  after(async () => {
    if (knex) {
      await rollbackMigrations(knex);
      await knex.destroy();
    }
  });

  function makeAdminApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    app.use(express.json());
    app.use("/admin/v1", createAdminRouter());
    return app;
  }

  async function createVendorAndLink(
    adminApp: express.Express,
    country = "US",
  ) {
    const vendorRes = await request(adminApp, {
      method: "POST",
      path: "/admin/v1/vendors",
      token: adminToken(),
      body: { name: "International Vendor", contactEmail: "v@endor.test" },
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
        maxUses: 2,
        shipFrom: {
          name: "WH",
          street: "123 Main",
          city: "City",
          state: "ST",
          zip: "12345",
          country,
        },
      },
    });
    assert.equal(linkRes.status, 201);
    return { vendorId, token: linkRes.body.token };
  }

  function fakeSeamClient(
    options: {
      documents?: Array<{
        documentType: string;
        docType: string;
        fileName: string;
        contentBase64: string;
        source: "FEDEX_GENERATED" | "UPLOADED";
        uploadStatus?: "UPLOADED" | "ATTACHED" | "FAILED";
      }>;
      dutyEstimate?: Record<string, unknown>;
    } = {},
  ) {
    return {
      getServices: async (carrier: "fedex" | "ups" | "usps" | "stamps") => ({
        carrier,
        services: [],
      }),
      rateQuote: async () => ({
        rates: [
          {
            carrier: "fedex" as const,
            service: "INTERNATIONAL_PRIORITY",
            cost: 45,
            currency: "USD",
          },
        ],
      }),
      createShipment: async () => ({
        labels: [
          {
            carrier: "fedex" as const,
            trackingNumber: "INTLTRACK",
            labelData: Buffer.from("%PDF-1.4").toString("base64"),
            format: "PDF" as const,
            environment: "sandbox" as const,
            documents: options.documents ?? [],
          },
        ],
      }),
      dutyTaxEstimate: async () => ({
        estimate: {
          nonGuaranteed: true as const,
          guaranteed: false as const,
          disclaimer: "Estimated duties, taxes and fees are non-guaranteed.",
          currency: "USD",
          duties: [],
          fees: [],
          taxes: [],
          summary: { totalDuties: 3.25, currency: "USD" },
          ...(options.dutyEstimate ?? {}),
        },
      }),
    };
  }

  const usCaCustoms = {
    shipmentPurpose: "COMMERCIAL",
    invoiceNumber: "INV-INT-1",
    shipmentReference: "SO-INT-1",
    termsOfSale: "DDP",
    currency: "USD",
    commodities: [
      {
        name: "Widget",
        description: "Widget description",
        intendedUse: "Resale",
        quantity: 2,
        quantityUnits: "EA",
        weight: 2,
        weightUnits: "LB",
        unitPrice: 25,
        currency: "USD",
        hsCode: "6404.11.2030",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
      {
        name: "Gadget",
        description: "Gadget description",
        intendedUse: "Resale",
        quantity: 1,
        quantityUnits: "EA",
        weight: 3,
        weightUnits: "LB",
        unitPrice: 15,
        currency: "USD",
        hsCode: "8504.40.9510",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
    ],
    totalCustomsValue: { amount: 65, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    documents: {
      etdEnabled: true,
      uploadTiming: "PRE_SHIPMENT",
      generatedTypes: ["COMMERCIAL_INVOICE", "CERTIFICATE_OF_ORIGIN"],
      uploads: [],
    },
  };

  const documentsOnlyCustoms = {
    isDocumentOnly: true,
    documentDescription: "Technical manuals",
    shipmentPurpose: "NOT_COMMERCIAL",
    invoiceNumber: "DOC-ONLY-1",
    shipmentReference: "SO-DOC-1",
    termsOfSale: "DDP",
    currency: "USD",
    // FedEx sandbox requires a positive declared value even for documents-only.
    totalCustomsValue: { amount: 1, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
  };

  const caShipTo = {
    addressLine1: "100 Queen St W",
    city: "Toronto",
    state: "ON",
    zipCode: "M5H2N2",
    countryCode: "CA",
  };

  it("persists a multi-commodity FedEx international shipment with customs documents", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);

    const documentContent = Buffer.from("%PDF-1.4 generated invoice").toString(
      "base64",
    );
    const seamClient = fakeSeamClient({
      documents: [
        {
          documentType: "COMMERCIAL_INVOICE",
          docType: "PDF",
          fileName: "COMMERCIAL_INVOICE-INTLTRACK.pdf",
          contentBase64: documentContent,
          source: "FEDEX_GENERATED",
        },
        {
          documentType: "CERTIFICATE_OF_ORIGIN",
          docType: "PDF",
          fileName: "CERTIFICATE_OF_ORIGIN-INTLTRACK.pdf",
          contentBase64: Buffer.from("%PDF-1.4 certificate").toString("base64"),
          source: "FEDEX_GENERATED",
        },
      ],
    });

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 5 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: usCaCustoms,
      },
    });
    assert.equal(shipmentRes.status, 201, JSON.stringify(shipmentRes.body));
    assert.equal(shipmentRes.body.shipment.carrier, "fedex");
    assert.equal(
      shipmentRes.body.shipment.serviceType,
      "INTERNATIONAL_PRIORITY",
    );
    assert.equal(
      Array.isArray(shipmentRes.body.documents) &&
        shipmentRes.body.documents.length,
      2,
    );

    const shipmentId = shipmentRes.body.shipment.id;
    const documentIds = shipmentRes.body.documents.map((d: any) => d.id);

    // Customs snapshot persisted.
    const { getShipmentById } = await import("../../src/store/shipments.store");
    const shipment = await getShipmentById(shipmentId);
    assert.ok(shipment);
    assert.ok(shipment.customs);
    assert.equal((shipment.customs as any).shipmentPurpose, "COMMERCIAL");
    assert.equal((shipment.customs as any).commodities.length, 2);

    // Documents persisted and listable.
    const listRes = await request(vendorApp, {
      method: "GET",
      path: `/v1/documents?shipmentId=${shipmentId}`,
      token,
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.documents.length, 2);
    assert.ok(
      listRes.body.documents.some(
        (d: any) => d.documentType === "COMMERCIAL_INVOICE",
      ),
    );
    assert.ok(
      listRes.body.documents.some(
        (d: any) => d.documentType === "CERTIFICATE_OF_ORIGIN",
      ),
    );

    // Metadata must round-trip through the slg_documents migration columns.
    const commercialInvoiceDoc = listRes.body.documents.find(
      (d: any) => d.documentType === "COMMERCIAL_INVOICE",
    );
    assert.ok(commercialInvoiceDoc);
    assert.equal(commercialInvoiceDoc.source, "FEDEX_GENERATED");
    assert.equal(commercialInvoiceDoc.docType, "PDF");
    assert.equal(
      commercialInvoiceDoc.fileName,
      "COMMERCIAL_INVOICE-INTLTRACK.pdf",
    );
    assert.equal(commercialInvoiceDoc.shipmentId, shipmentId);
    assert.ok(commercialInvoiceDoc.labelId);

    // Document download returns the right bytes.
    const downloadRes = await request(vendorApp, {
      method: "GET",
      path: `/v1/document?documentId=${documentIds[0]}`,
      token,
    });
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers["content-type"], "application/pdf");
    assert.ok(
      String(downloadRes.headers["content-disposition"]).includes(
        "COMMERCIAL_INVOICE-INTLTRACK.pdf",
      ),
    );
    assert.ok(Buffer.isBuffer(downloadRes.body));
    assert.equal(
      (downloadRes.body as Buffer).toString("base64"),
      documentContent,
    );

    // Label download still works.
    const labelRes = await request(vendorApp, {
      method: "GET",
      path: "/v1/label.pdf",
      token,
    });
    assert.equal(labelRes.status, 200);
    assert.equal(labelRes.headers["content-type"], "application/pdf");
  });

  it("rejects cross-link document IDOR", async () => {
    const adminApp = makeAdminApp();
    const { token: tokenA } = await createVendorAndLink(adminApp);
    const { token: tokenB } = await createVendorAndLink(adminApp);

    const seamClient = fakeSeamClient({
      documents: [
        {
          documentType: "COMMERCIAL_INVOICE",
          docType: "PDF",
          fileName: "CI.pdf",
          contentBase64: Buffer.from("%PDF-1.4").toString("base64"),
          source: "FEDEX_GENERATED",
        },
      ],
    });

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token: tokenA,
      body: {
        shipTo: caShipTo,
        // Must be at least the customs commodity weight (5 LB) or validation
        // rejects the shipment before the IDOR checks can run.
        packages: [{ weight: 5 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: usCaCustoms,
      },
    });
    assert.equal(shipmentRes.status, 201);
    const documentId = shipmentRes.body.documents[0].id;

    // Token B must not be able to list A's shipment documents.
    const listRes = await request(vendorApp, {
      method: "GET",
      path: `/v1/documents?shipmentId=${shipmentRes.body.shipment.id}`,
      token: tokenB,
    });
    assert.equal(listRes.status, 404);

    // Token B must not be able to download A's document.
    const downloadRes = await request(vendorApp, {
      method: "GET",
      path: `/v1/document?documentId=${documentId}`,
      token: tokenB,
    });
    assert.equal(downloadRes.status, 404);
  });

  it("supports documents-only FedEx international shipments", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 1 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: documentsOnlyCustoms,
      },
    });
    assert.equal(shipmentRes.status, 201, JSON.stringify(shipmentRes.body));
    assert.equal(shipmentRes.body.shipment.carrier, "fedex");
    assert.deepEqual(shipmentRes.body.documents, []);

    const shipmentId = shipmentRes.body.shipment.id;
    const { getShipmentById } = await import("../../src/store/shipments.store");
    const shipment = await getShipmentById(shipmentId);
    assert.ok(shipment);
    assert.equal((shipment.customs as any).isDocumentOnly, true);
    assert.equal(
      (shipment.customs as any).documentDescription,
      "Technical manuals",
    );
    // Declared value must round-trip as a positive 1 USD customs total.
    assert.equal((shipment.customs as any).totalCustomsValue.amount, 1);
    assert.equal((shipment.customs as any).totalCustomsValue.currency, "USD");

    // Documents-only shipments persist one synthetic 1 USD line (quantity 1).
    // FedEx maps its customsValue as quantity * unitPrice, so this line must
    // yield 1 USD rather than the old zero-value placeholder.
    const documentOnlyCommodities = (shipment.customs as any).commodities;
    assert.equal(documentOnlyCommodities.length, 1);
    assert.equal(documentOnlyCommodities[0].name, "Documents");
    assert.equal(documentOnlyCommodities[0].quantity, 1);
    assert.equal(documentOnlyCommodities[0].unitPrice, 1);
    assert.equal(documentOnlyCommodities[0].currency, "USD");
    assert.equal(
      documentOnlyCommodities[0].quantity *
        documentOnlyCommodities[0].unitPrice,
      1,
    );
    assert.equal(documentOnlyCommodities[0].countryOfManufacture, "US");
  });

  it("rejects documents-only FedEx international shipments with zero declared value", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const zeroValueCustoms = {
      ...documentsOnlyCustoms,
      totalCustomsValue: { amount: 0, currency: "USD" },
    };

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 1 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: zeroValueCustoms,
      },
    });
    assert.equal(shipmentRes.status, 400, JSON.stringify(shipmentRes.body));
    assert.equal(shipmentRes.body.code, "VALIDATION_ERROR");
    const fieldErrors = shipmentRes.body.fieldErrors ?? {};
    assert.ok(
      Object.keys(fieldErrors).some((field) =>
        field.includes("customs.totalCustomsValue"),
      ),
      JSON.stringify(shipmentRes.body),
    );
  });

  it("returns a non-guaranteed duty & tax estimate", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const estimateRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/duty-tax-estimate",
      token,
      body: {
        shipTo: caShipTo,
        vendorDetails: testVendorDetails,
        serviceType: "INTERNATIONAL_PRIORITY",
        selectedRate: {
          service: "INTERNATIONAL_PRIORITY",
          cost: 45,
          currency: "USD",
        },
        customs: usCaCustoms,
      },
    });
    assert.equal(estimateRes.status, 200);
    // The seam contract wraps the estimate: `{ estimate: DutyTaxEstimate }`.
    assert.equal(estimateRes.body.estimate.nonGuaranteed, true);
    assert.equal(estimateRes.body.estimate.guaranteed, false);
    assert.ok(estimateRes.body.estimate.disclaimer);
  });

  it("rejects FedEx international shipments without customs", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 2 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
      },
    });
    assert.equal(shipmentRes.status, 400);
    assert.equal(shipmentRes.body.code, "VALIDATION_ERROR");
    assert.equal(
      shipmentRes.body.fieldErrors.customs,
      "customs details are required for FedEx international shipments",
    );
  });

  it("rejects non-FedEx international shipments with customs", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 2 }],
        vendorDetails: testVendorDetails,
        carrier: "ups",
        serviceType: "03",
        customs: usCaCustoms,
      },
    });
    assert.equal(shipmentRes.status, 400);
    assert.equal(shipmentRes.body.code, "VALIDATION_ERROR");
    assert.ok(shipmentRes.body.fieldErrors.customs);
  });

  it("rejects invalid customs totals with field errors", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);
    const seamClient = fakeSeamClient();

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const invalidCustoms = {
      ...usCaCustoms,
      totalCustomsValue: { amount: 999, currency: "USD" },
    };

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 5 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: invalidCustoms,
      },
    });
    assert.equal(shipmentRes.status, 400);
    assert.equal(shipmentRes.body.code, "VALIDATION_ERROR");
    assert.ok(shipmentRes.body.fieldErrors["customs.totalCustomsValue"]);
  });

  it("persists ETD uploaded documents with ATTACHED status", async () => {
    const adminApp = makeAdminApp();
    const { token } = await createVendorAndLink(adminApp);

    const uploadContent = Buffer.from("%PDF-1.4 uploaded invoice").toString(
      "base64",
    );
    const seamClient = fakeSeamClient({
      documents: [
        {
          documentType: "COMMERCIAL_INVOICE",
          docType: "PDF",
          fileName: "invoice-uploaded.pdf",
          contentBase64: uploadContent,
          source: "UPLOADED",
          uploadStatus: "ATTACHED",
        },
      ],
    });

    const vendorApp = express();
    vendorApp.use((req, _res, next) => {
      req.requestId = `req-${Math.random().toString(36).slice(2)}`;
      next();
    });
    vendorApp.use(express.json());
    vendorApp.use("/v1", createVendorRouter({ seamClient }));

    const customsWithUpload = {
      ...usCaCustoms,
      documents: {
        etdEnabled: true,
        uploadTiming: "PRE_SHIPMENT",
        generatedTypes: ["COMMERCIAL_INVOICE"],
        uploads: [
          {
            fileName: "invoice-uploaded.pdf",
            contentType: "application/pdf",
            shipDocumentType: "COMMERCIAL_INVOICE",
            contentBase64: uploadContent,
          },
        ],
      },
    };

    const shipmentRes = await request(vendorApp, {
      method: "POST",
      path: "/v1/shipment",
      token,
      body: {
        shipTo: caShipTo,
        packages: [{ weight: 5 }],
        vendorDetails: testVendorDetails,
        carrier: "fedex",
        serviceType: "INTERNATIONAL_PRIORITY",
        customs: customsWithUpload,
      },
    });
    assert.equal(shipmentRes.status, 201, JSON.stringify(shipmentRes.body));
    const shipmentId = shipmentRes.body.shipment.id;

    const persisted = await documentsStore.listDocumentsByShipment(shipmentId);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].source, "UPLOADED");
    assert.equal(persisted[0].upload_status, "ATTACHED");
  });
});
