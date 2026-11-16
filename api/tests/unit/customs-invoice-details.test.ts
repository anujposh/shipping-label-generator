import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetForTests,
  __setFedexTransportForTests,
  createShipment,
} from "../../src/carriers/fedex.client";
import {
  CUSTOMS_LIMITS,
  toFedexCustomsMapping,
  validateCustomsDetails,
} from "../../src/carriers/customs";
import type {
  CustomsDetails,
  ShipmentRequest,
} from "../../src/carriers/carrier-types";

process.env.FEDEX_API_KEY = "test-fedex-key";
process.env.FEDEX_API_SECRET = "test-fedex-secret";
process.env.FEDEX_ACCOUNT_NUMBER = "test-fedex-account";
process.env.FEDEX_BASE_URL = "http://fedex.test/";
delete process.env.FEDEX_DOCUMENT_BASE_URL;
delete process.env.CARRIER_SANDBOX;

const PDF_BASE64 = Buffer.from("%PDF-1.4 fake").toString("base64");

const CONTEXT = {
  fromCountryCode: "US",
  toCountryCode: "CA",
  packageWeightLb: 100,
};

/** Small valid multi-commodity customs payload (USD, US → CA). */
function validCustoms(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    isDocumentOnly: false,
    shipmentPurpose: "COMMERCIAL",
    invoiceNumber: "INV-1001",
    shipmentReference: "SO-77",
    termsOfSale: "DDP",
    currency: "USD",
    commodities: [
      {
        name: "Widget",
        description: "Widget",
        intendedUse: "Resale",
        quantity: 2,
        quantityUnits: "EA",
        weight: 10,
        weightUnits: "LB",
        unitPrice: 100,
        currency: "USD",
        hsCode: "6404.11.2030",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
      {
        name: "Gadget",
        description: "Gadget",
        intendedUse: "Resale",
        quantity: 1,
        quantityUnits: "PCS",
        weight: 20,
        weightUnits: "LB",
        unitPrice: 50,
        currency: "USD",
        hsCode: "8471.30",
        countryOfManufacture: "US",
      },
    ],
    totalCustomsValue: { amount: 250, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    ...overrides,
  };
}

function validate(input: Record<string, unknown>) {
  return validateCustomsDetails(input, CONTEXT);
}

function validatedValue(input: Record<string, unknown>): CustomsDetails {
  const result = validate(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected valid customs");
  return result.value;
}

// ---------------------------------------------------------------------------
// Validation / wire mapping
// ---------------------------------------------------------------------------

test("maps declarationStatement, specialInstructions, merged comments and explicit originatorName", () => {
  const value = validatedValue(
    validCustoms({
      documentDescription: "Documents enclosed",
      declarationStatement: "Licensed shipment — destination control statement",
      specialInstructions: "Deliver to receiving dock 3",
      originatorName: "Acme Exports",
      comments: ["Handle with care", "Second printed comment"],
      exporter: { companyName: "Exporter Ltd" },
    }),
  );

  assert.equal(
    value.declarationStatement,
    "Licensed shipment — destination control statement",
  );
  assert.equal(value.specialInstructions, "Deliver to receiving dock 3");
  assert.equal(value.originatorName, "Acme Exports");
  assert.deepEqual(value.comments, [
    "Handle with care",
    "Second printed comment",
  ]);

  const detail = toFedexCustomsMapping(value).customsClearanceDetail as Record<
    string,
    any
  >;
  assert.equal(
    detail.commercialInvoice.declarationStatement,
    "Licensed shipment — destination control statement",
  );
  assert.equal(
    detail.commercialInvoice.specialInstructions,
    "Deliver to receiving dock 3",
  );
  assert.equal(detail.commercialInvoice.originatorName, "Acme Exports");
  // documentDescription keeps the first slot; only two comments survive.
  assert.deepEqual(detail.commercialInvoice.comments, [
    "Documents enclosed",
    "Handle with care",
  ]);
});

test("originatorName falls back to exporter company/contact and comments are deduped", () => {
  const fallback = validatedValue(
    validCustoms({ exporter: { companyName: "Exporter Ltd" } }),
  );
  assert.equal(
    (
      toFedexCustomsMapping(fallback).customsClearanceDetail as Record<
        string,
        any
      >
    ).commercialInvoice.originatorName,
    "Exporter Ltd",
  );

  const contactFallback = validatedValue(
    validCustoms({ exporter: { contactName: "Dana Export" } }),
  );
  assert.equal(
    (
      toFedexCustomsMapping(contactFallback).customsClearanceDetail as Record<
        string,
        any
      >
    ).commercialInvoice.originatorName,
    "Dana Export",
  );

  const deduped = validatedValue(
    validCustoms({
      documentDescription: "Same note",
      comments: ["Same note"],
    }),
  );
  assert.deepEqual(
    (
      toFedexCustomsMapping(deduped).customsClearanceDetail as Record<
        string,
        any
      >
    ).commercialInvoice.comments,
    ["Same note"],
  );
});

test("invalid optional invoice fields are rejected with field errors", () => {
  const tooLong = validate(
    validCustoms({
      declarationStatement: "x".repeat(
        CUSTOMS_LIMITS.maxDeclarationStatementChars + 1,
      ),
      specialInstructions: "y".repeat(
        CUSTOMS_LIMITS.maxSpecialInstructionsChars + 1,
      ),
      originatorName: "z".repeat(CUSTOMS_LIMITS.maxOriginatorNameChars + 1),
      comments: ["a", "b", "c"],
      partiesToTransactionAreRelated: "yes",
    }),
  );
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    const fields = tooLong.errors.map((entry) => entry.field);
    assert.ok(fields.includes("customs.declarationStatement"));
    assert.ok(fields.includes("customs.specialInstructions"));
    assert.ok(fields.includes("customs.originatorName"));
    assert.ok(fields.includes("customs.comments"));
    assert.ok(fields.includes("customs.partiesToTransactionAreRelated"));
  }

  const badEntry = validate(validCustoms({ comments: [123] }));
  assert.equal(badEntry.ok, false);
  if (!badEntry.ok) {
    assert.ok(
      badEntry.errors.some((entry) => entry.field === "customs.comments[0]"),
    );
  }
});

test("partiesToTransactionAreRelated maps onto customs clearance detail", () => {
  const related = validatedValue(
    validCustoms({ partiesToTransactionAreRelated: true }),
  );
  assert.equal(related.partiesToTransactionAreRelated, true);
  const detail = toFedexCustomsMapping(related)
    .customsClearanceDetail as Record<string, any>;
  assert.equal(detail.partiesToTransactionAreRelated, true);

  const browserAlias = validatedValue(validCustoms({ relatedParties: true }));
  const browserAliasDetail = toFedexCustomsMapping(browserAlias)
    .customsClearanceDetail as Record<string, any>;
  assert.equal(browserAliasDetail.partiesToTransactionAreRelated, true);

  const unset = validatedValue(validCustoms());
  const unsetDetail = toFedexCustomsMapping(unset)
    .customsClearanceDetail as Record<string, any>;
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      unsetDetail,
      "partiesToTransactionAreRelated",
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// createShipment shipper mapping
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  body: any;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function shipResponse() {
  return {
    output: {
      transactionShipments: [
        {
          masterTrackingNumber: "794953535000",
          shipmentDocuments: [],
          pieceResponses: [
            {
              packageDocuments: [
                {
                  contentType: "LABEL",
                  docType: "PDF",
                  encodedLabel: PDF_BASE64,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function installTransport(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  __resetForTests();
  __setFedexTransportForTests((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    }
    requests.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse());
    }
    return jsonResponse({});
  }) as typeof fetch);
  return requests;
}

function customsFixture(
  overrides: Partial<CustomsDetails> = {},
): CustomsDetails {
  return {
    isDocumentOnly: false,
    shipmentPurpose: "COMMERCIAL",
    invoiceNumber: "INV-1001",
    shipmentReference: "REF-1",
    termsOfSale: "DDP",
    currency: "USD",
    commodities: [
      {
        name: "Widget",
        description: "Widget",
        intendedUse: "Resale",
        quantity: 2,
        quantityUnits: "EA",
        weight: 10,
        weightUnits: "LB",
        unitPrice: 100,
        currency: "USD",
        hsCode: "6404.11.2030",
        countryOfManufacture: "US",
        purpose: "BUSINESS",
      },
    ],
    totalCustomsValue: { amount: 200, currency: "USD" },
    dutiesPayment: { paymentType: "SENDER" },
    shipperTaxIds: [{ number: "EIN123", tinType: "BUSINESS_NATIONAL" }],
    recipientTaxIds: [{ number: "GST999", tinType: "PERSONAL_NATIONAL" }],
    ...overrides,
  };
}

function shipmentFixture(
  overrides: Partial<ShipmentRequest> = {},
): ShipmentRequest {
  return {
    from: {
      addressLine1: "1 Shipper St",
      city: "Austin",
      state: "TX",
      zipCode: "73301",
      countryCode: "US",
      companyName: "Shipper Co",
      contactName: "Shipper",
      contactPhone: "5125550100",
    },
    to: {
      addressLine1: "2 Recipient St",
      city: "Toronto",
      state: "ON",
      zipCode: "M5V2T6",
      countryCode: "CA",
      companyName: "Recipient Co",
      contactName: "Recipient",
      contactPhone: "4165550100",
    },
    packages: [{ weight: 40, length: 10, width: 8, height: 4 }],
    serviceType: "INTERNATIONAL_PRIORITY",
    labelFormat: "PDF",
    shipDate: "2026-11-10",
    packagingType: "YOUR_PACKAGING",
    yourReference: "REF-1",
    poNo: "PO-9",
    ...overrides,
  };
}

test("international shipment uses exporter contact/address while keeping configured credentials", async () => {
  const requests = installTransport();
  const exporter = {
    accountNumber: "EXPORTER-ACCT",
    contactName: "Export Desk",
    companyName: "Exporter Ltd",
    contactPhone: "5125550199",
    contactEmail: "export@example.test",
    address: {
      addressLine1: "9 Export Way",
      city: "Austin",
      state: "TX",
      zipCode: "73301",
      countryCode: "US",
    },
    taxIds: [{ number: "EIN999", tinType: "BUSINESS_NATIONAL" as const }],
  };

  await createShipment(
    shipmentFixture({ customs: customsFixture({ exporter }) }),
  );

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  const requested = ship.body.requestedShipment;

  assert.equal(ship.body.accountNumber.value, "test-fedex-account");
  assert.equal(requested.shipper.contact.personName, "Export Desk");
  assert.equal(requested.shipper.contact.companyName, "Exporter Ltd");
  assert.equal(requested.shipper.contact.phoneNumber, "5125550199");
  assert.equal(requested.shipper.contact.emailAddress, "export@example.test");
  assert.deepEqual(requested.shipper.address.streetLines, ["9 Export Way"]);
  assert.equal(requested.shipper.address.city, "Austin");
  assert.equal(requested.shipper.address.stateOrProvinceCode, "TX");
  assert.equal(requested.shipper.address.postalCode, "73301");
  assert.equal(requested.shipper.address.countryCode, "US");
  assert.deepEqual(requested.shipper.tins, [
    { number: "EIN999", tinType: "BUSINESS_NATIONAL" },
  ]);

  // Payment credentials stay on the configured account, never the exporter.
  assert.equal(requested.shippingChargesPayment.paymentType, "SENDER");
  assert.equal(
    requested.shippingChargesPayment.payor.responsibleParty.accountNumber.value,
    "test-fedex-account",
  );

  // Recipient and existing invoice/reference behavior are untouched.
  assert.equal(requested.recipients[0].contact.companyName, "Recipient Co");
  assert.equal(requested.recipients[0].address.city, "Toronto");
  assert.deepEqual(requested.recipients[0].tins, [
    { number: "GST999", tinType: "PERSONAL_NATIONAL" },
  ]);
  assert.ok(
    requested.customsClearanceDetail.commercialInvoice.customerReferences.some(
      (reference: any) =>
        reference.customerReferenceType === "INVOICE_NUMBER" &&
        reference.value === "INV-1001",
    ),
  );
});

test("international shipment without customs.exporter keeps origin shipper", async () => {
  const requests = installTransport();
  await createShipment(shipmentFixture({ customs: customsFixture() }));

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  const requested = ship.body.requestedShipment;
  assert.equal(requested.shipper.contact.personName, "Shipper");
  assert.equal(requested.shipper.contact.companyName, "Shipper Co");
  assert.equal(requested.shipper.address.streetLines[0], "1 Shipper St");
  assert.equal(requested.shipper.address.city, "Austin");
  assert.equal(ship.body.accountNumber.value, "test-fedex-account");
});

test("domestic shipment shipper block is unchanged and stays customs-free", async () => {
  const requests = installTransport();
  const domestic = shipmentFixture({
    serviceType: "FEDEX_GROUND",
    to: {
      addressLine1: "3 Buyer Ave",
      city: "Dallas",
      state: "TX",
      zipCode: "75201",
      countryCode: "US",
      companyName: "Buyer Co",
      contactName: "Buyer",
      contactPhone: "2145550100",
    },
  });

  await createShipment(domestic);

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  const requested = ship.body.requestedShipment;
  assert.equal(requested.customsClearanceDetail, undefined);
  assert.equal(requested.shipper.contact.personName, "Shipper");
  assert.equal(requested.shipper.contact.companyName, "Shipper Co");
  assert.equal(requested.shipper.contact.phoneNumber, "5125550100");
  assert.equal(requested.shipper.contact.emailAddress, undefined);
  assert.deepEqual(requested.shipper.address.streetLines, ["1 Shipper St"]);
  assert.equal(requested.shipper.address.city, "Austin");
  assert.equal(requested.shipper.address.stateOrProvinceCode, "TX");
  assert.equal(requested.shipper.address.postalCode, "73301");
  assert.equal(requested.shipper.tins, undefined);
  assert.equal(ship.body.accountNumber.value, "test-fedex-account");
});
