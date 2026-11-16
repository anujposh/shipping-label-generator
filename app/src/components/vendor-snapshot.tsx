export function VendorSnapshot({ value }: { value: unknown }) {
  let parsed = value;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
  const vendor = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const display = (...keys: string[]) => keys.map(key => vendor[key]).find(value => typeof value === "string" && value.trim()) as string | undefined;
  const taxes = Array.isArray(vendor.taxIds) ? vendor.taxIds as { number?: string; tinType?: string }[] : [];
  return <section className="panel" aria-labelledby="vendor-snapshot-heading"><h2 id="vendor-snapshot-heading">Submitted vendor details</h2><p className="text-sm">Sender details saved with this shipment.</p>
    <dl className="fields">
      {[["Company", display("companyName", "company")], ["Contact", display("contactName", "name")], ["Email", display("contactEmail", "email")], ["Phone", display("contactPhone", "phone")]].map(([label, value]) => <div key={label}><dt className="eyebrow">{label}</dt><dd className="break-words">{value ?? "Not provided"}</dd></div>)}
      <div><dt className="eyebrow">Pickup address</dt><dd>{[display("addressLine1", "street", "street1"), display("addressLine2", "street2"), [display("city"), display("state"), display("zipCode", "zip")].filter(Boolean).join(", "), display("countryCode", "country")].filter(Boolean).map((line, i) => <div key={i}>{line}</div>)}{!Object.keys(vendor).length && "Not provided"}</dd></div>
      <div><dt className="eyebrow">Tax IDs</dt><dd>{taxes.length ? taxes.map((tax, i) => <div key={i}>{tax.tinType?.replaceAll("_", " ")}: {tax.number}</div>) : "Not provided"}</dd></div>
    </dl>
  </section>;
}
