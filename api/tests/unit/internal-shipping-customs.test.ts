import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { AddressInfo } from "node:net";
import { createInternalShippingRouter } from "../../src/internal-shipping/routes/internal-shipping.routes";
import type { InternalShippingDeps } from "../../src/internal-shipping/routes/internal-shipping.routes";
import type {
  CarrierLabel,
  ShipmentRequest,
} from "../../src/carriers/carrier-types";

const TEST_KEY = "unit-test-internal-seam-key-0123456789abcdef";

process.env.SLG_INTERNAL_API_ENABLED = "true";
process.env.SLG_INTERNAL_API_KEY = TEST_KEY;

const customs = {
  isDocumentOnly: false,
  shipmentPurpose: "COMMERCIAL",
  invoiceNumber: "INV-1",
  termsOfSale: "DDP",
  currency: "USD",
  commodities: [
    {
      name: "Widget",
      description: "Widget",
      intendedUse: "Resale",
      quantity: 1,
      weightUnits: "LB",
      weight: 1,
      unitPrice: 50,
      currency: "USD",
      hsCode: "6404.11.2030",
      countryOfManufacture: "US",
    },
  ],
  totalCustomsValue: { amount: 50, currency: "USD" },
  dutiesPayment: { paymentType: "SENDER" },
};

function address(countryCode: string) {
  return {
    addressLine1: "1 Main St",
    city: countryCode === "US" ? "Austin" : "Toronto",
    state: countryCode === "US" ? "TX" : "ON",
    zipCode: countryCode === "US" ? "73301" : "M5V2T6",
    countryCode,
  };
}

function shipmentBody(overrides: Record<string, unknown> = {}) {
  return {
    carrier: "fedex",
    from: address("US"),
    to: address("CA"),
    packages: [{ weight: 5 }],
    serviceType: "INTERNATIONAL_PRIORITY",
    labelFormat: "PDF",
    customs,
    ...overrides,
  };
}

interface ServerHandle {
  url: string;
  close(): Promise<void>;
}

function startServer(deps: InternalShippingDeps): Promise<ServerHandle> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
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

async function call(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("rejects customs for non-FedEx carriers with a field error", async () => {
  const server = await startServer({});
  try {
    const response = await call(
      server.url,
      "/internal/shipping/create-shipment",
      shipmentBody({ carrier: "ups", serviceType: "03" }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION_ERROR");
    assert.ok(
      response.body.details.some((entry: any) => entry.field === "customs"),
    );
  } finally {
    await server.close();
  }
});

test("rejects customs on a domestic route with a field error", async () => {
  const server = await startServer({});
  try {
    const response = await call(
      server.url,
      "/internal/shipping/create-shipment",
      shipmentBody({ to: address("US"), serviceType: "FEDEX_GROUND" }),
    );
    assert.equal(response.status, 400);
    assert.ok(
      response.body.details.some(
        (entry: any) =>
          entry.field === "customs" && /international/i.test(entry.message),
      ),
    );
  } finally {
    await server.close();
  }
});

test("passes validated customs and sanitized documents through the seam", async () => {
  let received: ShipmentRequest | undefined;
  const server = await startServer({
    createShipment: async (_carrier, shipment): Promise<CarrierLabel[]> => {
      received = shipment;
      return [
        {
          carrier: "fedex",
          trackingNumber: "TRACK1",
          labelData: Buffer.from("%PDF-1.4").toString("base64"),
          format: "PDF",
          ...({
            documents: [
              {
                documentType: "COMMERCIAL_INVOICE",
                docType: "PDF",
                fileName: "invoice.pdf",
                contentBase64: Buffer.from("doc").toString("base64"),
                source: "FEDEX_GENERATED",
                leakedSecret: "must-not-pass",
              },
            ],
            documentWarnings: ["post upload failed"],
          } as any),
        },
      ];
    },
  });
  try {
    const response = await call(
      server.url,
      "/internal/shipping/create-shipment",
      shipmentBody(),
    );
    assert.equal(response.status, 200);
    assert.ok(received?.customs);
    assert.equal(received?.customs?.invoiceNumber, "INV-1");
    const label = response.body.labels[0];
    assert.equal(label.documents.length, 1);
    assert.equal(label.documents[0].documentType, "COMMERCIAL_INVOICE");
    assert.equal(label.documents[0].leakedSecret, undefined);
    assert.deepEqual(label.documentWarnings, ["post upload failed"]);
  } finally {
    await server.close();
  }
});

test("duty-tax-estimate returns a non-guaranteed estimate", async () => {
  let received: any;
  const server = await startServer({
    estimateDutyTax: async (_carrier, input) => {
      received = input;
      return {
        nonGuaranteed: true,
        guaranteed: false,
        disclaimer: "Estimated duties, taxes and fees are non-guaranteed.",
        currency: "USD",
        duties: [{ amount: 2.5, currency: "USD" }],
        fees: [],
        taxes: [],
        summary: { totalDuties: 2.5, totalLandedCost: 52.5, currency: "USD" },
      };
    },
  });
  try {
    const response = await call(
      server.url,
      "/internal/shipping/duty-tax-estimate",
      {
        carrier: "fedex",
        from: address("US"),
        to: address("CA"),
        serviceType: "INTERNATIONAL_PRIORITY",
        shippingCost: { amount: 10, currency: "USD" },
        customs,
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.estimate.nonGuaranteed, true);
    assert.equal(received.shippingCost.amount, 10);
    assert.equal(received.customs.invoiceNumber, "INV-1");
  } finally {
    await server.close();
  }
});

test("duty-tax-estimate rejects invalid customs with structured details", async () => {
  const server = await startServer({});
  try {
    const response = await call(
      server.url,
      "/internal/shipping/duty-tax-estimate",
      {
        carrier: "fedex",
        from: address("US"),
        to: address("CA"),
        customs: {
          ...customs,
          totalCustomsValue: { amount: 999, currency: "USD" },
        },
      },
    );
    assert.equal(response.status, 400);
    assert.ok(
      response.body.details.some(
        (entry: any) => entry.field === "customs.totalCustomsValue",
      ),
    );
  } finally {
    await server.close();
  }
});
