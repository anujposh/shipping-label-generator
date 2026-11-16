import assert from "node:assert/strict";
import test from "node:test";
import {
  assertInternalSeamConfig,
  assertRequiredCredentials,
  assertSandboxOnlyEnvironment,
  documentsOnlyCustoms,
  effectiveFedexEnvironment,
  internationalShipmentBody,
  parseScenario,
  requiredCredentialKeys,
  usCaCommodityCustoms,
  type Env,
} from "../../scripts/sandbox-label-check";
import { sanitizeCreateShipmentRequest } from "../../src/internal-shipping/internal-shipping.dto";
import {
  __resetForTests,
  __setFedexTransportForTests,
  createShipment,
} from "../../src/carriers/fedex.client";

/** Sandbox-only harness guard/payload tests. No network, no real secrets. */

const SANDBOX_URL = "https://apis-sandbox.fedex.com";

function sandboxEnv(overrides: Env = {}): Env {
  return {
    FEDEX_BASE_URL: SANDBOX_URL,
    CARRIER_SANDBOX: "true",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario selection
// ---------------------------------------------------------------------------

test("scenario defaults to the historic domestic sweep", () => {
  assert.deepEqual(parseScenario([], {}), {
    name: "domestic",
    withEtdUpload: false,
    withDutyEstimate: false,
  });
});

test("scenario flags and environment select international variants", () => {
  assert.equal(
    parseScenario(["--scenario=international-us-ca"], {}).name,
    "international-us-ca",
  );
  assert.equal(
    parseScenario(["--scenario=documents-only"], {}).name,
    "documents-only",
  );
  assert.equal(
    parseScenario([], { SANDBOX_SCENARIO: "documents-only" }).name,
    "documents-only",
  );
  // CLI flag wins over environment.
  assert.equal(
    parseScenario(["--scenario=documents-only"], {
      SANDBOX_SCENARIO: "international-us-ca",
    }).name,
    "documents-only",
  );
});

test("optional ETD/duty flags come from args or environment", () => {
  assert.deepEqual(parseScenario(["--with-etd-upload"], {}), {
    name: "domestic",
    withEtdUpload: true,
    withDutyEstimate: false,
  });
  assert.deepEqual(parseScenario([], { WITH_DUTY_ESTIMATE: "1" }), {
    name: "domestic",
    withEtdUpload: false,
    withDutyEstimate: true,
  });
  assert.deepEqual(
    parseScenario([], { WITH_ETD_UPLOAD: "yes", WITH_DUTY_ESTIMATE: "true" }),
    { name: "domestic", withEtdUpload: true, withDutyEstimate: true },
  );
});

test("unknown explicit scenario is refused rather than silently defaulted", () => {
  assert.throws(
    () => parseScenario(["--scenario=production"], {}),
    /Unknown scenario "production"/,
  );
  assert.throws(
    () => parseScenario([], { SANDBOX_SCENARIO: "live" }),
    /Unknown scenario "live"/,
  );
});

// ---------------------------------------------------------------------------
// Sandbox-only environment guard
// ---------------------------------------------------------------------------

test("sandbox FedEx API host passes the guard", () => {
  assert.doesNotThrow(() => assertSandboxOnlyEnvironment(sandboxEnv()));
  assert.equal(effectiveFedexEnvironment(sandboxEnv()).sandbox, true);
});

test("CARRIER_SANDBOX=true without a base URL resolves to the sandbox host", () => {
  const env = { CARRIER_SANDBOX: "true" } as Env;
  assert.equal(
    effectiveFedexEnvironment(env).hostname,
    "apis-sandbox.fedex.com",
  );
  assert.doesNotThrow(() => assertSandboxOnlyEnvironment(env));
});

test("production FedEx API host is refused", () => {
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({ FEDEX_BASE_URL: "https://apis.fedex.com" }),
      ),
    /Refusing non-sandbox FedEx environment/,
  );
});

test("missing sandbox flag and base URL is refused (production default)", () => {
  assert.throws(
    () => assertSandboxOnlyEnvironment({}),
    /Refusing non-sandbox FedEx environment.*apis\.fedex\.com/,
  );
});

test("CARRIER_SANDBOX=false is refused even with a sandbox base URL", () => {
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(sandboxEnv({ CARRIER_SANDBOX: "false" })),
    /CARRIER_SANDBOX must be "true"/,
  );
});

test("non-https or credentialed sandbox URL is refused", () => {
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({ FEDEX_BASE_URL: "http://apis-sandbox.fedex.com" }),
      ),
    /must use https/,
  );
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({
          FEDEX_BASE_URL: "https://user:pass@apis-sandbox.fedex.com",
        }),
      ),
    /must not contain credentials/,
  );
});

