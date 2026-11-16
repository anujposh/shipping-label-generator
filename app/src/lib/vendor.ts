import type { TaxId } from "./customs";
export type VendorDetails = {
  companyName: string; contactName: string; contactEmail: string; contactPhone: string;
  addressLine1: string; addressLine2?: string; city: string; state: string;
  zipCode: string; countryCode: string; taxIds: TaxId[];
};
export const newVendorDetails = (): VendorDetails => ({ companyName: "", contactName: "", contactEmail: "", contactPhone: "", addressLine1: "", addressLine2: "", city: "", state: "", zipCode: "", countryCode: "US", taxIds: [] });
export function validateVendor(value: VendorDetails) {
  const errors: Record<string, string> = {};
  for (const key of Object.keys(newVendorDetails()) as (keyof VendorDetails)[]) {
    if (key !== "addressLine2" && key !== "taxIds" && !value[key].trim()) errors[`vendorDetails.${key}`] = "This field is required.";
  }
  if (value.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.contactEmail)) errors["vendorDetails.contactEmail"] = "Enter a valid email address.";
  if (value.contactPhone && (!/^[\d+() .-]+$/.test(value.contactPhone) || !/\d/.test(value.contactPhone))) errors["vendorDetails.contactPhone"] = "Enter a valid phone number.";
  if (!/^[A-Z]{2}$/.test(value.countryCode)) errors["vendorDetails.countryCode"] = "Enter a two-letter country code.";
  value.taxIds.forEach((tax, i) => { if (!tax.number.trim()) errors[`vendorDetails.taxIds.${i}.number`] = "Enter a tax ID number or remove this row."; });
  return errors;
}
