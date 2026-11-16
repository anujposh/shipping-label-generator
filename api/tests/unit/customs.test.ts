import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDutyTaxEstimateRequest,
  CUSTOMS_LIMITS,
  isInternationalRoute,
  mapDutyTaxEstimateResponse,
  toFedexCustomsMapping,
  validateCustomsDetails,
  fedexShippingDocumentSpecification,
} from "../../src/carriers/customs";
import type { CustomsDetails } from "../../src/carriers/carrier-types";

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

const context = {
  fromCountryCode: "US",
  toCountryCode: "CA",
  packageWeightLb: 40,
  carrier: "fedex",
};

function validate(body: unknown, ctx = context) {
  return validateCustomsDetails(body, ctx);
}

test("country-based international detection ignores case/whitespace", () => {
  assert.equal(isInternationalRoute("US", "CA"), true);
  assert.equal(isInternationalRoute(" us ", "us"), false);
  assert.equal(isInternationalRoute(undefined, "US"), false);
  assert.equal(isInternationalRoute("US", "GB"), true);
});

test("domestic and non-FedEx customs are rejected with field errors", () => {
  const domestic = validate(validCustoms(), {
    ...context,
    toCountryCode: "US",
  });
  assert.equal(domestic.ok, false);
  if (!domestic.ok) {
    assert.ok(
      domestic.errors.some(
        (entry) =>
          entry.field === "customs" && /international/i.test(entry.message),
      ),
    );
  }

  const nonFedex = validate(validCustoms(), { ...context, carrier: "ups" });
  assert.equal(nonFedex.ok, false);
  if (!nonFedex.ok) {
    assert.ok(nonFedex.errors.some((entry) => entry.field === "customs"));
  }
});

test("documents-only shipments require a positive declared customs value and a description", () => {
  const missingDescription = validate(
    validCustoms({
      isDocumentOnly: true,
      commodities: [],
      totalCustomsValue: { amount: 1, currency: "USD" },
    }),
  );
  assert.equal(missingDescription.ok, false);
  if (!missingDescription.ok) {
    assert.ok(
      missingDescription.errors.some(
        (entry) => entry.field === "customs.documentDescription",
      ),
    );
  }

  // FedEx destination customs rejects zero/null declared value.
  const zeroValue = validate(
    validCustoms({
      isDocumentOnly: true,
      documentDescription: "Signed contracts",
      commodities: [],
      totalCustomsValue: { amount: 0, currency: "USD" },
    }),
  );
  assert.equal(zeroValue.ok, false);
  if (!zeroValue.ok) {
    assert.ok(
      zeroValue.errors.some(
        (entry) =>
          entry.field === "customs.totalCustomsValue" &&
          /positive amount/i.test(entry.message),
      ),
      JSON.stringify(zeroValue.errors),
    );
  }

  const missingValue = validate(
    validCustoms({
      isDocumentOnly: true,
      documentDescription: "Signed contracts",
      commodities: [],
      totalCustomsValue: undefined,
    }),
  );
  assert.equal(missingValue.ok, false);
  if (!missingValue.ok) {
    assert.ok(
      missingValue.errors.some(
        (entry) => entry.field === "customs.totalCustomsValue",
      ),
    );
  }

  const ok = validate(
    validCustoms({
      isDocumentOnly: true,
      documentDescription: "Signed contracts",
      commodities: [],
      totalCustomsValue: { amount: 1, currency: "USD" },
    }),
  );
  assert.equal(ok.ok, true);
});

test("multi-commodity total must match or be rejected as a field error", () => {
  const mismatch = validate(
    validCustoms({ totalCustomsValue: { amount: 999, currency: "USD" } }),
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.ok(
      mismatch.errors.some(
        (entry) =>
          entry.field === "customs.totalCustomsValue" &&
          /does not match/i.test(entry.message),
      ),
    );
  }
});

