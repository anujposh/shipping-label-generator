import type { ApiAddress } from "./client";
export type Money = { amount: number; currency: string };
export type TaxId = { number: string; tinType: "PERSONAL_NATIONAL" | "PERSONAL_STATE" | "FEDERAL" | "BUSINESS_NATIONAL" | "BUSINESS_STATE" | "BUSINESS_UNION" };
export type Party = { accountNumber?: string; contactName: string; companyName?: string; contactPhone?: string; contactEmail?: string; address?: ApiAddress; taxIds?: TaxId[] };
export type Commodity = { name: string; description: string; intendedUse: string; hsCode: string; countryOfManufacture: string; quantity: number; quantityUnits: string; weight: number; weightUnits: "LB" | "KG"; unitPrice: number; currency: string; purpose?: string };
export type Upload = { fileName: string; contentType: string; shipDocumentType: string; contentBase64: string };
export type Customs = {
  isDocumentOnly: boolean; documentDescription?: string; shipmentPurpose: string; invoiceNumber: string; shipmentReference?: string; termsOfSale: string; currency: string; commodities: Commodity[]; totalCustomsValue: Money;
  dutiesPayment: { paymentType: string; payor?: Party }; shipperTaxIds?: TaxId[]; recipientTaxIds?: TaxId[]; exporter?: Party; importerOfRecord?: Party;
  b13AFilingOption?: string; charges?: Record<string, Money>; exportComplianceStatement?: string; declarationStatement?: string; specialInstructions?: string; originatorName?: string; comments?: string[]; relatedParties?: boolean;
  documents: { etdEnabled: boolean; uploadTiming: string; generatedTypes: string[]; uploads: Upload[] };
};
export const newCommodity = (currency: string): Commodity => ({ name: "", description: "", intendedUse: "", hsCode: "", countryOfManufacture: "", quantity: 1, quantityUnits: "EA", weight: 0, weightUnits: "LB", unitPrice: 0, currency, purpose: "BUSINESS" });
export const newCustoms = (): Customs => ({ isDocumentOnly: false, shipmentPurpose: "COMMERCIAL", invoiceNumber: "", termsOfSale: "DAP", currency: "USD", commodities: [newCommodity("USD")], totalCustomsValue: { amount: 0, currency: "USD" }, dutiesPayment: { paymentType: "SENDER" }, documents: { etdEnabled: false, uploadTiming: "PRE_SHIPMENT", generatedTypes: [], uploads: [] } });
export function totals(c: Customs) {
  return { amount: c.isDocumentOnly ? c.totalCustomsValue.amount : Math.round(c.commodities.reduce((n, x) => n + x.quantity * x.unitPrice, 0) * 100) / 100, weight: c.isDocumentOnly ? 0 : c.commodities.reduce((n, x) => n + x.weight * (x.weightUnits === "KG" ? 2.2046226218 : 1), 0) };
}
export function customsPayload(c: Customs): Customs {
  return { ...c, commodities: c.isDocumentOnly ? [] : c.commodities, totalCustomsValue: { amount: totals(c).amount, currency: c.currency } };
}
export function validateCustoms(c: Customs, packageWeight: number, origin: string, destination: string) {
  const errors: Record<string, string> = {};
  const fail = (key: string, text = "This field is required.") => { errors[`customs.${key}`] = text; };
  for (const key of ["invoiceNumber", "termsOfSale"] as const) if (!c[key].trim()) fail(key);
  if (!/^[A-Z]{3}$/.test(c.currency)) fail("currency", "Enter a three-letter currency code.");
  if (c.isDocumentOnly) {
    if (!c.documentDescription?.trim()) fail("documentDescription");
    if (!Number.isFinite(c.totalCustomsValue?.amount) || c.totalCustomsValue.amount <= 0) fail("totalCustomsValue.amount", "Enter a declared customs value greater than zero.");
  }
  else {
    if (!c.commodities.length) fail("commodities", "Add at least one commodity.");
    c.commodities.forEach((x, i) => {
      const p = `commodities.${i}.`;
      for (const k of ["name", "description", "intendedUse", "quantityUnits"] as const) if (!x[k].trim()) fail(p + k);
      if (!/^[\d.]+$/.test(x.hsCode) || !/^\d{6,14}$/.test(x.hsCode.replaceAll(".", ""))) fail(p + "hsCode", "Enter an HS code with 6 to 14 digits (dots allowed).");
      if (!/^[A-Z]{2}$/.test(x.countryOfManufacture)) fail(p + "countryOfManufacture", "Enter a two-letter country code.");
      for (const k of ["quantity", "weight", "unitPrice"] as const) if (!Number.isFinite(x[k]) || x[k] <= 0 || (k === "quantity" && !Number.isInteger(x[k]))) fail(p + k, k === "quantity" ? "Enter a positive whole quantity." : "Enter a value greater than zero.");
      if (x.currency !== c.currency) fail(p + "currency", "All items must use the shipment currency. No currency conversion is performed.");
    });
    if (totals(c).weight > packageWeight + 0.00001) fail("commodities", "Commodity weight cannot exceed total package weight.");
  }
  const party = (p: Party | undefined, key: string, account = false) => {
    if (account && !p?.accountNumber?.trim()) fail(key + ".accountNumber");
    if (!p?.contactName?.trim()) fail(key + ".contactName");
    if (!p?.contactPhone?.trim()) fail(key + ".contactPhone");
    for (const k of ["addressLine1", "city", "countryCode"] as const) if (!p?.address?.[k]?.trim()) fail(key + ".address." + k);
  };
  if (c.dutiesPayment.paymentType === "THIRD_PARTY") party(c.dutiesPayment.payor, "dutiesPayment.payor", true);
  if (c.exporter) party(c.exporter, "exporter");
  if (c.importerOfRecord) party(c.importerOfRecord, "importerOfRecord");
  for (const [key, charge] of Object.entries(c.charges ?? {})) {
    if (!Number.isFinite(charge.amount) || charge.amount < 0) fail(`charges.${key}.amount`, "Enter a non-negative amount.");
    if (charge.currency !== c.currency) fail(`charges.${key}.amount`, "Review this charge in the shipment currency. No conversion is performed.");
  }
  if (!c.isDocumentOnly && origin === "CA" && !["CA", "US", "PR", "VI"].includes(destination) && !c.b13AFilingOption) fail("b13AFilingOption", "Select a B13A filing option for this Canadian export.");
  const exportRequired = origin === "US" && (["CN", "RU", "VE", "HK"].includes(destination) || c.currency === "USD" && c.commodities.some(x => x.quantity * x.unitPrice > 2500)) || origin === "CA" && !["US", "PR", "VI"].includes(destination) && c.currency === "CAD" && totals(c).amount >= 2000;
  if (exportRequired && !c.exportComplianceStatement?.trim()) fail("exportComplianceStatement", "An export compliance statement is required for this shipment.");
  return errors;
}