test("production-named carrier settings are refused", () => {
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({ FEDEX_PRODUCTION_API_KEY: "prod-key" }),
      ),
    /Production-named carrier setting forbidden: FEDEX_PRODUCTION_API_KEY/,
  );
});

test("document API base defaults are guarded to the sandbox document host", () => {
  // The client's default sandbox document base is
  // https://documentapitest.prod.fedex.com/sandbox/ (see ETD test below).
  assert.doesNotThrow(() =>
    assertSandboxOnlyEnvironment(
      sandboxEnv({
        FEDEX_DOCUMENT_BASE_URL:
          "https://documentapitest.prod.fedex.com/sandbox/",
      }),
    ),
  );
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({
          FEDEX_DOCUMENT_BASE_URL: "https://documentapi.prod.fedex.com/",
        }),
      ),
    /Refusing non-sandbox FEDEX_DOCUMENT_BASE_URL/,
  );
});

test("other carrier hosts must be sandbox hosts when pinned", () => {
  assert.doesNotThrow(() =>
    assertSandboxOnlyEnvironment(
      sandboxEnv({
        UPS_BASE_URL: "https://wwwcie.ups.com",
        USPS_RATE_BASE_URL: "https://apis-tem.usps.com",
        STAMPS_BASE_URL: "https://api.testing.stampsendicia.com",
        STAMPS_SIGNIN_URL: "https://signin.testing.stampsendicia.com",
      }),
    ),
  );
  assert.throws(
    () =>
      assertSandboxOnlyEnvironment(
        sandboxEnv({ UPS_BASE_URL: "https://onlinetools.ups.com" }),
      ),
    /Refusing non-sandbox UPS_BASE_URL/,
  );
});

// ---------------------------------------------------------------------------
// Internal seam guard + credentials
// ---------------------------------------------------------------------------

const seamEnv = (overrides: Env = {}): Env => ({
  SLG_INTERNAL_API_ENABLED: "true",
  SLG_INTERNAL_API_KEY: "unit-test-seam-key-0123456789",
  SLG_INTERNAL_API_BASE_URL: "http://127.0.0.1:4000",
  ...overrides,
});

test("loopback internal seam config passes", () => {
  assert.doesNotThrow(() => assertInternalSeamConfig(seamEnv()));
  assert.doesNotThrow(() =>
    assertInternalSeamConfig(seamEnv({ SLG_INTERNAL_FAKE_CARRIERS: "false" })),
  );
  assert.doesNotThrow(() =>
    assertInternalSeamConfig(
      seamEnv({ SLG_INTERNAL_API_BASE_URL: "http://localhost:4000" }),
    ),
  );
});

test("internal seam guard refuses non-loopback URLs and fake carriers", () => {
  assert.throws(
    () =>
      assertInternalSeamConfig(
        seamEnv({ SLG_INTERNAL_API_BASE_URL: "http://192.168.1.12:4000" }),
      ),
    /must be loopback/,
  );
  assert.throws(
    () =>
      assertInternalSeamConfig(seamEnv({ SLG_INTERNAL_FAKE_CARRIERS: "true" })),
    /SLG_INTERNAL_FAKE_CARRIERS/,
  );
  assert.throws(
    () =>
      assertInternalSeamConfig(seamEnv({ SLG_INTERNAL_API_ENABLED: "false" })),
    /SLG_INTERNAL_API_ENABLED/,
  );
});

test("international scenarios require FedEx credentials only", () => {
  assert.deepEqual(requiredCredentialKeys("documents-only"), [
    "FEDEX_API_KEY",
    "FEDEX_API_SECRET",
    "FEDEX_ACCOUNT_NUMBER",
  ]);
  assert.equal(requiredCredentialKeys("domestic").length, 12);
  assert.doesNotThrow(() =>
    assertRequiredCredentials(
      {
        FEDEX_API_KEY: "k",
        FEDEX_API_SECRET: "s",
        FEDEX_ACCOUNT_NUMBER: "a",
      },
      "international-us-ca",
    ),
  );
  assert.throws(
    () => assertRequiredCredentials({}, "documents-only"),
    /Missing sandbox credential setting: FEDEX_API_KEY/,
  );
});

// ---------------------------------------------------------------------------
// Payload behavior through the real seam validator
// ---------------------------------------------------------------------------

