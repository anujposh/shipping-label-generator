/**
 * DEV-ONLY fake carrier responses for the internal shipping seam.
 *
 * Enabled with SLG_INTERNAL_FAKE_CARRIERS=true AND NODE_ENV !== "production".
 * Lets the shipping-label-generator UI flow (rates -> label download) be
 * exercised end-to-end without real carrier credentials. Returns
 * deterministic, clearly-labeled fake data; never used in production.
 */

import type {
  Carrier,
  CarrierLabel,
  RateQuote,
  RateShopArgs,
  ShipmentDocument,
  ShipmentRequest,
} from "../../carriers/carrier-types";
import type {
  DutyTaxEstimate,
  DutyTaxEstimateInput,
} from "../../carriers/customs";

export function isFakeCarrierMode(): boolean {
  return (
    process.env.SLG_INTERNAL_FAKE_CARRIERS === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

const FAKE_SERVICES: Record<string, string> = {
  fedex: "FEDEX_GROUND",
  ups: "03",
  usps: "PRIORITY",
  stamps: "USPS-PRIORITY",
};

/** Tiny valid one-page PDF ("FAKE LABEL") as a stand-in label payload. */
const FAKE_PDF_BASE64 =
  "JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9LaWRzWzMgMCBSXS9Db3VudCAxPj4KZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA2MTIgNzkyXS9QYXJlbnQgMiAwIFIvUmVzb3VyY2VzPDw+Pi9Db250ZW50cyA0IDAgUj4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA2OD4+CnN0cmVhbQpCVC9UaXRpckxlYXZlCjcyIDcyIFRkCjAKRlgKMCAyMiBUZApGMSAwCjAKRlgKMCAwIFREIC9GMSAxMiBUZgpGSSBTSExHIFRlZXN0IFRkCkVUCmVuZHN0cmVhbQplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4K";

function fakeTrackingNumber(carrier: Carrier): string {
  const stamp = Date.now().toString().slice(-8);
  const rand = Math.floor(Math.random() * 900 + 100);
  return `FAKE${carrier.toUpperCase().slice(0, 4)}${stamp}${rand}`;
}

export async function fakeRateShop(
  carrier: Carrier | "all",
  args: RateShopArgs,
): Promise<RateQuote[]> {
  const carriers: Carrier[] =
    carrier === "all" ? ["fedex", "ups", "usps", "stamps"] : [carrier];
  // Slight deterministic variation by package count so the UI looks real.
  const factor = Math.max(1, args.packages?.length ?? 1);
  const baseDate = args.shipDate ? new Date(args.shipDate) : new Date();
  return carriers.flatMap((c) => {
    const service = FAKE_SERVICES[c] ?? "GROUND";
    return [1, 2].map((tier) => {
      const days = tier === 1 ? 4 : 2;
      const deliveryDate = new Date(baseDate);
      deliveryDate.setDate(deliveryDate.getDate() + days);
      const quote: RateQuote = {
        carrier: c,
        service: tier === 1 ? service : `${service}-EXPRESS`,
        cost: Math.round((tier === 1 ? 8.5 : 21.0) * factor * 100) / 100,
        currency: "USD",
        serviceDescription: `[FAKE] ${c} ${tier === 1 ? "Ground" : "Express"}`,
        deliveryDays: tier === 1 ? "3-5" : "1-2",
        deliveryDate: deliveryDate.toISOString().slice(0, 10),
      };
      return quote;
    });
  });
}

export async function fakeCreateShipment(
  _carrier: Carrier,
  shipment: ShipmentRequest,
): Promise<CarrierLabel[]> {
  const carrier = _carrier;
  const trackingNumber = fakeTrackingNumber(carrier);
  const documents: ShipmentDocument[] = [];
  if (shipment.customs) {
    if (!shipment.customs.isDocumentOnly) {
      documents.push({
        documentType: "COMMERCIAL_INVOICE",
        docType: "PDF",
        fileName: `COMMERCIAL_INVOICE-${trackingNumber}.pdf`,
        contentBase64: FAKE_PDF_BASE64,
        source: "FEDEX_GENERATED",
      });
    }
    for (const upload of shipment.customs.customsDocuments?.uploads ?? []) {
      documents.push({
        documentType: upload.shipDocumentType,
        docType: upload.contentType.includes("pdf") ? "PDF" : "TXT",
        fileName: upload.fileName,
        contentBase64: upload.contentBase64,
        source: "UPLOADED",
        uploadStatus:
          shipment.customs.customsDocuments?.mode === "POST_SHIPMENT"
            ? "UPLOADED"
            : "ATTACHED",
      });
    }
  }
  return [
    {
      carrier,
      trackingNumber,
      labelData: FAKE_PDF_BASE64,
      format: "PDF",
      environment: "sandbox",
      ...(documents.length > 0 ? { documents } : {}),
    },
  ];
}

/** Deterministic, clearly non-guaranteed fake duty & tax estimate. */
export async function fakeDutyTaxEstimate(
  _carrier: Carrier,
  input: DutyTaxEstimateInput,
): Promise<DutyTaxEstimate> {
  const insured = input.customs.commodities.reduce(
    (sum, commodity) => sum + commodity.quantity * commodity.unitPrice,
    0,
  );
  const currency = input.customs.currency;
  const duties = Math.round(insured * 0.05 * 100) / 100;
  const fees = Math.round(insured * 0.02 * 100) / 100;
  const taxes = Math.round(insured * 0.08 * 100) / 100;
  return {
    nonGuaranteed: true,
    guaranteed: false,
    disclaimer:
      "Estimated duties, taxes and fees are non-guaranteed. Final charges are assessed by the carrier and destination customs authority.",
    currency,
    duties: [{ amount: duties, currency, description: "[FAKE] Import Duty" }],
    fees: [{ amount: fees, currency, description: "[FAKE] Disbursement Fee" }],
    taxes: [{ amount: taxes, currency, description: "[FAKE] Tax" }],
    summary: {
      totalDuties: duties,
      totalFees: fees,
      totalTaxes: taxes,
      totalShippingCosts: input.shippingCost?.amount ?? 0,
      totalLandedCost:
        Math.round((insured + duties + fees + taxes) * 100) / 100,
      currency,
    },
  };
}
