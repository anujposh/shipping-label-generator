"use client";
import { Field } from "./fields";
import { TaxFields } from "./customs-fields";
import type { VendorDetails } from "@/lib/vendor";
export function VendorFields({
  value,
  onChange,
  errors,
  onBlur,
}: {
  value: VendorDetails;
  onChange: (value: VendorDetails) => void;
  errors: Record<string, string>;
  onBlur: (key: string) => void;
}) {
  return (
    <section aria-labelledby="vendor-heading" className="package">
      <div className="eyebrow">01 / Sender</div>
      <h2 id="vendor-heading">Pickup information</h2>
      <p>
        Enter your company details and the address your package ships from.
        These details are reused on this link; you can update them for your next
        shipment. No account needed.
      </p>
      <p className="text-sm">
        Fields marked * are required. Your company is the shipper and, for
        international FedEx shipments, the exporter.
      </p>
      <div className="fields">
        {(
          [
            ["companyName", "Company name", "Acme Co."],
            ["contactName", "Contact name", "John Smith"],
            ["contactEmail", "Contact email", "john@example.com"],
            ["contactPhone", "Contact phone", "512-555-1234"],
            ["addressLine1", "Pickup street address", "555 Main St"],
            ["addressLine2", "Pickup apartment / suite", "Suite 200"],
            ["city", "Pickup city", "Austin"],
            ["state", "Pickup state / province", "TX"],
            ["zipCode", "Pickup ZIP / postal code", "78701"],
            ["countryCode", "Pickup country code (e.g. US)", "US"],
          ] as const
        ).map(([key, label, placeholder]) => (
          <Field
            key={key}
            label={label}
            required={key !== "addressLine2"}
            value={value[key] ?? ""}
            placeholder={placeholder}
            type={
              key === "contactEmail"
                ? "email"
                : key === "contactPhone"
                  ? "tel"
                  : "text"
            }
            maxLength={key === "countryCode" ? 2 : 200}
            error={errors[`vendorDetails.${key}`]}
            onBlur={() => onBlur(`vendorDetails.${key}`)}
            onChange={(e) =>
              onChange({
                ...value,
                [key]:
                  key === "countryCode"
                    ? e.target.value.toUpperCase()
                    : e.target.value,
              })
            }
          />
        ))}
      </div>
      <h3 className="mt-6">Company tax IDs (optional)</h3>
      <p className="text-sm">
        Add any tax IDs needed for shipping or customs. Do not enter carrier
        account credentials.
      </p>
      <TaxFields
        value={value.taxIds}
        onChange={(taxIds) => onChange({ ...value, taxIds })}
        errors={errors}
        prefix="vendorDetails.taxIds"
      />
    </section>
  );
}