test("US->CA commodity scenario passes seam validation with two commodities and generated documents", () => {
  const body = internationalShipmentBody(
    "international-us-ca",
    "2026-11-10",
    "SLG-SANDBOX-12345678",
  );
  const parsed = sanitizeCreateShipmentRequest(body);
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok ? parsed.details : {}));
  assert.equal(parsed.value.carrier, "fedex");

  const { shipment } = parsed.value;
  assert.equal(shipment.to.countryCode, "CA");
  assert.equal(shipment.from.countryCode, "US");
  assert.equal(shipment.serviceType, "INTERNATIONAL_PRIORITY");
  assert.equal(shipment.packagingType, "YOUR_PACKAGING");

  const customs = shipment.customs;
  assert.ok(customs);
  assert.equal(customs.commodities.length, 2);
  assert.deepEqual(
    customs.commodities.map((commodity) => commodity.hsCode),
    ["853400", "853669"],
  );
  assert.deepEqual(
    customs.commodities.map((commodity) => commodity.intendedUse),
    ["COMMERCIAL", "COMMERCIAL"],
  );
  assert.deepEqual(customs.generatedDocuments, [
    "COMMERCIAL_INVOICE",
    "CERTIFICATE_OF_ORIGIN",
  ]);
  assert.equal(customs.totalCustomsValue?.amount, 95);
  assert.equal(customs.totalCustomsValue?.currency, "USD");
  // Generated documents only: no uploaded documents in the base scenario.
  assert.equal(customs.customsDocuments, undefined);
});

test("documents-only fixture declares 1 USD explicitly, not zero", () => {
  const raw = documentsOnlyCustoms("SLG-SANDBOX-87654321");
  assert.equal(raw.isDocumentOnly, true);
  assert.equal(
    (raw.commodities as unknown[] | undefined) ?? undefined,
    undefined,
  );
  // Synthetic test declaration, required because FedEx rejects zero value.
  assert.deepEqual(raw.totalCustomsValue, { amount: 1, currency: "USD" });

  const parsed = sanitizeCreateShipmentRequest(
    internationalShipmentBody(
      "documents-only",
      "2026-11-10",
      "SLG-SANDBOX-87654321",
    ),
  );
  assert.ok(parsed.ok, JSON.stringify(!parsed.ok ? parsed.details : {}));

  const customs = parsed.value.shipment.customs;
  assert.ok(customs);
  assert.equal(customs.isDocumentOnly, true);
  assert.equal(customs.totalCustomsValue?.amount, 1);
  // Synthesized single line copies the declared value and the real package
  // weight (documents-only fixture package weighs 2 LB, so a hardcoded 1 or 0
  // would be caught here).
  assert.equal(customs.commodities.length, 1);
  assert.equal(customs.commodities[0].quantity, 1);
  assert.equal(customs.commodities[0].unitPrice, 1);
  assert.equal(customs.commodities[0].weight, 2);
  assert.equal(customs.commodities[0].countryOfManufacture, "US");
  assert.deepEqual(customs.generatedDocuments ?? [], []);
});

test("documents-only zero declared value is rejected by the seam validator", () => {
  const body = internationalShipmentBody(
    "documents-only",
    "2026-11-10",
    "SLG-SANDBOX-ZERO",
  );
  (body.customs as Record<string, unknown>).totalCustomsValue = {
    amount: 0,
    currency: "USD",
  };
  const rejected = sanitizeCreateShipmentRequest(body);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.ok(
      (rejected.details ?? []).some(
        (entry) =>
          entry.field === "customs.totalCustomsValue" &&
          /positive amount/i.test(entry.message),
      ),
      JSON.stringify(rejected.details),
    );
  }
});

// ---------------------------------------------------------------------------
// FedEx ETD sandbox document host (default wiring)
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  body: any;
}

const PDF_BASE64 = Buffer.from("%PDF-1.4 fake label").toString("base64");

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installTransport(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  __resetForTests();
  __setFedexTransportForTests((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    requests.push({
      url,
      body: rawBody?.trimStart().startsWith("{")
        ? JSON.parse(rawBody)
        : rawBody,
    });

    if (url.endsWith("/oauth/token")) {
      return jsonResponse({ access_token: "token-1", expires_in: 3600 });
    }
    if (url.includes("documents/v1/etds/encodedmultiupload")) {
      return jsonResponse({
        output: {
          documentResponses: [
            {
              fileReferenceId: "ref-1",
              metaData: {
                documentType: "COMMERCIAL_INVOICE",
                docId: "DOC-1",
              },
            },
          ],
        },
      });
    }
    if (url.includes("ship/v1/shipments")) {
      return jsonResponse({
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
      });
    }
    throw new Error(`Unexpected FedEx call: ${url}`);
  }) as typeof fetch);
  return requests;
}