test("mixed currencies and malformed HS codes are rejected", () => {
  const mixed = validate(
    validCustoms({
      commodities: [
        {
          name: "Widget",
          description: "Widget",
          intendedUse: "Resale",
          quantity: 1,
          weight: 1,
          weightUnits: "LB",
          unitPrice: 250,
          currency: "EUR",
          hsCode: "6404.11.2030",
          countryOfManufacture: "US",
        },
      ],
    }),
  );
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.ok(
      mixed.errors.some(
        (entry) =>
          entry.field === "customs.commodities[0].currency" &&
          /must equal customs.currency/i.test(entry.message),
      ),
    );
  }

  const badHs = validate(
    validCustoms({
      commodities: [
        {
          name: "Widget",
          description: "Widget",
          intendedUse: "Resale",
          quantity: 1,
          weight: 1,
          weightUnits: "LB",
          unitPrice: 250,
          currency: "USD",
          hsCode: "ABC",
          countryOfManufacture: "US",
        },
      ],
    }),
  );
  assert.equal(badHs.ok, false);
  if (!badHs.ok) {
    assert.ok(
      badHs.errors.some(
        (entry) => entry.field === "customs.commodities[0].hsCode",
      ),
    );
  }
});

test("commodity weight above package weight after KG→LB conversion is rejected", () => {
  const tooHeavy = validate(
    validCustoms({
      commodities: [
        {
          name: "Heavy",
          description: "Heavy",
          intendedUse: "Resale",
          quantity: 1,
          weightUnits: "KG",
          weight: 20, // 44.09 lb > 40 lb package weight
          unitPrice: 250,
          currency: "USD",
          hsCode: "8471.30",
          countryOfManufacture: "US",
        },
      ],
    }),
    { ...context, packageWeightLb: 40 },
  );
  assert.equal(tooHeavy.ok, false);
  if (!tooHeavy.ok) {
    assert.ok(
      tooHeavy.errors.some(
        (entry) =>
          entry.field === "customs.commodities" &&
          /exceeds the shipment package weight/i.test(entry.message),
      ),
    );
  }
});

test("third-party duties payor requires account, address and contact", () => {
  const missing = validate(
    validCustoms({ dutiesPayment: { paymentType: "THIRD_PARTY" } }),
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    const fields = missing.errors.map((entry) => entry.field);
    assert.ok(fields.includes("customs.dutiesPayment.payor"));
  }

  const incomplete = validate(
    validCustoms({
      dutiesPayment: {
        paymentType: "THIRD_PARTY",
        payor: { companyName: "Broker Co" },
      },
    }),
  );
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) {
    const fields = incomplete.errors.map((entry) => entry.field);
    assert.ok(fields.includes("customs.dutiesPayment.payor.accountNumber"));
    assert.ok(fields.includes("customs.dutiesPayment.payor.address"));
  }

  const ok = validate(
    validCustoms({
      dutiesPayment: {
        paymentType: "THIRD_PARTY",
        payor: {
          accountNumber: "123456789",
          companyName: "Broker Co",
          address: {
            addressLine1: "1 Broker Way",
            city: "Toronto",
            state: "ON",
            zipCode: "M5V2T6",
            countryCode: "CA",
          },
        },
      },
    }),
  );
  assert.equal(ok.ok, true);
});

test("SENDER/RECIPIENT duties never require a payor account", () => {
  const recipient = validate(
    validCustoms({ dutiesPayment: { paymentType: "RECIPIENT" } }),
  );
  assert.equal(recipient.ok, true);
});

test("US export compliance statement rules", () => {
  const toChina = validate(validCustoms(), {
    ...context,
    toCountryCode: "CN",
  });
  assert.equal(toChina.ok, false);
  if (!toChina.ok) {
    assert.ok(
      toChina.errors.some(
        (entry) => entry.field === "customs.exportComplianceStatement",
      ),
    );
  }

  const highValueCanada = validate(
    validCustoms({
      commodities: [
        {
          name: "Machine",
          description: "Machine",
          intendedUse: "Resale",
          quantity: 1,
          weight: 1,
          weightUnits: "LB",
          unitPrice: 2600,
          currency: "USD",
          hsCode: "8471.30",
          countryOfManufacture: "US",
        },
      ],
      totalCustomsValue: { amount: 2600, currency: "USD" },
    }),
  );
  assert.equal(highValueCanada.ok, false);

  const withStatement = validate(
    validCustoms({
      exportComplianceStatement: "AESX20220714987654",
      commodities: [
        {
          name: "Machine",
          description: "Machine",
          intendedUse: "Resale",
          quantity: 1,
          weight: 1,
          weightUnits: "LB",
          unitPrice: 2600,
          currency: "USD",
          hsCode: "8471.30",
          countryOfManufacture: "US",
        },
      ],
      totalCustomsValue: { amount: 2600, currency: "USD" },
    }),
  );
  assert.equal(withStatement.ok, true);
});

