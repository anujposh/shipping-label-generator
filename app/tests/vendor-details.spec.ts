import { test, expect } from "@playwright/test";
const vendor = {
  companyName: "Pickup Co",
  contactName: "Jane Sender",
  contactEmail: "jane@example.com",
  contactPhone: "5125551234",
  addressLine1: "10 Sender St",
  addressLine2: "Suite 2",
  city: "Austin",
  state: "TX",
  zipCode: "78701",
  countryCode: "US",
  taxIds: [{ number: "TAX-123", tinType: "BUSINESS_NATIONAL" }],
};
test("mandatory vendor fields and added tax ID rows show inline errors without sending rates", async ({
  page,
}) => {
  let rates = 0;
  await page.route("**/api/l/**", (route) => {
    if (route.request().url().endsWith("/rates")) rates++;
    return route.fulfill({
      json: {
        link: {
          status: "active",
          vendorDetails: null,
          remainingUses: 2,
          expiresAt: "2027-01-01",
        },
        shipments: [],
      },
    });
  });
  await page.goto("/l/vendor-test/shipment");
  for (const [label, value] of [
    ["Full name *", "AMARPAL SINGH (AMARPAL)"],
    ["Company", "SILK CRAFT INC"],
    ["Street address *", "145 MICHAEL DRIVE"],
    ["City *", "SYOSSET"],
    ["State / province *", "NY"],
    ["ZIP / postal code *", "11797"],
    ["Country code (e.g. US) *", "US"],
  ])
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  await expect(page.getByLabel("Phone *", { exact: true })).toHaveValue("");
  for (const input of await page.locator("form input").all())
    await expect(input).toHaveAttribute("placeholder", /.+/);
  await expect(page.getByLabel("Weight (lb) *", { exact: false })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Add tax ID", exact: true }).click();
  await expect(page.getByLabel("Tax ID *", { exact: true })).toHaveAttribute(
    "placeholder",
    "123456789",
  );
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await expect(page.getByLabel("Company name")).toBeFocused();
  await expect(page.getByLabel("Contact email")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Tax ID *", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(rates).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("saved details can be updated and server errors return to the vendor field", async ({
  page,
}) => {
  await page.route("**/api/l/**", (route) =>
    route.fulfill({
      json: {
        link: {
          status: "active",
          vendorDetails: vendor,
          remainingUses: 2,
          expiresAt: "2027-01-01",
        },
        shipments: [],
      },
    }),
  );
  await page.goto("/l/vendor-test/shipment");
  await expect(page.getByLabel("Company name")).toHaveValue("Pickup Co");
  await expect(page.getByLabel("Tax ID *", { exact: true })).toHaveValue(
    "TAX-123",
  );
  await page.getByLabel("Company name").fill("Updated Co");
  const fields = page
    .locator("form > fieldset > .fields")
    .first()
    .locator("input");
  for (const [i, value] of [
    "Recipient",
    "Buyer",
    "20 Receiver St",
    "",
    "Dallas",
    "TX",
    "75001",
    "US",
    "5125550000",
  ].entries())
    await fields.nth(i).fill(value);
  for (const [label, value] of [
    ["Weight (lb)", "1"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "4"],
  ])
    await page.getByLabel(`${label} *`, { exact: false }).fill(value);
  await page.route("**/rates", (route) => {
    expect(route.request().postDataJSON().vendorDetails).toEqual({
      ...vendor,
      companyName: "Updated Co",
    });
    return route.fulfill({
      status: 400,
      json: {
        fieldErrors: {
          "vendorDetails.contactEmail": "Use your company email.",
        },
      },
    });
  });
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await expect(page.getByText("Use your company email.")).toBeVisible();
  await expect(page.getByLabel("Contact email")).toBeFocused();
});
test("linked package units preserve measurements and packaging reaches both requests", async ({
  page,
}) => {
  await page.route("**/api/l/**", (route) =>
    route.fulfill({
      json: {
        link: {
          status: "active",
          vendorDetails: vendor,
          remainingUses: 2,
          expiresAt: "2027-01-01",
        },
        shipments: [],
      },
    }),
  );
  await page.goto("/l/vendor-test/shipment");
  const fields = page
    .locator("form > fieldset > .fields")
    .first()
    .locator("input");
  for (const [i, value] of [
    "Recipient",
    "Buyer",
    "20 Receiver St",
    "",
    "Dallas",
    "TX",
    "75001",
    "US",
    "5125550000",
  ].entries())
    await fields.nth(i).fill(value);

  for (const [label, placeholder] of [
    ["Weight (lb)", "1"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "4"],
  ]) {
    const input = page.getByLabel(`${label} *`, { exact: false });
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("placeholder", placeholder);
  }

  const packaging = page.getByRole("combobox", {
    name: "Packaging",
    exact: true,
  });
  const options = [
    ["YOUR_PACKAGING", "Your packaging"],
    ["FEDEX_ENVELOPE", "FedEx Envelope"],
    ["FEDEX_PAK", "FedEx Pak"],
    ["FEDEX_BOX", "FedEx Box"],
    ["FEDEX_EXTRA_SMALL_BOX", "FedEx Extra Small Box"],
    ["FEDEX_SMALL_BOX", "FedEx Small Box"],
    ["FEDEX_MEDIUM_BOX", "FedEx Medium Box"],
    ["FEDEX_LARGE_BOX", "FedEx Large Box"],
    ["FEDEX_EXTRA_LARGE_BOX", "FedEx Extra Large Box"],
    ["FEDEX_TUBE", "FedEx Tube"],
    ["FEDEX_10KG_BOX", "FedEx 10kg Box"],
    ["FEDEX_25KG_BOX", "FedEx 25kg Box"],
  ];
  await expect(packaging).toHaveValue("YOUR_PACKAGING");
  await expect(packaging.locator("option")).toHaveText(
    options.map(([, label]) => label),
  );
  for (const [index, [value]] of options.entries())
    await expect(packaging.locator("option").nth(index)).toHaveAttribute(
      "value",
      value,
    );
  await expect(
    page.getByRole("heading", { name: "Package details" }),
  ).toBeVisible();
  await expect(page.getByText("Maximum per side: 120 in.")).toBeVisible();
  await expect(page.getByText("Total weight: Enter all weights")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove package 1" }),
  ).toHaveCount(0);
  await packaging.selectOption("FEDEX_PAK");
  await expect(
    page.getByLabel("Package 1 Weight (lb) *", { exact: true }),
  ).toHaveValue("20");
  await expect(page.getByText("Total weight: 20 lb")).toBeVisible();

  await page
    .getByRole("combobox", { name: "Package 1 Weight unit", exact: true })
    .selectOption("kg");
  await expect(
    page.getByLabel("Weight (kg) *", { exact: false }),
  ).toHaveAttribute("placeholder", "0.5");
  await expect(
    page.getByRole("combobox", {
      name: "Package 1 Dimension unit",
      exact: true,
    }),
  ).toHaveValue("cm");
  await expect(page.getByText("Maximum per side: 304.8 cm.")).toBeVisible();
  for (const [label, placeholder] of [
    ["Length (cm)", "25"],
    ["Width (cm)", "20"],
    ["Height (cm)", "10"],
  ])
    await expect(
      page.getByLabel(`${label} *`, { exact: false }),
    ).toHaveAttribute("placeholder", placeholder);

  await page
    .getByRole("combobox", { name: "Package 1 Weight unit", exact: true })
    .selectOption("lb");
  await expect(
    page.getByRole("combobox", {
      name: "Package 1 Dimension unit",
      exact: true,
    }),
  ).toHaveValue("in");
  for (const [label, value] of [
    ["Weight (lb)", "1"],
    ["Length (in)", "10"],
    ["Width (in)", "8"],
    ["Height (in)", "4"],
  ])
    await page.getByLabel(`${label} *`, { exact: false }).fill(value);
  await page
    .getByRole("combobox", { name: "Package 1 Dimension unit", exact: true })
    .selectOption("cm");
  await expect(
    page.getByRole("combobox", { name: "Package 1 Weight unit", exact: true }),
  ).toHaveValue("kg");
  for (const [label, value] of [
    ["Weight (kg)", "0.454"],
    ["Length (cm)", "25.4"],
    ["Width (cm)", "20.32"],
    ["Height (cm)", "10.16"],
  ])
    await expect(page.getByLabel(`${label} *`, { exact: false })).toHaveValue(
      value,
    );

  await page
    .getByRole("button", { name: "+ Add package", exact: true })
    .click();
  const addedWeight = page.getByLabel("Weight (kg) *", { exact: false }).nth(1);
  await expect(addedWeight).toHaveValue("9.072");
  await expect(addedWeight).toHaveAttribute("placeholder", "0.5");
  await expect(
    page.getByLabel("Length (cm) *", { exact: false }).nth(1),
  ).toHaveAttribute("placeholder", "25");
  await page
    .getByRole("combobox", { name: "Package 1 Dimension unit", exact: true })
    .selectOption("in");
  await expect(
    page.getByRole("combobox", { name: "Package 1 Weight unit", exact: true }),
  ).toHaveValue("lb");
  await expect(
    page.getByLabel("Weight (lb) *", { exact: false }).first(),
  ).toHaveValue("1");
  await expect(
    page.getByLabel("Length (in) *", { exact: false }).first(),
  ).toHaveValue("10");
  await page
    .getByRole("combobox", { name: "Package 1 Weight unit", exact: true })
    .selectOption("kg");

  for (const [label, value] of [
    ["Weight (kg)", "1"],
    ["Length (cm)", "25"],
    ["Width (cm)", "20"],
    ["Height (cm)", "10"],
  ]) {
    for (const input of await page
      .getByLabel(`${label} *`, { exact: false })
      .all())
      await input.fill(value);
  }

  await expect(page.getByText("Total packages: 2")).toBeVisible();
  await expect(page.getByText("Total weight: 2 kg")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Package 2 Weight unit", exact: true })
    .selectOption("lb");
  await expect(
    page.getByRole("combobox", {
      name: "Package 1 Dimension unit",
      exact: true,
    }),
  ).toHaveValue("in");
  await page
    .getByRole("combobox", { name: "Package 2 Dimension unit", exact: true })
    .selectOption("cm");
  await expect(
    page.getByRole("combobox", { name: "Package 1 Weight unit", exact: true }),
  ).toHaveValue("kg");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".package-row")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  let ratePackages: unknown;
  await page.route("**/rates", (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.packagingType).toBe("FEDEX_PAK");
    expect(payload.packages).toHaveLength(2);
    expect(payload.packages[1]).toEqual(payload.packages[0]);
    ratePackages = payload.packages;
    const [measurement] = payload.packages;
    expect(measurement.weight).toBeCloseTo(2.2046226218, 8);
    expect(measurement.length).toBeCloseTo(9.842519685, 8);
    expect(measurement.width).toBeCloseTo(7.874015748, 8);
    expect(measurement.height).toBeCloseTo(3.937007874, 8);
    return route.fulfill({
      json: {
        rates: [{ carrier: "fedex", service: "FEDEX_GROUND", cost: 12 }],
      },
    });
  });
  const ratesResponse = page.waitForResponse("**/rates");
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await ratesResponse;
  await page.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(packaging).toHaveValue("FEDEX_PAK");
  await expect(
    page.getByRole("combobox", { name: "Package 1 Weight unit", exact: true }),
  ).toHaveValue("kg");
  await expect(
    page.getByRole("combobox", {
      name: "Package 1 Dimension unit",
      exact: true,
    }),
  ).toHaveValue("cm");
  await page
    .getByRole("button", { name: "Continue to shipping options" })
    .click();
  await page.route("**/shipment", (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.packagingType).toBe("FEDEX_PAK");
    expect(payload.packages).toEqual(ratePackages);
    return route.fulfill({
      json: { id: "test-label", status: "label_created" },
    });
  });
  await page.getByRole("button", { name: "Confirm and create label" }).click();
  await expect(
    page.getByRole("heading", { name: "Your label is ready." }),
  ).toBeVisible();
});
test("admin sees the saved vendor snapshot", async ({ page }) => {
  await page.context().addCookies([
    {
      name: "slg_admin",
      value: "test-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/admin/**", (route) =>
    route.fulfill({
      json: { shipment: { id: 42, status: "pending", shipFrom: vendor } },
    }),
  );
  await page.goto("/admin/shipments/42");
  const snapshot = page.getByRole("region", {
    name: "Submitted vendor details",
  });
  await expect(snapshot.getByText("Pickup Co", { exact: true })).toBeVisible();
  for (const text of [
    "Jane Sender",
    "jane@example.com",
    "5125551234",
    "10 Sender St",
    "Suite 2",
    "BUSINESS NATIONAL: TAX-123",
  ])
    await expect(snapshot.getByText(text, { exact: true })).toBeVisible();
});

test("packaging presets fill every row, remain editable, and preserve custom packaging", async ({
  page,
}) => {
  await page.route("**/api/l/**", (route) =>
    route.fulfill({
      json: {
        link: {
          status: "active",
          vendorDetails: vendor,
          remainingUses: 2,
          expiresAt: "2027-01-01",
        },
        shipments: [],
      },
    }),
  );
  await page.goto("/l/vendor-test/shipment");
  await page
    .getByRole("button", { name: "+ Add package", exact: true })
    .click();
  const presets = [
    ["FEDEX_ENVELOPE", 1, 9.252, 13.189, 0.1],
    ["FEDEX_PAK", 20, 12, 15.5, 1],
    ["FEDEX_BOX", 20, 17.88, 12.38, 3],
    ["FEDEX_EXTRA_SMALL_BOX", 20, 7.25, 2.5, 4.69],
    ["FEDEX_SMALL_BOX", 20, 12.25, 10.9, 1.5],
    ["FEDEX_MEDIUM_BOX", 20, 13.25, 11.5, 2.38],
    ["FEDEX_LARGE_BOX", 20, 17.88, 12.38, 3],
    ["FEDEX_EXTRA_LARGE_BOX", 20, 11.88, 10.81, 11.06],
    ["FEDEX_TUBE", 20, 38, 6, 6],
    ["FEDEX_10KG_BOX", 22, 15.81, 12.94, 10.19],
    ["FEDEX_25KG_BOX", 55, 21.56, 16.56, 13.19],
  ] as const;
  const packaging = page.getByRole("combobox", {
    name: "Packaging",
    exact: true,
  });
  for (const [type, ...values] of presets) {
    await packaging.selectOption(type);
    for (const row of [1, 2]) {
      for (const [index, key] of [
        "Weight (lb)",
        "Length (in)",
        "Width (in)",
        "Height (in)",
      ].entries()) {
        await expect(
          page.getByLabel(`Package ${row} ${key} *`, { exact: true }),
        ).toHaveValue(String(values[index]));
      }
    }
  }
  const weight = page.getByLabel("Package 1 Weight (lb) *", { exact: true });
  await weight.fill("3");
  await expect(packaging).toHaveValue("FEDEX_25KG_BOX");
  await packaging.selectOption("YOUR_PACKAGING");
  await expect(weight).toHaveValue("3");
  await page
    .getByRole("button", { name: "+ Add package", exact: true })
    .click();
  await expect(
    page.getByLabel("Package 3 Weight (lb) *", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByText("Total weight: Enter all weights")).toBeVisible();
  await page
    .getByRole("button", { name: "Remove package 3", exact: true })
    .click();
  await expect(page.getByText("Total weight: 58 lb")).toBeVisible();
  await page
    .getByRole("button", { name: "Remove package 1", exact: true })
    .click();
  await expect(page.getByText("Total packages: 1")).toBeVisible();
  await expect(
    page.getByLabel("Package 1 Weight (lb) *", { exact: true }),
  ).toHaveValue("55");
});
