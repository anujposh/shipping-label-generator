import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetForTests,
  __setFedexTransportForTests,
  createShipment,
  estimateDutyTax,
} from "../../src/carriers/fedex.client";
import { CarrierValidationError } from "../../src/carriers/carrier-errors";
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedRequest {
  url: string;
  body: any;
}

type Handler = (request: CapturedRequest) => Response | undefined;

function installTransport(handler: Handler): CapturedRequest[] {
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const request = { url, body };
    requests.push(request);
    const response = handler(request);
    if (!response) throw new Error(`Unexpected request ${url}`);
    return response;
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
    shipperTaxIds: [{ tinType: "BUSINESS_NATIONAL", number: "EIN123" }],
    recipientTaxIds: [{ tinType: "PERSONAL_NATIONAL", number: "GST999" }],
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

function shipResponse(options: {
  documents?: Array<Record<string, unknown>>;
  packageDocuments?: Array<Record<string, unknown>>;
}) {
  return {
    output: {
      transactionShipments: [
        {
          masterTrackingNumber: "794953535000",
          shipmentDocuments: options.documents ?? [],
          pieceResponses: [
            {
              packageDocuments: options.packageDocuments ?? [
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

test("domestic shipments keep the existing payload (no customs/ETD)", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse({}));
    }
    return undefined;
  });

  const labels = await createShipment(
    shipmentFixture({
      to: {
        addressLine1: "3 Domestic St",
        city: "Dallas",
        state: "TX",
        zipCode: "75201",
        countryCode: "US",
      },
      serviceType: "FEDEX_GROUND",
    }),
  );

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  assert.equal(ship.body.requestedShipment.customsClearanceDetail, undefined);
  assert.equal(ship.body.requestedShipment.shipmentSpecialServices, undefined);
  assert.equal(
    ship.body.requestedShipment.shippingDocumentSpecification,
    undefined,
  );
  assert.equal(labels[0].labelData, PDF_BASE64);
  assert.equal(labels[0].documents, undefined);
});

test("FICP shipments preserve the service code and create a label", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse({}));
    }
    return undefined;
  });

  const labels = await createShipment(
    shipmentFixture({
      serviceType: "FEDEX_INTERNATIONAL_CONNECT_PLUS",
      packagingType: "FEDEX_PAK",
      customs: customsFixture(),
    }),
  );

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  assert.equal(
    ship.body.requestedShipment.serviceType,
    "FEDEX_INTERNATIONAL_CONNECT_PLUS",
  );
  assert.equal(ship.body.requestedShipment.packagingType, "FEDEX_PAK");
  assert.equal(labels[0].labelData, PDF_BASE64);
});