test("CA export statement applies only outside US/PR/VI at CAD 2000+", () => {
  const caContext = {
    ...context,
    fromCountryCode: "CA",
    toCountryCode: "GB",
  };
  const cad = validCustoms({
    currency: "CAD",
    commodities: [
      {
        name: "Goods",
        description: "Goods",
        intendedUse: "Resale",
        quantity: 1,
        weightUnits: "KG",
        weight: 5,
        unitPrice: 2000,
        currency: "CAD",
        hsCode: "8471.30",
        countryOfManufacture: "CA",
      },
    ],
    totalCustomsValue: { amount: 2000, currency: "CAD" },
  });
  const rejected = validate(cad, caContext);
  assert.equal(rejected.ok, false);

  const exempt = validate(cad, { ...caContext, toCountryCode: "US" });
  assert.equal(exempt.ok, true);
});

test("upload validation: count, MIME type, base64 and 5 MiB limit", () => {
  const tooManyUploads = validate(
    validCustoms({
      customsDocuments: {
        mode: "PRE_SHIPMENT",
        uploads: Array.from({ length: CUSTOMS_LIMITS.maxUploads + 1 }, () => ({
          fileName: "a.pdf",
          contentType: "application/pdf",
          shipDocumentType: "COMMERCIAL_INVOICE",
          contentBase64: Buffer.from("%PDF-1.4").toString("base64"),
        })),
      },
    }),
  );
  assert.equal(tooManyUploads.ok, false);

  const badType = validate(
    validCustoms({
      customsDocuments: {
        mode: "PRE_SHIPMENT",
        uploads: [
          {
            fileName: "a.exe",
            contentType: "application/x-msdownload",
            shipDocumentType: "OTHER",
            contentBase64: Buffer.from("x").toString("base64"),
          },
        ],
      },
    }),
  );
  assert.equal(badType.ok, false);

  const tooLarge = validate(
    validCustoms({
      customsDocuments: {
        mode: "POST_SHIPMENT",
        uploads: [
          {
            fileName: "big.pdf",
            contentType: "application/pdf",
            shipDocumentType: "COMMERCIAL_INVOICE",
            contentBase64: Buffer.alloc(
              CUSTOMS_LIMITS.maxUploadBytes + 1,
            ).toString("base64"),
          },
        ],
      },
    }),
  );
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) {
    assert.ok(
      tooLarge.errors.some((entry) => /5 MiB|exceeds/i.test(entry.message)),
    );
  }

  const ok = validate(
    validCustoms({
      customsDocuments: {
        mode: "PRE_SHIPMENT",
        uploads: [
          {
            fileName: "invoice.pdf",
            contentType: "application/pdf",
            shipDocumentType: "COMMERCIAL_INVOICE",
            contentBase64: Buffer.from("%PDF-1.4").toString("base64"),
          },
        ],
      },
    }),
  );
  assert.equal(ok.ok, true);
});

