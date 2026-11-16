type EstimateLine = { amount: number; currency?: string; description?: string };
export type DutyEstimateResponse = {
  estimate?: DutyEstimateResponse;
  nonGuaranteed?: boolean; guaranteed?: false; total?: number; currency?: string;
  estimatedTotal?: { amount: number; currency: string };
  duties?: EstimateLine[]; fees?: EstimateLine[]; taxes?: EstimateLine[];
  summary?: { totalDuty?: number; totalDuties?: number; totalFees?: number; totalTaxes?: number; totalShippingCosts?: number; totalLandedCost?: number; currency?: string };
};
export function presentEstimate(data: DutyEstimateResponse) {
  const summary = data.summary;
  const total = summary?.totalLandedCost ?? data.estimatedTotal?.amount ?? data.total;
  const currency = summary?.currency ?? data.estimatedTotal?.currency ?? data.currency;
  const breakdown: { label: string; amount: number; currency?: string }[] = [];
  for (const [label, amount, lines] of [
    ["Duties", summary?.totalDuty ?? summary?.totalDuties, data.duties],
    ["Fees", summary?.totalFees, data.fees],
    ["Taxes", summary?.totalTaxes, data.taxes],
    ["Shipping", summary?.totalShippingCosts, undefined],
  ] as const) {
    if (typeof amount === "number" && Number.isFinite(amount)) breakdown.push({ label, amount, currency });
    else for (const line of lines ?? []) if (typeof line.amount === "number" && Number.isFinite(line.amount)) breakdown.push({ label: line.description ? `${label}: ${line.description}` : label, amount: line.amount, currency: line.currency ?? currency });
  }
  return {
    total, currency, breakdown, landed: summary?.totalLandedCost !== undefined,
    message: typeof total === "number" && Number.isFinite(total)
      ? "Estimate only, not guaranteed. Final duties, taxes and fees are determined by customs and may differ."
      : "No total estimate was returned. Estimates are not guaranteed; final duties, taxes and fees may still apply.",
  };
}
