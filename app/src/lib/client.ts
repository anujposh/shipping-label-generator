export class ApiError extends Error {
  constructor(public status: number, public data: Record<string, unknown>) {
    const code = String(data.error ?? "");
    super(status === 429 ? "Please wait a moment before trying again. Too many requests were made." : status >= 500 ? "Shipping is temporarily unavailable. Please try again shortly." : status === 401 ? "Your session has ended. Please sign in again." : code === "link_expired" ? "This link has expired. Ask your contact for a new shipping link." : code === "link_revoked" ? "This link has been revoked. Please contact the team that sent it." : code === "link_exhausted" ? "All labels available on this link have been used." : status === 409 ? "A label has already been created. Download it from shipment status." : "We couldn't complete that request. Check your details and try again.");
  }
}
export async function request<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(url, { method: method ?? (body ? "POST" : "GET"), cache: "no-store", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
export function message(error: unknown) { return error instanceof Error ? error.message : "Unable to connect. Please try again."; }
export type Address = { name: string; company: string; street1: string; street2: string; city: string; state: string; zip: string; country: string; phone: string };
export const emptyAddress: Address = { name: "", company: "", street1: "", street2: "", city: "", state: "", zip: "", country: "US", phone: "" };

/** Vendor address as the api service expects it (seam-native field names). */
export type ApiAddress = {
  addressLine1: string; addressLine2?: string; city: string; state: string;
  zipCode: string; countryCode: string; contactName?: string;
  companyName?: string; contactPhone?: string;
};
export function toApiAddress(a: Address): ApiAddress {
  return {
    addressLine1: a.street1, ...(a.street2 ? { addressLine2: a.street2 } : {}),
    city: a.city, state: a.state, zipCode: a.zip, countryCode: a.country || "US",
    contactName: a.name, ...(a.company ? { companyName: a.company } : {}),
    ...(a.phone ? { contactPhone: a.phone } : {}),
  };
}

/** Rate as returned by the api service (seam-native fields). */
export type Rate = { carrier: string; service: string; cost: number; currency?: string; serviceDescription?: string; deliveryDays?: string; deliveryDate?: string };

/** Calendar dates must stay local rather than shifting across a UTC boundary. */
export function localDate(daysAhead = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type ShipmentCreateRequest = {
  vendorDetails: import("./vendor").VendorDetails;
  shipTo: ApiAddress;
  packages: { weight: number; length: number; width: number; height: number }[];
  carrier: string;
  packagingType: string;
  shipDate: string;
  pickup: {
    type: "pickup" | "dropoff";
    date?: string;
    readyTime?: string;
    closeTime?: string;
    instructions?: string;
    address?: ApiAddress;
  };
  serviceType: string;
  customs?: unknown;
  notification?: { enabled: boolean; recipientEmail?: string; shipperEmail?: string; additionalEmail?: string; personalMessage?: string };
};
