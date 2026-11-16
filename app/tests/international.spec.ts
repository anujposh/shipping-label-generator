import { test, expect, type Page } from "@playwright/test";
const vendorDetails = {
  companyName: "Example Vendor",
  contactName: "Sender",
  contactEmail: "sender@example.com",
  contactPhone: "5125551234",
  addressLine1: "20 Pickup St",
  city: "Austin",
  state: "TX",
  zipCode: "78701",
  countryCode: "US",
  taxIds: [{ number: "123456789", tinType: "FEDERAL" }],
};
const token = "international-test-token-123456";
async function start(page: Page, country = "CA", origin = "US") {
  await page.route("**/api/l/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status"))
      return route.fulfill({
        json: {
          link: {
            status: "active",
            shipFromCountryCode: origin,
            vendorDetails: { ...vendorDetails, countryCode: origin },
            remainingUses: 5,
            expiresAt: "2027-01-01",
          },
          shipments: [],
        },
      });
    if (
      ["/rates", "/shipment", "/duty-tax-estimate"].some((path) =>
        url.pathname.endsWith(path),
      )
    )
      expect(route.request().postDataJSON().vendorDetails).toEqual({
        ...vendorDetails,
        addressLine2: "",
        countryCode: origin,
      });
    if (url.pathname.endsWith("/rates"))
      return route.fulfill({
        json: {
          rates: [
            {
              carrier: "fedex",
              service: "RUNTIME_SERVICE",
              serviceDescription: "Runtime FedEx service",
              cost: 25,
              currency: "USD",
            },
          ],
          shipmentContext: {
            isInternational: country !== origin,
            originCountryCode: origin,
            destinationCountryCode: country,
          },
        },
      });
    if (url.pathname.endsWith("/duty-tax-estimate")) {
      expect(route.request().postDataJSON().shippingCost).toEqual({
        amount: 25,
        currency: "USD",
      });
      return route.fulfill({ json: { total: 14, currency: "USD" } });
    }
    if (url.pathname.endsWith("/shipment"))
      return route.fulfill({
        json: {
          shipment: {
            id: "s1",
            status: "label_created",
            trackingNumber: "123456",
            documentWarnings: ["Post-shipment document upload failed."],
            documents: [
              {
                id: "d1",
                fileName: "invoice.pdf",
                source: "UPLOADED",
                uploadStatus: "FAILED",
              },
            ],
          },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto(`/l/${token}/shipment`);
  // Existing address fields remain in their original order and labeling.
  const inputs = page
    .locator("form > fieldset > .fields")
    .first()
    .locator("input");
  const values = [
    "Jane Doe",
    "Example",
    "123 Main St",
    "",
    "Toronto",
    "ON",
    "M5V2T6",
    country,
    "4165551234",
  ];
  for (let i = 0; i < values.length; i++) await inputs.nth(i).fill(values[i]);
  for (const [label, value] of [
    ["Weight (lb)", "1"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "4"],
  ])
    await page.getByLabel(`${label} *`, { exact: false }).fill(value);
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Service", exact: true }),
  ).toContainText("Runtime FedEx service");
}
async function commodity(page: Page, index = 0) {
  const item = page.getByRole("group", {
    name: `Commodity ${index + 1}`,
    exact: true,
  });
  for (const [label, value] of [
    ["Item name", "Shirt"],
    ["Detailed description", "Cotton shirt"],
    ["Intended use", "Wearing"],
    ["HS code", "610910"],
    ["Country of manufacture", "US"],
    ["Quantity", "2"],
    ["Total line weight (not per item)", "0.2"],
    ["Unit price", "10"],
  ])
    await item.getByLabel(`${label} *`, { exact: true }).fill(value);
}
test("domestic retains original request without customs", async ({ page }) => {
  await start(page, "US");
  const lastMinuteRates = page.getByRole("link", {
    name: "Check FedEx last-minute rates",
    exact: true,
  });
  await expect(lastMinuteRates).toBeVisible();
  await expect(lastMinuteRates).toHaveAttribute(
    "href",
    "https://www.fedex.com/en-us/shipping/last-minute-rates.html",
  );
  await expect(lastMinuteRates).toHaveAttribute("target", "_blank");
  await expect(lastMinuteRates).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByRole("heading", { name: "International customs" }),
  ).toHaveCount(0);
  const sent = page.waitForRequest((r) => r.url().endsWith("/shipment"));
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  expect((await sent).postDataJSON()).not.toHaveProperty("customs");
});
test("documents-only, ETD and existing-label upload warning", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Shipment contents").selectOption("DOCUMENTS_ONLY");
  await page.getByLabel("Invoice number").fill("INV-1");
  await page.getByLabel("Document description").fill("Signed legal papers");
  const declaredValue = page.getByLabel("Declared customs value (USD)");
  await declaredValue.fill("0");
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(declaredValue).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter a declared customs value greater than zero.", {
      exact: true,
    }),
  ).toBeVisible();
  await declaredValue.fill("");
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(declaredValue).toHaveAttribute("aria-invalid", "true");
  await declaredValue.fill("1");
  await page.getByLabel("Use electronic trade documents").check();
  await page.getByLabel("Upload timing").selectOption("POST_SHIPMENT");
  await page.getByLabel("COMMERCIAL INVOICE", { exact: true }).check();
  await page.getByLabel("Upload trade documents").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-test"),
  });
  await expect(
    page.getByRole("button", { name: "Remove invoice.pdf" }),
  ).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().endsWith("/shipment"));
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  const payload = (await sent).postDataJSON();
  expect(payload.customs.commodities).toEqual([]);
  expect(payload.customs.totalCustomsValue).toEqual({
    amount: 1,
    currency: "USD",
  });
  expect(payload.customs.documents.generatedTypes).toEqual([
    "COMMERCIAL_INVOICE",
  ]);
  expect(payload.customs.documents.uploadTiming).toBe("POST_SHIPMENT");
  await expect(
    page.getByText("Your label was created. Do not create another label."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "invoice.pdf" })).toHaveAttribute(
    "href",
    /documentId=d1/,
  );
});
test("multiple commodities, totals, validation, currency and duties estimate", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(
    page
      .getByText("Enter an HS code with 6 to 14 digits (dots allowed).")
      .first(),
  ).toBeVisible();
  await page.getByLabel("Invoice number").fill("INV-2");
  await commodity(page);
  await page
    .getByRole("button", { name: "Add commodity", exact: true })
    .click();
  await commodity(page, 1);
  await expect(page.getByText(/Customs value: 40.00 USD/)).toBeVisible();
  await expect(page.getByText(/Commodity weight: 0.400 lb/)).toBeVisible();
  await page.getByLabel(/^Shipment currency/).fill("EUR");
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(
    page.getByText(/All items must use the shipment currency/).first(),
  ).toBeVisible();
  await page.getByLabel(/^Shipment currency/).fill("USD");
  await page.getByLabel("Duties payer").selectOption("RECIPIENT");
  await page
    .getByRole("button", { name: "Estimate duties and taxes", exact: true })
    .click();
  await expect(
    page.getByText(/14.00 USD. Estimate only, not guaranteed/),
  ).toBeVisible();
  await expect(page.getByText(/Paid by: recipient/)).toBeVisible();
  await page.getByRole("button", { name: "Remove commodity 2" }).click();
  await expect(page.getByText(/Customs value: 20.00 USD/)).toBeVisible();
  await page.getByLabel("Duties payer").selectOption("THIRD_PARTY");
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(page.getByLabel("FedEx account number")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});
test("upload limits are accessible and mobile has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  await page.getByLabel("Use electronic trade documents").check();
  await page.getByLabel("Upload trade documents").setInputFiles(
    Array.from({ length: 6 }, (_, i) => ({
      name: `${i}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from("file"),
    })),
  );
  await expect(page.getByText("Upload at most 5 files.")).toBeVisible();
  await page.getByLabel("Upload trade documents").setInputFiles({
    name: "large.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(
    page.getByText("Each file must be nonempty and no larger than 5 MiB."),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("live country detection and structured server field errors", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await page.getByLabel(/^Country/).fill("US");
  await expect(page.getByText("Domestic shipment within US.")).toBeVisible();
  await page.getByLabel(/^Country/).fill("CA");
  await expect(
    page.getByText(/International shipment: US to CA/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await page.getByLabel("Shipment contents").selectOption("DOCUMENTS_ONLY");
  await page.getByLabel("Invoice number").fill("INV-3");
  await page.getByLabel("Document description").fill("Signed papers");
  await page.getByLabel("Declared customs value (USD)").fill("1");
  await page.route("**/shipment", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: "validation_failed",
        fieldErrors: {
          "customs.invoiceNumber": "Use a unique invoice number.",
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(page.getByLabel("Invoice number")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page.getByText("Use a unique invoice number.", { exact: true }),
  ).toBeVisible();
});

test("Canadian goods require B13 independently of value; tax IDs use official enums", async ({
  page,
}) => {
  await start(page, "GB", "CA");
  await page.getByLabel("Invoice number").fill("CA-1");
  await commodity(page);
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(
    page.getByLabel("Canadian export filing (B13A)"),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Select a B13A filing option for this Canadian export.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByLabel("Canadian export filing (B13A)")
    .selectOption("FILED_ELECTRONICALLY");
  await expect(
    page.getByText("Different exporter (otherwise sender)"),
  ).toHaveCount(0);
  const sent = page.waitForRequest((r) => r.url().endsWith("/shipment"));
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  const customs = (await sent).postDataJSON().customs;
  expect(customs.b13AFilingOption).toBe("FILED_ELECTRONICALLY");
  expect(customs.shipperTaxIds[0].tinType).toBe("FEDERAL");
  expect(customs.exporter.contactEmail).toBe(vendorDetails.contactEmail);
  expect(customs.exporter.address.countryCode).toBe("CA");
  expect(customs.exportComplianceStatement).toBeUndefined();
});
test("summary estimate displays landed cost and duty fee tax breakdown", async ({
  page,
}) => {
  await start(page);
  await page.getByLabel("Invoice number").fill("EST-1");
  await commodity(page);
  await page.route("**/duty-tax-estimate", (route) =>
    route.fulfill({
      json: {
        estimate: {
          guaranteed: false,
          nonGuaranteed: true,
          summary: {
            totalDuty: 4,
            totalFees: 2,
            totalTaxes: 8,
            totalShippingCosts: 25,
            totalLandedCost: 59,
            currency: "CAD",
          },
          duties: [],
          fees: [],
          taxes: [],
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Estimate duties and taxes", exact: true })
    .click();
  await expect(
    page.getByText(/Estimated landed cost \(including shipping\): 59.00 CAD/),
  ).toBeVisible();
  for (const text of [
    "Duties: 4.00 CAD",
    "Fees: 2.00 CAD",
    "Taxes: 8.00 CAD",
    "Shipping: 25.00 CAD",
  ])
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  await expect(page.getByText(/Estimate only, not guaranteed/)).toBeVisible();
});