test("pre-shipment upload attaches documentIds and generates official docs", async () => {
  let uploadCalls = 0;
  const requests = installTransport((request) => {
    if (request.url.includes("documents/v1/etds/encodedmultiupload")) {
      uploadCalls += 1;
      return jsonResponse({
        output: {
          // Live sandbox returns a single object for a one-document upload.
          documentResponses: {
            fileReferenceId: "doc_1",
            metaData: { documentType: "CI", docId: "DOC-1" },
          },
        },
      });
    }
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(
        shipResponse({
          documents: [
            {
              contentType: "COMMERCIAL_INVOICE",
              docType: "PDF",
              encodedLabel: Buffer.from("invoice").toString("base64"),
            },
            {
              contentType: "CERTIFICATE_OF_ORIGIN",
              docType: "PDF",
              // Only-URL document — must not be fabricated into bytes.
              url: "https://example.test/doc",
            },
          ],
          packageDocuments: [
            // A customs document appears first; it must never be taken as label.
            {
              contentType: "COMMERCIAL_INVOICE",
              docType: "PDF",
              encodedLabel: Buffer.from("not-a-label").toString("base64"),
            },
            { contentType: "LABEL", docType: "PDF", encodedLabel: PDF_BASE64 },
          ],
        }),
      );
    }
    return undefined;
  });

  const labels = await createShipment(
    shipmentFixture({
      customs: customsFixture({
        generatedDocuments: ["COMMERCIAL_INVOICE", "CERTIFICATE_OF_ORIGIN"],
        customsDocuments: {
          mode: "PRE_SHIPMENT",
          uploads: [
            {
              fileName: "invoice.pdf",
              contentType: "application/pdf",
              shipDocumentType: "COMMERCIAL_INVOICE",
              contentBase64: Buffer.from("uploaded").toString("base64"),
            },
          ],
        },
      }),
    }),
  );

  assert.equal(uploadCalls, 1);
  const upload = requests.find((request) =>
    request.url.includes("documents/v1/etds/encodedmultiupload"),
  );
  assert.ok(upload);
  assert.equal(upload.body.workflowName, "ETDPreshipment");
  assert.equal(upload.body.carrierCode, "FDXE");
  assert.equal(upload.body.originCountryCode, "US");
  assert.equal(upload.body.destinationCountryCode, "CA");
  assert.equal(upload.body.metaData[0].shipDocumentType, "COMMERCIAL_INVOICE");
  assert.equal(upload.body.metaData[0].contentType, "application/pdf");
  assert.equal(upload.body.metaData[0].fileReferenceId, "doc_1");

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  const requested = ship.body.requestedShipment;
  assert.equal(requested.customsClearanceDetail.isDocumentOnly, false);
  assert.equal(
    requested.customsClearanceDetail.commercialInvoice.shipmentPurpose,
    "COMMERCIAL",
  );
  assert.deepEqual(
    requested.customsClearanceDetail.commercialInvoice.customerReferences,
    [
      { customerReferenceType: "INVOICE_NUMBER", value: "INV-1001" },
      { customerReferenceType: "CUSTOMER_REFERENCE", value: "REF-1" },
    ],
  );
  assert.deepEqual(requested.shipper.tins, [
    { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
  ]);
  assert.deepEqual(requested.recipients[0].tins, [
    { number: "GST999", tinType: "PERSONAL_NATIONAL" },
  ]);
  assert.ok(
    requested.requestedPackageLineItems[0].customerReferences.some(
      (reference: any) =>
        reference.customerReferenceType === "INVOICE_NUMBER" &&
        reference.value === "INV-1001",
    ),
  );
  assert.ok(
    requested.shipmentSpecialServices.specialServiceTypes.includes(
      "ELECTRONIC_TRADE_DOCUMENTS",
    ),
  );
  assert.deepEqual(
    requested.shipmentSpecialServices.etdDetail.attachedDocuments,
    [
      {
        documentId: "DOC-1",
        documentType: "COMMERCIAL_INVOICE",
        documentReference: "REF-1",
      },
    ],
  );
  assert.deepEqual(
    requested.shippingDocumentSpecification.shippingDocumentTypes,
    ["COMMERCIAL_INVOICE", "CERTIFICATE_OF_ORIGIN"],
  );
  assert.deepEqual(
    requested.shippingDocumentSpecification.commercialInvoiceDetail
      .documentFormat,
    { stockType: "PAPER_LETTER", docType: "PDF" },
  );

  assert.equal(labels[0].labelData, PDF_BASE64);
  const documents = labels[0].documents ?? [];
  assert.deepEqual(
    documents.map((document) => [document.source, document.uploadStatus]),
    [
      ["UPLOADED", "ATTACHED"],
      ["FEDEX_GENERATED", undefined],
    ],
  );
  assert.equal(documents[1].documentType, "COMMERCIAL_INVOICE");
  assert.equal(documents[1].docType, "PDF");
  assert.ok(
    labels[0].documentWarnings?.some((warning) =>
      /only a document URL/i.test(warning),
    ),
  );
});

test("USMCA uploads send formCode and FEDEX_GROUND uses FDXG", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("documents/v1/etds/encodedmultiupload")) {
      return jsonResponse({
        output: {
          documentResponses: [
            {
              fileReferenceId: "doc_1",
              metaData: { documentType: "CO", docId: "USMCA-1" },
            },
          ],
        },
      });
    }
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse({}));
    }
    return undefined;
  });

  await createShipment(
    shipmentFixture({
      serviceType: "FEDEX_GROUND",
      customs: customsFixture({
        customsDocuments: {
          mode: "PRE_SHIPMENT",
          uploads: [
            {
              fileName: "usmca.pdf",
              contentType: "application/pdf",
              shipDocumentType: "USMCA_CERTIFICATION_OF_ORIGIN",
              contentBase64: Buffer.from("%PDF-1.4 usmca").toString("base64"),
            },
          ],
        },
      }),
    }),
  );

  const upload = requests.find((request) =>
    request.url.includes("documents/v1/etds/encodedmultiupload"),
  );
  assert.ok(upload);
  assert.equal(upload.body.carrierCode, "FDXG");
  assert.equal(upload.body.metaData[0].formCode, "USMCA");
  assert.equal(
    upload.body.metaData[0].shipDocumentType,
    "USMCA_CERTIFICATION_OF_ORIGIN",
  );

  const ship = requests.find((request) =>
    request.url.includes("ship/v1/shipments"),
  );
  assert.ok(ship);
  // Attach the original request type, never the abbreviated response type.
  assert.equal(
    ship.body.requestedShipment.shipmentSpecialServices.etdDetail
      .attachedDocuments[0].documentType,
    "USMCA_CERTIFICATION_OF_ORIGIN",
  );
});

