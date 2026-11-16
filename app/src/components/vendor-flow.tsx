"use client";
import { useEffect, useRef, useState } from "react";
import { AddressFields, Field, validateAddress } from "./fields";
import {
  ApiError,
  emptyAddress,
  localDate,
  type Rate,
  message,
  request,
  toApiAddress,
} from "@/lib/client";

import {
  presentEstimate,
  type DutyEstimateResponse,
} from "@/lib/duty-estimate";
import { CustomsFields } from "./customs-fields";
import { ShipmentDocuments, type DocumentMetadata } from "./shipment-documents";
import { newCustoms, customsPayload, validateCustoms } from "@/lib/customs";

import { VendorFields } from "./vendor-fields";
import { PickupDetails, newPickup } from "./pickup-details";
import { NotifyDetails, newNotify } from "./notify-details";
import type { ShipmentCreateRequest } from "@/lib/client";
import {
  newVendorDetails,
  validateVendor,
  type VendorDetails,
} from "@/lib/vendor";

type Shipment = {
  documents?: DocumentMetadata[];
  documentWarnings?: string[];
  warnings?: string[];
  id: string;
  status: string;
  carrier?: string;
  serviceType?: string;
  trackingNumber?: string;
  createdAt?: string;
};
type Status = {
  link: {
    vendorDetails?: VendorDetails | null;
    shipFromCountryCode?: string | null;
    status: string;
    expiresAt: string;
    remainingUses: number | null;
  };
  shipments: Shipment[];
};
type Package = {
  weight: number;
  length: number;
  width: number;
  height: number;
};
type WeightUnit = "lb" | "kg";
type DimUnit = "in" | "cm";
const KG_PER_LB = 0.45359237;
const CM_PER_IN = 2.54;
const MAX_DIMENSION_IN = 120;
const packagingOptions = [
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
] as const;
const packagingPresets: Record<string, Package> = Object.fromEntries(
  (
    [
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
    ] as [string, number, number, number, number][]
  ).map(([type, weight, length, width, height]) => [
    type,
    { weight, length, width, height },
  ]),
);
function newPackage(type: string): Package {
  return {
    ...(packagingPresets[type] ?? {
      weight: NaN,
      length: NaN,
      width: NaN,
      height: NaN,
    }),
  };
}
function toDisplay(value: number, unit: WeightUnit | DimUnit) {
  if (!Number.isFinite(value)) return "";
  if (unit === "kg") return Number((value * KG_PER_LB).toFixed(3)).toString();
  if (unit === "cm") return Number((value * CM_PER_IN).toFixed(3)).toString();
  return Number(value.toFixed(3)).toString();
}
function toCanonical(value: number, unit: WeightUnit | DimUnit) {
  if (!Number.isFinite(value)) return NaN;
  if (unit === "kg") return value / KG_PER_LB;
  if (unit === "cm") return value / CM_PER_IN;
  return value;
}
function packageError(
  key: keyof Package,
  value: number,
  weightUnit: WeightUnit,
  dimUnit: DimUnit,
) {
  if (!Number.isFinite(value)) return "Enter a number.";
  if (key === "weight" && (value < 0.1 || value > 150)) {
    const min = toDisplay(0.1, weightUnit);
    const max = toDisplay(150, weightUnit);
    return `Weight must be between ${min} and ${max} ${weightUnit}.`;
  }
  if (key !== "weight" && (value <= 0 || value > MAX_DIMENSION_IN)) {
    const max = toDisplay(MAX_DIMENSION_IN, dimUnit);
    return `Dimension must be greater than 0 and no more than ${max} ${dimUnit}.`;
  }
  return undefined;
}
function packagePhysicalMax(dimUnit: DimUnit) {
  return toDisplay(MAX_DIMENSION_IN, dimUnit);
}
function packagePlaceholder(
  key: keyof Package,
  weightUnit: WeightUnit,
  dimUnit: DimUnit,
) {
  const metric = key === "weight" ? weightUnit === "kg" : dimUnit === "cm";
  const examples = metric
    ? { weight: "0.5", length: "25", width: "20", height: "10" }
    : { weight: "1", length: "10", width: "8", height: "4" };
  return examples[key];
}
function formatDelivery(rate: Rate) {
  if (rate.deliveryDate) {
    const hasTime = rate.deliveryDate.includes("T");
    const date = new Date(hasTime ? rate.deliveryDate : `${rate.deliveryDate}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) +
        (hasTime ? ` by ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "");
    }
  }
  return rate.deliveryDays ? `Estimated ${rate.deliveryDays} business days` : "Delivery estimate unavailable";
}
function carrierName(carrier: string) {
  const names: Record<string, string> = {
    fedex: "FedEx",
    ups: "UPS",
    usps: "USPS",
    stamps: "Stamps",
    stamps_com: "Stamps",
    "stamps.com": "Stamps",
  };
  return names[carrier.toLowerCase()] ?? carrier;
}
function serviceName(rate: Rate) {
  return rate.serviceDescription && rate.serviceDescription !== rate.service
    ? `${rate.serviceDescription} (${rate.service})`
    : rate.service;
}
function ratePrice(rate: Rate) {
  if (!Number.isFinite(Number(rate.cost))) return "Price unavailable";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: rate.currency ?? "USD",
    }).format(Number(rate.cost));
  } catch {
    return `${rate.cost} ${rate.currency ?? "USD"}`;
  }
}
export function VendorFlow({
  token,
  view,
}: {
  token: string;
  view: "landing" | "shipment" | "status";
}) {
  const base = `/api/l/${encodeURIComponent(token)}`;
  const root = `/l/${encodeURIComponent(token)}`;
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vendorDetails, setVendorDetails] = useState(newVendorDetails);
  const prefilled = useRef(false);
  const [vendorTouched, setVendorTouched] = useState<Record<string, boolean>>(
    {},
  );
  const vendorErrors = validateVendor(vendorDetails);
  const [shipTo, setShipTo] = useState({
    ...emptyAddress,
    name: "AMARPAL SINGH",
    company: "SILK CRAFT INC",
    street1: "145 MICHAEL DRIVE",
    city: "SYOSSET",
    state: "NY",
    zip: "11797",
    country: "US",
    phone: "(212)-868-9280",
  });
  const [packages, setPackages] = useState<Package[]>([
    { weight: NaN, length: NaN, width: NaN, height: NaN },
  ]);
  const [weightUnit, setWeightUnit] = useState<WeightUnit>("lb");
  const [dimUnit, setDimUnit] = useState<DimUnit>("in");
  const [packagingType, setPackagingType] = useState("YOUR_PACKAGING");
  const [submitted, setSubmitted] = useState(false);
  const [addressTouched, setAddressTouched] = useState<Record<string, boolean>>(
    {},
  );
  const [packageTouched, setPackageTouched] = useState<
    Record<string, boolean>[]
  >([{}]);
  const addressErrors = validateAddress(shipTo);
  const visibleAddressErrors = Object.fromEntries(
    Object.entries(addressErrors).filter(
      ([key]) => submitted || addressTouched[key],
    ),
  );
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [shipDate, setShipDate] = useState(() => localDate());
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [pickup, setPickup] = useState(newPickup);
  const [notify, setNotify] = useState(() => newNotify(vendorDetails.contactEmail));
  const [notifyEmailTouched, setNotifyEmailTouched] = useState<Record<string, boolean>>({});
  const [notifyError, setNotifyError] = useState("");
  const notification = {
    ...notify,
    shipperEmail: notifyEmailTouched.shipperEmail ? notify.shipperEmail : vendorDetails.contactEmail,
    recipientEmail: notifyEmailTouched.recipientEmail ? notify.recipientEmail : ((shipTo as typeof shipTo & { contactEmail?: string }).contactEmail ?? ""),
  };
  const [pickupError, setPickupError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const selectedRate = selected === null ? undefined : rates?.[selected];
  const carriers = [...new Set(rates?.map((rate) => rate.carrier) ?? [])];
  const carrierRates =
    rates
      ?.map((rate, index) => ({ rate, index }))
      .filter(({ rate }) => rate.carrier === selectedRate?.carrier) ?? [];
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [customs, setCustoms] = useState(newCustoms);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [estimate, setEstimate] = useState<{
    message: string;
    total?: number;
    currency?: string;
    landed?: boolean;
    breakdown?: { label: string; amount: number; currency?: string }[];
  } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [context, setContext] = useState<{
    isInternational: boolean;
    originCountryCode: string;
    destinationCountryCode: string;
  } | null>(null);
  const origin = vendorDetails.countryCode.toUpperCase();
  const visibleVendorErrors = {
    ...Object.fromEntries(
      Object.entries(vendorErrors).filter(
        ([key]) => submitted || vendorTouched[key],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(fieldErrors).filter(([key]) =>
        key.startsWith("vendorDetails."),
      ),
    ),
  };
  function submissionError(e: unknown) {
    setError(
      e instanceof ApiError && e.status === 401
        ? "This shipping link is unavailable. Contact the person who sent it."
        : message(e),
    );
    if (
      e instanceof ApiError &&
      e.data.fieldErrors &&
      typeof e.data.fieldErrors === "object"
    ) {
      const errors = e.data.fieldErrors as Record<string, string>;
      setFieldErrors(errors);
      if (Object.keys(errors).some((key) => key.startsWith("vendorDetails."))) {
        setRates(null);
        setSelected(null);
      }
      // Wait one extra frame so React commits the field errors and re-enables
      // the disabled fieldset before focusing the first invalid input.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>('[aria-invalid="true"]')
            ?.focus(),
        ),
      );
    }
  }
  const submittedCustoms = () =>
    customsPayload({
      ...customs,
      shipperTaxIds: vendorDetails.taxIds,
      exporter: {
        contactName: vendorDetails.contactName,
        companyName: vendorDetails.companyName,
        contactEmail: vendorDetails.contactEmail,
        contactPhone: vendorDetails.contactPhone,
        address: vendorDetails,
        taxIds: vendorDetails.taxIds,
      },
    });
  const international = origin
    ? origin !== shipTo.country.toUpperCase()
    : (context?.isInternational ?? false);
  const needsCustoms =
    international && selectedRate?.carrier.toLowerCase() === "fedex";
  function checkCustoms() {
    const errors = needsCustoms
      ? validateCustoms(
          customs,
          packages.reduce((n, p) => n + p.weight, 0),
          origin ?? context?.originCountryCode ?? "",
          shipTo.country.toUpperCase(),
        )
      : {};
    setFieldErrors(errors);
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => {
        document
          .querySelectorAll<HTMLDetailsElement>(".customs details")
          .forEach((d) => {
            d.open = true;
          });
        document
          .querySelector<HTMLInputElement>('.customs [aria-invalid="true"]')
          ?.focus();
      });
      return false;
    }
    return true;
  }
  async function estimateDuties() {
    if (!selectedRate || !checkCustoms()) return;
    setEstimating(true);
    setEstimate(null);
    try {
      const data = await request<DutyEstimateResponse>(
        `${base}/duty-tax-estimate`,
        {
          vendorDetails,
          shipTo: toApiAddress(shipTo),
          packages,
          carrier: selectedRate.carrier,
          serviceType: selectedRate.service,
          shippingCost: {
            amount: selectedRate.cost,
            currency: selectedRate.currency ?? "USD",
          },
          customs: submittedCustoms(),
        },
      );
      setEstimate(presentEstimate(data.estimate ?? data));
    } catch (e) {
      if (e instanceof ApiError && e.data.fieldErrors) submissionError(e);
      setEstimate({
        message:
          "Duties and taxes estimate unavailable. You can still create a label; charges may apply.",
      });
    } finally {
      setEstimating(false);
    }
  }
  const [conflict, setConflict] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    request<Status>(`${base}/status`)
      .then((data) => {
        if (active) {
          setStatus(data);
          if (!prefilled.current) {
            setVendorDetails({
              ...newVendorDetails(),
              ...data.link.vendorDetails,
            });
            prefilled.current = true;
          }
          setBlocked(data.link.status !== "active");
          setError("");
        }
      })
      .catch((e) => {
        if (active) {
          setError(
            e instanceof ApiError && e.status === 401
              ? "This shipping link is unavailable. Contact the person who sent it."
              : message(e),
          );
          setBlocked(
            e instanceof ApiError && [401, 403, 410, 404].includes(e.status),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base, attempt]);
  async function getRates(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSubmitted(true);
    if (
      Object.keys(vendorErrors).length ||
      Object.keys(addressErrors).length ||
      packages.some((p) =>
        (Object.keys(p) as (keyof Package)[]).some((key) =>
          packageError(key, p[key], weightUnit, dimUnit),
        ),
      )
    ) {
      setBusy(false);
      // Wait for inline errors to render before focusing the first invalid input.
      const form = e.currentTarget;
      requestAnimationFrame(() =>
        form.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus(),
      );
      return;
    }
    await fetchRates(shipDate);
  }
  async function fetchRates(nextShipDate: string) {
    setBusy(true);
    setRefreshingRates(true);
    setError("");
    setEstimate(null);
    const previous = selectedRate;
    try {
      const data = await request<{
        rates: Rate[];
        shipmentContext?: {
          isInternational: boolean;
          originCountryCode: string;
          destinationCountryCode: string;
        };
      }>(`${base}/rates`, {
        vendorDetails,
        shipTo: toApiAddress(shipTo),
        packages,
        packagingType,
        shipDate: nextShipDate,
      });
      setContext(data.shipmentContext ?? null);
      setRates(data.rates ?? []);
      const preserved = data.rates?.findIndex((rate) => rate.carrier === previous?.carrier && rate.service === previous?.service) ?? -1;
      setSelected(data.rates?.length ? (preserved >= 0 ? preserved : 0) : null);
      setShipDate(nextShipDate);
      // Keep the pickup date aligned with the ship date until the vendor
      // overrides it explicitly in the pickup section.
      if (!pickup.dateTouched) setPickup({ ...pickup, date: nextShipDate });
    } catch (e) {
      submissionError(e);
    } finally {
      setBusy(false);
      setRefreshingRates(false);
    }
  }
  async function create() {
    if (!selectedRate || busy || uploading) return;
    if (pickup.type === "pickup" && (!pickup.date || pickup.date < localDate() || !pickup.readyTime || !pickup.closeTime || pickup.closeTime <= pickup.readyTime)) {
      setPickupError("Choose a pickup date and a close time later than the ready time.");
      const panel = document.querySelector<HTMLDetailsElement>(".pickup-details");
      if (panel) { panel.open = true; panel.scrollIntoView({ block: "center", behavior: "smooth" }); }
      return;
    }
    setPickupError("");
    const notificationEmails = [notification.recipientEmail, notification.shipperEmail, notification.additionalEmail].map((email) => email.trim());
    const validNotificationEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (notification.enabled && (!notificationEmails.some(Boolean) || notificationEmails.some((email) => email && !validNotificationEmail(email)))) {
      setNotifyError("Add at least one valid notification email turn off email notifications.");
      const panel = document.querySelector<HTMLDetailsElement>("[data-notify-details]");
      if (panel) {
        panel.open = true;
        panel.scrollIntoView({ block: "center", behavior: "smooth" });
        Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="email"]')).find((input) => !input.value.trim() || !validNotificationEmail(input.value.trim()))?.focus();
      }
      return;
    }
    setNotifyError("");
    if (!checkCustoms()) return;
    setBusy(true);
    setError("");
    try {
      const rate = selectedRate;
      const data = await request<{ shipment?: Shipment } & Partial<Shipment>>(
        `${base}/shipment`,
        {
          vendorDetails,
          shipTo: toApiAddress(shipTo),
          packages,
          carrier: rate.carrier,
          packagingType,
          shipDate,
          pickup: {
            type: pickup.type,
            ...(pickup.type === "pickup" ? {
              date: pickup.date, readyTime: pickup.readyTime, closeTime: pickup.closeTime,
              ...(pickup.instructions.trim() ? { instructions: pickup.instructions.trim() } : {}),
              ...(pickup.useDifferentAddress ? { address: {
                ...toApiAddress(pickup.address), contactName: pickup.contact.name,
                ...(pickup.contact.phone ? { contactPhone: pickup.contact.phone } : {}),
                ...(pickup.contact.email ? { contactEmail: pickup.contact.email } : {}),
              } } : {}),
            } : {}),
          },
          serviceType: rate.service,
          ...(notification.enabled ? { notification: {
            enabled: true,
            ...(notification.recipientEmail.trim() ? { recipientEmail: notification.recipientEmail.trim() } : {}),
            ...(notification.shipperEmail.trim() ? { shipperEmail: notification.shipperEmail.trim() } : {}),
            ...(notification.additionalEmail.trim() ? { additionalEmail: notification.additionalEmail.trim() } : {}),
            ...(notification.includeMessage && notification.personalMessage.trim() ? { personalMessage: notification.personalMessage.trim() } : {}),
          } } : {}),
          ...(needsCustoms ? { customs: submittedCustoms() } : {}),
        } satisfies ShipmentCreateRequest,
      );
      setShipment(
        data.shipment ?? {
          id: String(data.id ?? ""),
          status: data.status ?? "label_created",
          trackingNumber: data.trackingNumber,
          documents: data.documents,
          documentWarnings: data.documentWarnings,
          warnings: data.warnings,
        },
      );
    } catch (e) {
      submissionError(e);
      if (e instanceof ApiError && e.status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  const download = (id: string) =>
    `${base}/label.pdf${id ? `?shipmentId=${encodeURIComponent(id)}` : ""}`;
  return (
    <main className="vendor">
      <header className="brand">DISPATCH / SHIPPING</header>
      {loading ? (
        <section className="panel" role="status">
          Checking your shipping link...
        </section>
      ) : (
        <>
          {error && (
            <div className="notice error" role="alert">
              {error}
              {!blocked && (
                <button
                  className="secondary"
                  onClick={() => {
                    setLoading(true);
                    setAttempt((a) => a + 1);
                  }}
                >
                  Check link again
                </button>
              )}
            </div>
          )}
          {blocked && (
            <section className="panel">
              <div className="eyebrow">Link unavailable</div>
              <h1>
                {status?.link.status === "exhausted"
                  ? "All set. All labels used."
                  : "This link is no longer active."}
              </h1>
              <p>
                Ask the team that sent your link for help or a new link.
                Existing labels may still be available in shipment status.
              </p>
              <a href={`${root}/status`}>View shipment status</a>
            </section>
          )}
          {view === "landing" && status && !blocked && (
            <section className="panel">
              <div className="eyebrow">Your private shipping workspace</div>
              <h1>
                Pack it.
                <br />
                We&apos;ll handle the label.
              </h1>
              <p>
                Enter your pickup and delivery details, compare shipping
                options, and download a ready-to-print label. No account needed.
              </p>
              <div className="steps">
                <span>01 / Add details</span>
                <span>02 / Choose shipping</span>
                <span>03 / Print label</span>
              </div>
              <div className="actions">
                <a className="primary" href={`${root}/shipment`}>
                  Create a shipping label
                </a>
                <a href={`${root}/status`}>View existing shipments</a>
              </div>
              <p className="mt-6 text-sm">
                {status.link.remainingUses === null
                  ? "Labels available"
                  : `${status.link.remainingUses} label(s) remaining`}{" "}
                · Valid until{" "}
                {new Date(status.link.expiresAt).toLocaleDateString()}
              </p>
            </section>
          )}
          {view === "status" && status && (
            <section className="panel">
              <div className="eyebrow">Shipment history</div>
              <h1>Your shipments.</h1>
              <p>Download your labels again or check the tracking number.</p>
              {status.shipments.length === 0 ? (
                <p>No shipments yet. Your first label will appear here.</p>
              ) : (
                status.shipments.map((s) => (
                  <article className="shipment" key={s.id}>
                    <div>
                      <strong>
                        {s.carrier ?? "Shipment"} {s.serviceType}
                      </strong>
                      <p className="mb-0 text-sm">
                        {s.status.replaceAll("_", " ")} ·{" "}
                        {s.createdAt
                          ? new Date(s.createdAt).toLocaleDateString()
                          : ""}
                        <br />
                        Tracking: {s.trackingNumber ?? "Not yet available"}
                      </p>
                    </div>
                    {s.status === "label_created" && (
                      <a href={download(s.id)} download="label.pdf">
                        Download PDF label
                      </a>
                    )}
                    <ShipmentDocuments
                      base={base}
                      documents={s.documents}
                      warnings={s.documentWarnings ?? s.warnings}
                    />
                  </article>
                ))
              )}
              {!blocked && (
                <div className="actions">
                  <a className="primary" href={`${root}/shipment`}>
                    Create another label
                  </a>
                </div>
              )}
            </section>
          )}
          {view === "shipment" && !blocked && status && (
            <section className="panel">
              {shipment ? (
                <>
                  <div className="eyebrow">Ready for dispatch</div>
                  <h1>Your label is ready.</h1>
                  <p>
                    Print your PDF at 100% scale and attach it securely to your
                    package.
                  </p>
                  <div className="package">
                    <span className="eyebrow">Tracking number</span>
                    <h2 className="mt-3 break-all">
                      {shipment.trackingNumber ??
                        "Available in shipment status"}
                    </h2>
                  </div>
                  <ShipmentDocuments
                    base={base}
                    documents={shipment.documents}
                    warnings={shipment.documentWarnings ?? shipment.warnings}
                  />
                  <div className="actions">
                    <a
                      className="primary"
                      href={download(shipment.id)}
                      download="label.pdf"
                    >
                      Download PDF label
                    </a>
                    <a href={`${root}/status`}>View shipment status</a>
                  </div>
                </>
              ) : conflict ? (
                <>
                  <h1>Already taken care of.</h1>
                  <p>
                    A shipment was already created. Re-download its existing
                    label instead of purchasing another.
                  </p>
                  <a className="primary" href={`${root}/status`}>
                    View and download existing label
                  </a>
                </>
              ) : (
                <>
                  <div className="steps">
                    <b>
                      {rates
                        ? "01 / Details complete"
                        : "01 / Shipment details"}
                    </b>
                    <span>02 / Shipping options</span>
                  </div>
                  <h1>
                    {rates ? "Choose your delivery." : "Where is it going?"}
                  </h1>
                  <p>
                    {rates
                      ? "Select a service to create your shipping label."
                      : "Add your company and pickup details, then the destination and package measurements."}
                  </p>
                  {!rates ? (
                    <form noValidate onSubmit={getRates}>
                      <fieldset disabled={busy}>
                        <VendorFields
                          value={vendorDetails}
                          onChange={(value) => {
                            setVendorDetails(value);
                            setFieldErrors({});
                          }}
                          errors={visibleVendorErrors}
                          onBlur={(key) =>
                            setVendorTouched((touched) => ({
                              ...touched,
                              [key]: true,
                            }))
                          }
                        />
                        <h2 className="mt-8">Delivery address</h2>
                        <AddressFields
                          value={shipTo}
                          onChange={setShipTo}
                          errors={visibleAddressErrors}
                          onBlur={(key) =>
                            setAddressTouched((touched) => ({
                              ...touched,
                              [key]: true,
                            }))
                          }
                        />
                        <p className="notice" role="status">
                          {origin
                            ? international
                              ? `International shipment: ${origin} to ${shipTo.country.toUpperCase()}. FedEx customs details follow after service selection.`
                              : `Domestic shipment within ${origin}.`
                            : "The shipping service will confirm whether customs information is needed."}
                        </p>
                        <section
                          className="package-details"
                          aria-labelledby="package-details-title"
                        >
                          <h2 id="package-details-title">Package details</h2>
                          <p className="text-sm">
                            Enter each package&apos;s weight and dimensions.
                            Changing units converts all measurements.
                          </p>
                          <label htmlFor="package-packaging">
                            Packaging
                            <select
                              id="package-packaging"
                              value={packagingType}
                              onChange={(e) => {
                                const type = e.target.value;
                                setPackagingType(type);
                                if (packagingPresets[type])
                                  setPackages(
                                    packages.map(() => newPackage(type)),
                                  );
                              }}
                            >
                              {packagingOptions.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="package-limit">
                            Maximum per side: {packagePhysicalMax(dimUnit)}{" "}
                            {dimUnit}.
                          </p>
                          <div className="package-rows">
                            {packages.map((p, i) => {
                              const measurement = (key: keyof Package) => {
                                const unit =
                                  key === "weight" ? weightUnit : dimUnit;
                                return (
                                  <Field
                                    label={
                                      key === "weight"
                                        ? "Weight"
                                        : key === "length"
                                          ? "L"
                                          : key === "width"
                                            ? "W"
                                            : "H"
                                    }
                                    aria-label={`Package ${i + 1} ${key[0].toUpperCase()}${key.slice(1)} (${unit}) *`}
                                    type="number"
                                    required
                                    min={
                                      key === "weight"
                                        ? toDisplay(0.1, unit)
                                        : 0
                                    }
                                    max={toDisplay(
                                      key === "weight" ? 150 : MAX_DIMENSION_IN,
                                      unit,
                                    )}
                                    step="any"
                                    placeholder={packagePlaceholder(
                                      key,
                                      weightUnit,
                                      dimUnit,
                                    )}
                                    error={
                                      submitted || packageTouched[i]?.[key]
                                        ? packageError(
                                            key,
                                            p[key],
                                            weightUnit,
                                            dimUnit,
                                          )
                                        : undefined
                                    }
                                    onBlur={() =>
                                      setPackageTouched((touched) =>
                                        packages.map((_, n) =>
                                          n === i
                                            ? { ...touched[n], [key]: true }
                                            : (touched[n] ?? {}),
                                        ),
                                      )
                                    }
                                    value={toDisplay(p[key], unit)}
                                    onChange={(e) =>
                                      setPackages(
                                        packages.map((item, n) =>
                                          n === i
                                            ? {
                                                ...item,
                                                [key]: toCanonical(
                                                  e.target.valueAsNumber,
                                                  unit,
                                                ),
                                              }
                                            : item,
                                        ),
                                      )
                                    }
                                  />
                                );
                              };
                              return (
                                <div
                                  className="package-row"
                                  role="group"
                                  aria-label={`Package ${i + 1}`}
                                  key={i}
                                >
                                  <strong className="package-number">
                                    <span className="sr-only">Package </span>
                                    {i + 1}
                                  </strong>
                                  <div className="package-weight">
                                    {measurement("weight")}
                                    <label>
                                      <span className="sr-only">
                                        Package {i + 1} Weight unit
                                      </span>
                                      <select
                                        value={weightUnit}
                                        onChange={(e) => {
                                          const unit = e.target
                                            .value as WeightUnit;
                                          setWeightUnit(unit);
                                          setDimUnit(
                                            unit === "kg" ? "cm" : "in",
                                          );
                                        }}
                                      >
                                        <option value="lb">lb</option>
                                        <option value="kg">kg</option>
                                      </select>
                                    </label>
                                  </div>
                                  <div className="package-dimensions">
                                    <span className="package-dimensions-title">
                                      Dimensions L × W × H
                                    </span>
                                    <div className="package-dimension-inputs">
                                      {measurement("length")}
                                      <span
                                        className="package-times"
                                        aria-hidden="true"
                                      >
                                        ×
                                      </span>
                                      {measurement("width")}
                                      <span
                                        className="package-times"
                                        aria-hidden="true"
                                      >
                                        ×
                                      </span>
                                      {measurement("height")}
                                      <label>
                                        <span className="sr-only">
                                          Package {i + 1} Dimension unit
                                        </span>
                                        <select
                                          value={dimUnit}
                                          onChange={(e) => {
                                            const unit = e.target
                                              .value as DimUnit;
                                            setDimUnit(unit);
                                            setWeightUnit(
                                              unit === "cm" ? "kg" : "lb",
                                            );
                                          }}
                                        >
                                          <option value="in">in</option>
                                          <option value="cm">cm</option>
                                        </select>
                                      </label>
                                    </div>
                                  </div>
                                  {packages.length > 1 && (
                                    <button
                                      className="package-remove"
                                      type="button"
                                      aria-label={`Remove package ${i + 1}`}
                                      onClick={() => {
                                        setPackages(
                                          packages.filter((_, n) => n !== i),
                                        );
                                        setPackageTouched((touched) =>
                                          touched.filter((_, n) => n !== i),
                                        );
                                      }}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div
                            className="package-totals"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            <span>
                              Total packages: <strong>{packages.length}</strong>
                            </span>
                            <span>
                              Total weight:{" "}
                              <strong>
                                {packages.every((p) =>
                                  Number.isFinite(p.weight),
                                )
                                  ? `${toDisplay(
                                      packages.reduce(
                                        (total, p) => total + p.weight,
                                        0,
                                      ),
                                      weightUnit,
                                    )} ${weightUnit}`
                                  : "Enter all weights"}
                              </strong>
                            </span>
                          </div>
                          <button
                            className="secondary"
                            type="button"
                            disabled={packages.length >= 10}
                            onClick={() => {
                              setPackages([
                                ...packages,
                                newPackage(packagingType),
                              ]);
                              setPackageTouched((touched) => [...touched, {}]);
                            }}
                          >
                            + Add package
                          </button>
                        </section>
                        <div className="actions">
                          <button type="submit">
                            {busy
                              ? "Finding rates..."
                              : "Continue to shipping options"}
                          </button>
                        </div>
                      </fieldset>
                    </form>
                  ) : (
                    <>
                      <fieldset disabled={busy || estimating || uploading}>
                        <legend className="sr-only">Shipping service</legend>
                        {rates.length === 0 && (
                          <div className="notice">
                            No services are available for these details. Check
                            the address and package measurements.
                          </div>
                        )}
                        {rates.length > 0 && (
                          <div className="shipping-options">
                            <div className="shipping-selects">
                              <label htmlFor="shipping-carrier">
                                Carrier
                                <select
                                  id="shipping-carrier"
                                  value={selectedRate?.carrier ?? ""}
                                  onChange={(e) => {
                                    const index = rates.findIndex(
                                      (rate) => rate.carrier === e.target.value,
                                    );
                                    setSelected(index >= 0 ? index : null);
                                    setEstimate(null);
                                  }}
                                >
                                  <option value="" disabled>
                                    Select a carrier
                                  </option>
                                  {carriers.map((carrier) => (
                                    <option key={carrier} value={carrier}>
                                      {carrierName(carrier)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label htmlFor="shipping-service">
                                Service
                                <select
                                  id="shipping-service"
                                  value={selectedRate ? String(selected) : ""}
                                  disabled={busy || !selectedRate}
                                  onChange={(e) => {
                                    const index = Number(e.target.value);
                                    setSelected(
                                      carrierRates.some(
                                        (option) => option.index === index,
                                      )
                                        ? index
                                        : null,
                                    );
                                    setEstimate(null);
                                  }}
                                >
                                  <option value="" disabled>
                                    Select a service
                                  </option>
                                  {carrierRates.map(({ rate, index }) => (
                                    <option key={index} value={index}>
                                      {serviceName(rate)} - {ratePrice(rate)}
                                      {rate.deliveryDate || rate.deliveryDays
                                        ? ` - ${formatDelivery(rate)}`
                                        : ""}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            </div>
                            <div className="service-overview">
                            <details className="service-details" open>
                              <summary>Service details</summary>
                              <dl className="detail-rows">
                                <div><dt><label htmlFor="ship-date">Ship date</label></dt><dd>
                                  <input id="ship-date" type="date" min={localDate()} max={localDate(10)} value={shipDate} onChange={(e) => {
                                    const next = e.target.value;
                                    if (next && next >= localDate() && next <= localDate(10)) void fetchRates(next);
                                  }} />
                                </dd></div>
                                <div><dt>Selected service</dt><dd>{selectedRate ? serviceName(selectedRate) : "Select a service"}</dd></div>
                                <div><dt>Contact name</dt><dd>{vendorDetails.contactName}</dd></div>
                                <div><dt>Phone</dt><dd>{vendorDetails.contactPhone || "Not provided"}</dd></div>
                                <div><dt>Email</dt><dd>{vendorDetails.contactEmail || "Not provided"}</dd></div>
                              </dl>
                            </details>
                            <div
                              className="shipping-summary delivery-summary"
                              aria-live="polite"
                              aria-atomic="true"
                            >
                              {selectedRate && (
                                <>
                                  <div>
                                    <span className="eyebrow">
                                      Expected delivery
                                    </span>
                                    <strong>
                                      {refreshingRates ? "Updating delivery estimate..." : formatDelivery(selectedRate)}
                                    </strong>
                                  </div>
                                  <div className="expected-cost">
                                  <span className="eyebrow">Estimated total cost</span>
                                  <strong className="shipping-price">
                                    {refreshingRates ? "Updating..." : ratePrice(selectedRate)}
                                  </strong>
                                  </div>
                                </>
                              )}
                            </div>
                            </div>
                          </div>
                        )}
                        {carriers.some(
                          (carrier) => carrier.toLowerCase() === "fedex",
                        ) && (
                          <p className="mt-4 text-sm">
                            <a
                              href="https://www.fedex.com/en-us/shipping/last-minute-rates.html"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Check FedEx last-minute rates
                            </a>
                          </p>
                        )}
                        {selectedRate && <PickupDetails value={pickup} onChange={(value) => { setPickup(value); setPickupError(""); }} vendor={vendorDetails} carrier={carrierName(selectedRate.carrier)} shipDate={shipDate} error={pickupError} />}
              {selectedRate && <NotifyDetails value={notification} onChange={(value) => { setNotify(value); setNotifyError(""); }} onEmailChange={(field, email) => { setNotifyEmailTouched((touched) => ({ ...touched, [field]: true })); setNotify({ ...notification, [field]: email }); setNotifyError(""); }} error={notifyError} />}
                        {needsCustoms && (
                          <>
                            <CustomsFields
                              value={customs}
                              onChange={(value) => {
                                setCustoms(value);
                                setEstimate(null);
                                setFieldErrors({});
                              }}
                              errors={fieldErrors}
                              onUploading={setUploading}
                            />
                            {Object.keys(fieldErrors).length > 0 && (
                              <div className="notice error" role="alert">
                                <strong>Check customs details</strong>
                                <ul>
                                  {Object.entries(fieldErrors).map(
                                    ([key, text]) => (
                                      <li key={key}>
                                        {key
                                          .replace("customs.", "")
                                          .replaceAll(".", " / ")}
                                        : {text}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </div>
                            )}
                            {!customs.isDocumentOnly && (
                              <div className="package">
                                <h3>Optional duties and taxes estimate</h3>
                                <p>
                                  Not included in the shipping price. Paid by:{" "}
                                  {customs.dutiesPayment.paymentType
                                    .replaceAll("_", " ")
                                    .toLowerCase()}
                                  .
                                </p>
                                <button
                                  type="button"
                                  className="secondary"
                                  disabled={estimating || uploading}
                                  onClick={estimateDuties}
                                >
                                  {estimating
                                    ? "Estimating..."
                                    : "Estimate duties and taxes"}
                                </button>
                                {estimate && (
                                  <div role="status">
                                    <p>
                                      {estimate.landed
                                        ? "Estimated landed cost (including shipping): "
                                        : ""}
                                      {typeof estimate.total === "number" &&
                                      Number.isFinite(estimate.total)
                                        ? `${estimate.total.toFixed(2)} ${estimate.currency ?? customs.currency}. `
                                        : ""}
                                      {estimate.message}
                                    </p>
                                    {!!estimate.breakdown?.length && (
                                      <ul>
                                        {estimate.breakdown.map((line, i) => (
                                          <li key={i}>
                                            {line.label}:{" "}
                                            {line.amount.toFixed(2)}{" "}
                                            {line.currency ?? customs.currency}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </div>
                                )}
                                <p className="text-sm">
                                  Estimates are not guaranteed and are not a
                                  quote for final customs charges.
                                </p>
                              </div>
                            )}
                          </>
                        )}
                        <div className="actions">
                          <button
                            className="secondary"
                            onClick={() => {
                              setRates(null);
                              setSelected(null);
                              setEstimate(null);
                            }}
                          >
                            Edit details
                          </button>
                          <button
                            className="primary"
                            disabled={
                              !selectedRate || busy || uploading || estimating
                            }
                            onClick={create}
                          >
                            {busy
                              ? refreshingRates ? "Updating rates..." : "Creating your label..."
                              : "Confirm and create label"}
                          </button>
                        </div>
                      </fieldset>
                      <p className="mt-4 text-sm">
                        Please only click once. Creating a label may take up to
                        a minute.
                      </p>
                    </>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <footer>
        <p className="text-xs">
          Private link. Do not share it outside your team. Need help? Contact
          the person who sent it.
        </p>
      </footer>
    </main>
  );
}