test("FedEx mapping uses official fields, enums and appends intendedUse", () => {
  const validated = validate(
    validCustoms({
      shipperTaxIds: [{ tinType: "BUSINESS_NATIONAL", number: "EIN123" }],
      recipientTaxIds: [{ tinType: "PERSONAL_NATIONAL", number: "GST999" }],
      exporter: { companyName: "Exporter Ltd" },
      importerOfRecord: {
        companyName: "Importer Inc",
        address: {
          addressLine1: "9 Import Rd",
          city: "Vancouver",
          state: "BC",
          zipCode: "V6B1A1",
          countryCode: "CA",
        },
      },
      charges: {
        freight: { amount: 12.5, currency: "USD" },
        insurance: { amount: 3, currency: "USD" },
        taxesOrMiscellaneous: { amount: 1, currency: "USD" },
        packing: { amount: 2, currency: "USD" },
        handling: { amount: 4, currency: "USD" },
      },
      exportComplianceStatement: "AESX20220714987654",
    }),
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;

  const mapping = toFedexCustomsMapping(validated.value);
  const detail = mapping.customsClearanceDetail as Record<string, any>;
  assert.equal(detail.isDocumentOnly, false);
  assert.deepEqual(detail.dutiesPayment, { paymentType: "SENDER" });
  assert.deepEqual(detail.totalCustomsValue, { amount: 250, currency: "USD" });
  assert.equal(detail.commodities.length, 2);
  assert.equal(detail.commodities[0].quantityUnits, "EA");
  assert.deepEqual(detail.commodities[0].unitPrice, {
    amount: 100,
    currency: "USD",
  });
  assert.deepEqual(detail.commodities[0].customsValue, {
    amount: 200,
    currency: "USD",
  });
  assert.equal(detail.commodities[0].harmonizedCode, "6404.11.2030");
  assert.equal(detail.commodities[0].purpose, "BUSINESS");
  assert.equal(detail.commodities[0].name, "Widget");
  // intendedUse is internal input, folded into the description — never a
  // fabricated FedEx field.
  assert.equal(detail.commodities[0].intendedUse, undefined);
  assert.match(detail.commodities[0].description, /Resale/);
  assert.deepEqual(detail.commercialInvoice.taxesOrMiscellaneousCharge, {
    amount: 1,
    currency: "USD",
  });
  assert.equal(detail.commercialInvoice.shipmentPurpose, "COMMERCIAL");
  assert.equal(detail.commercialInvoice.termsOfSale, "DDP");
  assert.deepEqual(detail.commercialInvoice.customerReferences, [
    { customerReferenceType: "INVOICE_NUMBER", value: "INV-1001" },
    { customerReferenceType: "CUSTOMER_REFERENCE", value: "SO-77" },
  ]);
  assert.equal(detail.commercialInvoice.originatorName, "Exporter Ltd");
  assert.deepEqual(detail.commercialInvoice.freightCharge, {
    amount: 12.5,
    currency: "USD",
  });
  assert.equal(
    detail.commercialInvoice.taxesOrMiscellaneousChargeType,
    "OTHER",
  );
  assert.equal(detail.importerOfRecord.contact.companyName, "Importer Inc");
  assert.deepEqual(detail.insuranceCharge, { amount: 3, currency: "USD" });
  assert.equal(
    detail.exportDetail.exportComplianceStatement,
    "AESX20220714987654",
  );
  assert.deepEqual(mapping.shipperTins, [
    { number: "EIN123", tinType: "BUSINESS_NATIONAL" },
  ]);
  assert.deepEqual(mapping.recipientTins, [
    { number: "GST999", tinType: "PERSONAL_NATIONAL" },
  ]);
});

test("generated document spec uses PAPER_LETTER/PDF and official types", () => {
  const spec = fedexShippingDocumentSpecification([
    "COMMERCIAL_INVOICE",
    "CERTIFICATE_OF_ORIGIN",
  ]) as Record<string, any>;
  assert.deepEqual(spec.shippingDocumentTypes, [
    "COMMERCIAL_INVOICE",
    "CERTIFICATE_OF_ORIGIN",
  ]);
  assert.deepEqual(spec.commercialInvoiceDetail.documentFormat, {
    stockType: "PAPER_LETTER",
    docType: "PDF",
  });
  assert.deepEqual(spec.certificateOfOrigin.documentFormat, {
    stockType: "PAPER_LETTER",
    docType: "PDF",
  });
});

test("duty estimate maps purpose, currencyCode and non-guaranteed response", () => {
  const validated = validate(
    validCustoms({
      dutiesPayment: { paymentType: "RECIPIENT" },
    }),
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const customs: CustomsDetails = validated.value;

  const built = buildDutyTaxEstimateRequest({
    from: {
      addressLine1: "1 Shipper",
      city: "Austin",
      state: "TX",
      zipCode: "73301",
      countryCode: "US",
    },
    to: {
      addressLine1: "2 Recipient",
      city: "Toronto",
      state: "ON",
      zipCode: "M5V2T6",
      countryCode: "CA",
    },
    serviceType: "INTERNATIONAL_PRIORITY",
    shippingCost: { amount: 25, currency: "USD" },
    customs,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const request = built.request as Record<string, any>;
  assert.equal(request.shipmentPurpose, "FOR_RESALE");
  assert.equal(request.commodities[0].unitPrice.currencyCode, "USD");
  assert.equal(request.commodities[0].unitPrice.currency, undefined);
  assert.equal(request.recipient.stateOrProvinceCode, "ON");
  assert.deepEqual(request.shippingCost, { amount: 25, currency: "USD" });

  const response = mapDutyTaxEstimateResponse({
    output: {
      edtDetails: [
        {
          duties: [
            { amount: 4.44, currency: "USD", description: "Import Duty" },
          ],
          fees: [],
          taxes: [{ amount: 6.81, currency: "USD" }],
          summary: {
            totalDuties: 4.44,
            totalFees: 0,
            totalTaxes: 6.81,
            totalShippingCosts: 25,
            totalLandedCost: 36.25,
            currency: "USD",
          },
        },
      ],
    },
  });
  assert.equal(response.nonGuaranteed, true);
  assert.match(response.disclaimer, /non-guaranteed/i);
  assert.deepEqual(response.duties[0], {
    amount: 4.44,
    currency: "USD",
    description: "Import Duty",
  });
  assert.equal(response.summary?.totalLandedCost, 36.25);
});

test("generated USMCA docs use dedicated documentFormat blocks", () => {
  const spec = fedexShippingDocumentSpecification([
    "USMCA_CERTIFICATION_OF_ORIGIN",
    "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
  ]) as Record<string, any>;
  const format = { stockType: "PAPER_LETTER", docType: "PDF" };
  assert.deepEqual(
    spec.usmcaCertificationOfOriginDetail.documentFormat,
    format,
  );
  assert.deepEqual(
    spec.usmcaCommercialInvoiceCertificationOfOriginDetail.documentFormat,
    format,
  );
  // USMCA certifications must not fall back to the plain COO block.
  assert.equal(spec.certificateOfOrigin, undefined);
});

test("tax ids require an official tinType, reject OTHER and enforce 18 chars", () => {
  const other = validate(
    validCustoms({
      shipperTaxIds: [{ number: "EIN123", tinType: "OTHER" }],
    }),
  );
  assert.equal(other.ok, false);
  if (!other.ok) {
    assert.ok(
      other.errors.some(
        (entry) => entry.field === "customs.shipperTaxIds[0].tinType",
      ),
    );
  }
  const tooLong = validate(
    validCustoms({
      recipientTaxIds: [{ number: "X".repeat(19), tinType: "FEDERAL" }],
    }),
  );
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) {
    assert.ok(
      tooLong.errors.some(
        (entry) => entry.field === "customs.recipientTaxIds[0].number",
      ),
    );
  }
  const official = validate(
    validCustoms({
      recipientTaxIds: [{ number: "123456789", tinType: "PERSONAL_STATE" }],
    }),
  );
  assert.equal(official.ok, true);
});

test("CA export requires b13AFilingOption outside CA/US/PR/VI", () => {
  const caContext = {
    ...context,
    fromCountryCode: "CA",
    toCountryCode: "GB",
  };
  const base = {
    currency: "CAD",
    commodities: [
      {
        name: "Goods",
        description: "Goods",
        intendedUse: "Resale",
        quantity: 1,
        quantityUnits: "EA",
        weight: 5,
        weightUnits: "KG",
        unitPrice: 100,
        currency: "CAD",
        hsCode: "8471.30",
        countryOfManufacture: "CA",
      },
    ],
    totalCustomsValue: { amount: 100, currency: "CAD" },
    exportComplianceStatement: "CA-EXPORT-PROOF",
  };
  const missing = validate(validCustoms(base), caContext);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.ok(
      missing.errors.some(
        (entry) => entry.field === "customs.b13AFilingOption",
      ),
    );
  }
  const present = validate(
    validCustoms({ ...base, b13AFilingOption: "NOT_REQUIRED" }),
    caContext,
  );
  assert.equal(present.ok, true);
  if (present.ok) {
    assert.equal(present.value.b13AFilingOption, "NOT_REQUIRED");
  }
});

test("documents-only maps the declared value and actual package weight onto its single commodity line", () => {
  // 2.5 is deliberately neither 1 nor the default fixture weight, proving the
  // mapping copies caller data instead of hardcoding an amount.
  const validated = validate(
    validCustoms({
      isDocumentOnly: true,
      documentDescription: "Signed contracts",
      commodities: [],
      totalCustomsValue: { amount: 2.5, currency: "USD" },
    }),
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const mapping = toFedexCustomsMapping(validated.value);
  const detail = mapping.customsClearanceDetail as Record<string, any>;
  assert.equal(detail.isDocumentOnly, true);
  assert.equal(detail.commodities.length, 1);
  assert.equal(detail.commodities[0].quantity, 1);
  assert.deepEqual(detail.commodities[0].unitPrice, {
    amount: 2.5,
    currency: "USD",
  });
  assert.deepEqual(detail.commodities[0].customsValue, {
    amount: 2.5,
    currency: "USD",
  });
  // context.packageWeightLb is 40 — the declared line uses the real weight.
  assert.deepEqual(detail.commodities[0].weight, {
    units: "LB",
    value: 40,
  });
  assert.equal(detail.commodities[0].countryOfManufacture, "US");
  assert.equal(detail.commercialInvoice.comments[0], "Signed contracts");
});

test("duty estimate accepts summary.totalDuty and requires origin state", () => {
  const response = mapDutyTaxEstimateResponse({
    output: {
      edtDetails: [
        {
          duties: [],
          fees: [],
          taxes: [],
          summary: { totalDuty: 9.99, totalLandedCost: 19.99, currency: "CAD" },
        },
      ],
    },
  });
  assert.equal(response.summary?.totalDuties, 9.99);
  assert.equal(response.summary?.totalLandedCost, 19.99);

  const validated = validate(validCustoms());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const built = buildDutyTaxEstimateRequest({
    from: {
      addressLine1: "1 Shipper",
      city: "Toronto",
      state: "",
      zipCode: "M5V2T6",
      countryCode: "CA",
    },
    to: {
      addressLine1: "2 Recipient",
      city: "London",
      state: "LDN",
      zipCode: "SW1A1AA",
      countryCode: "GB",
    },
    customs: validated.value,
  });
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.ok(built.errors.some((entry) => entry.field === "from.state"));
  }
});

test("duties payment defaults to SENDER when omitted", () => {
  const body = validCustoms();
  delete (body as Record<string, unknown>).dutiesPayment;
  const validated = validate(body);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.deepEqual(validated.value.dutiesPayment, { paymentType: "SENDER" });
});

test("duty estimate requires CA/BR destination state", () => {
  const validated = validate(validCustoms());
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const built = buildDutyTaxEstimateRequest({
    from: {
      addressLine1: "1 Shipper",
      city: "Austin",
      state: "TX",
      zipCode: "73301",
      countryCode: "US",
    },
    to: {
      addressLine1: "2 Recipient",
      city: "Toronto",
      state: "",
      zipCode: "M5V2T6",
      countryCode: "CA",
    },
    customs: validated.value,
  });
  assert.equal(built.ok, false);
  if (!built.ok) {
    assert.ok(built.errors.some((entry) => entry.field === "to.state"));
  }
});