function etdShipment() {
  return {
    from: {
      addressLine1: "4120 Bingham Ave",
      city: "St. Louis",
      state: "MO",
      zipCode: "63116",
      countryCode: "US",
      companyName: "SLG Sandbox Test",
      contactName: "Sample Shipper",
      contactPhone: "3145551234",
    },
    to: {
      addressLine1: "100 Queen St W",
      city: "Toronto",
      state: "ON",
      zipCode: "M5H2N2",
      countryCode: "CA",
      companyName: "SLG Sandbox Test",
      contactName: "Sample Recipient",
      contactPhone: "4165550100",
    },
    packages: [{ weight: 5, length: 10, width: 8, height: 4 }],
    serviceType: "INTERNATIONAL_PRIORITY",
    packagingType: "YOUR_PACKAGING",
    labelFormat: "PDF" as const,
    shipDate: "2026-11-10",
    yourReference: "SLG-SANDBOX-ETD",
    customs: {
      shipmentPurpose: "COMMERCIAL",
      invoiceNumber: "INV-ETD",
      shipmentReference: "SLG-SANDBOX-ETD",
      termsOfSale: "DDP",
      currency: "USD",
      totalCustomsValue: { amount: 95, currency: "USD" },
      dutiesPayment: { paymentType: "SENDER" },
      commodities: [
        {
          name: "Printed Circuit Board Assembly",
          description: "Synthetic sandbox PCB assembly",
          intendedUse: "COMMERCIAL",
          quantity: 2,
          quantityUnits: "EA",
          unitPrice: 25,
          currency: "USD",
          weight: 2,
          weightUnits: "LB",
          hsCode: "853400",
          countryOfManufacture: "US",
          purpose: "BUSINESS",
        },
      ],
      customsDocuments: {
        mode: "PRE_SHIPMENT",
        uploads: [
          {
            fileName: "commercial-invoice-upload.pdf",
            contentType: "application/pdf",
            shipDocumentType: "COMMERCIAL_INVOICE",
            contentBase64: Buffer.from("%PDF-1.4 upload").toString("base64"),
          },
        ],
      },
    },
  };
}

test("default sandbox ETD upload base is https://documentapitest.prod.fedex.com/sandbox/", async () => {
  const saved = {
    FEDEX_API_KEY: process.env.FEDEX_API_KEY,
    FEDEX_API_SECRET: process.env.FEDEX_API_SECRET,
    FEDEX_ACCOUNT_NUMBER: process.env.FEDEX_ACCOUNT_NUMBER,
    FEDEX_BASE_URL: process.env.FEDEX_BASE_URL,
    FEDEX_DOCUMENT_BASE_URL: process.env.FEDEX_DOCUMENT_BASE_URL,
    CARRIER_SANDBOX: process.env.CARRIER_SANDBOX,
  };

  process.env.FEDEX_API_KEY = "test-fedex-key";
  process.env.FEDEX_API_SECRET = "test-fedex-secret";
  process.env.FEDEX_ACCOUNT_NUMBER = "test-fedex-account";
  process.env.FEDEX_BASE_URL = SANDBOX_URL;
  process.env.CARRIER_SANDBOX = "true";
  delete process.env.FEDEX_DOCUMENT_BASE_URL;

  const requests = installTransport();
  try {
    const labels = await createShipment(etdShipment() as never);

    const uploads = requests.filter((request) =>
      request.url.includes("documents/v1/etds/encodedmultiupload"),
    );
    assert.equal(uploads.length, 1, "exactly one ETD upload attempt");
    const uploadUrl = new URL(uploads[0].url);
    assert.equal(uploadUrl.protocol, "https:");
    assert.equal(uploadUrl.hostname, "documentapitest.prod.fedex.com");
    assert.ok(uploadUrl.pathname.startsWith("/sandbox/"));
    assert.ok(
      uploads[0].url.startsWith(
        "https://documentapitest.prod.fedex.com/sandbox/",
      ),
    );

    // No shipment write duplication and no production document host contact.
    assert.equal(
      requests.filter((request) => request.url.includes("ship/v1/shipments"))
        .length,
      1,
      "exactly one shipment write",
    );
    assert.ok(
      requests.every(
        (request) =>
          new URL(request.url).hostname !== "documentapi.prod.fedex.com",
      ),
    );

    assert.equal(labels.length, 1);
    assert.equal(labels[0].labelData, PDF_BASE64);
    assert.equal(labels[0].documents?.[0].uploadStatus, "ATTACHED");
  } finally {
    __setFedexTransportForTests(null);
    __resetForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