test("post-shipment upload uses create shipDatestamp", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("documents/v1/etds/encodedmultiupload")) {
      return jsonResponse({
        output: {
          documentResponses: [
            {
              fileReferenceId: "doc_1",
              metaData: { documentType: "CI", docId: "POST-1" },
            },
          ],
        },
      });
    }
    if (request.url.includes("ship/v1/shipments")) {
      const response = shipResponse({});
      (
        response.output.transactionShipments[0] as Record<string, unknown>
      ).shipDatestamp = "2026-11-12";
      return jsonResponse(response);
    }
    return undefined;
  });

  const labels = await createShipment(
    shipmentFixture({
      customs: customsFixture({
        customsDocuments: {
          mode: "POST_SHIPMENT",
          uploads: [
            {
              fileName: "invoice.pdf",
              contentType: "application/pdf",
              shipDocumentType: "COMMERCIAL_INVOICE",
              contentBase64: Buffer.from("uploaded").toString("base64"),
            },
          ],
        },
      }),
    }),
  );

  const upload = requests.find((request) =>
    request.url.includes("documents/v1/etds/encodedmultiupload"),
  );
  assert.ok(upload);
  assert.equal(upload.body.workflowName, "ETDPostshipment");
  assert.equal(upload.body.shipmentDate, "2026-11-12T00:00:00");
  assert.equal(labels[0].documents?.[0].uploadStatus, "UPLOADED");
});

test("post-shipment upload failure still returns the label with a warning", async () => {
  installTransport((request) => {
    if (request.url.includes("documents/v1/etds/encodedmultiupload")) {
      return jsonResponse(
        { errors: [{ code: "ERROR", message: "boom" }] },
        500,
      );
    }
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse({}));
    }
    return undefined;
  });

  const labels = await createShipment(
    shipmentFixture({
      customs: customsFixture({
        customsDocuments: {
          mode: "POST_SHIPMENT",
          uploads: [
            {
              fileName: "invoice.pdf",
              contentType: "application/pdf",
              shipDocumentType: "COMMERCIAL_INVOICE",
              contentBase64: Buffer.from("uploaded").toString("base64"),
            },
          ],
        },
      }),
    }),
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].labelData, PDF_BASE64);
  assert.ok(labels[0].documents?.length);
  assert.equal(labels[0].documents?.[0].uploadStatus, "FAILED");
  const warning = labels[0].documentWarnings?.join(" ") ?? "";
  assert.match(warning, /label was created successfully/i);
  assert.match(warning, /Do not create another shipment/i);
});

test("pre-shipment upload failure aborts before any label request", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("documents/v1/etds/encodedmultiupload")) {
      return jsonResponse(
        { errors: [{ code: "BAD", message: "rejected" }] },
        400,
      );
    }
    if (request.url.includes("ship/v1/shipments")) {
      return jsonResponse(shipResponse({}));
    }
    return undefined;
  });

  await assert.rejects(
    () =>
      createShipment(
        shipmentFixture({
          customs: customsFixture({
            customsDocuments: {
              mode: "PRE_SHIPMENT",
              uploads: [
                {
                  fileName: "invoice.pdf",
                  contentType: "application/pdf",
                  shipDocumentType: "COMMERCIAL_INVOICE",
                  contentBase64: Buffer.from("uploaded").toString("base64"),
                },
              ],
            },
          }),
        }),
      ),
    (error: unknown) =>
      error instanceof CarrierValidationError &&
      /upload failed before the label was created/i.test(error.message),
  );
  assert.equal(
    requests.some((request) => request.url.includes("ship/v1/shipments")),
    false,
  );
});

test("duty & tax estimate uses official fields and stays non-guaranteed", async () => {
  const requests = installTransport((request) => {
    if (request.url.includes("dutytax/v1/estimate")) {
      return jsonResponse({
        output: {
          edtDetails: [
            {
              duties: [{ amount: 4.44, currency: "USD", description: "Duty" }],
              fees: [],
              taxes: [],
              summary: {
                totalDuties: 4.44,
                totalFees: 0,
                totalTaxes: 0,
                totalShippingCosts: 25,
                totalLandedCost: 229.44,
                currency: "USD",
              },
            },
          ],
        },
      });
    }
    return undefined;
  });

  const estimate = await estimateDutyTax({
    from: shipmentFixture().from,
    to: shipmentFixture().to,
    serviceType: "INTERNATIONAL_PRIORITY",
    shippingCost: { amount: 25, currency: "USD" },
    customs: customsFixture(),
  });

  const request = requests.find((entry) =>
    entry.url.includes("dutytax/v1/estimate"),
  );
  assert.ok(request);
  assert.equal(request.body.shipmentPurpose, "FOR_RESALE");
  assert.equal(request.body.commodities[0].unitPrice.currencyCode, "USD");
  assert.equal(request.body.preferredCurrency, "USD");
  assert.equal(estimate.nonGuaranteed, true);
  assert.match(estimate.disclaimer, /non-guaranteed/i);
  assert.equal(estimate.duties[0].amount, 4.44);
});
