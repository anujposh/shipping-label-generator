"use client";
import type { Address } from "@/lib/client";
import { useId } from "react";
export function Field({ label, error, suppressRequired, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; suppressRequired?: boolean }) {
  const id = useId();
  const errorId = `${id}-error`;
  const required = !suppressRequired && props.required;
  return <label className={error ? "field-error" : undefined}>{label}{required ? " *" : ""}<input {...props} required={required} aria-label={props["aria-label"] ?? `${label}${required ? " *" : ""}`} aria-invalid={error ? true : undefined} aria-describedby={[props["aria-describedby"], error ? errorId : undefined].filter(Boolean).join(" ") || undefined} />{error && <span id={errorId} className="field-error-message" aria-live="polite">{error}</span>}</label>;
}
export function validateAddress(value: Address): Partial<Record<keyof Address, string>> {
  const errors: Partial<Record<keyof Address, string>> = {};
  for (const key of Object.keys(value) as (keyof Address)[]) {
    if (!["company", "street2"].includes(key) && !value[key].trim()) errors[key] = "This field is required.";
  }
  if (value.country.trim() && !/^[A-Za-z]{2}$/.test(value.country.trim())) errors.country = "Enter a two-letter country code, for example US.";
  if (value.phone.trim() && (!/^[\d+() .-]+$/.test(value.phone.trim()) || !/\d/.test(value.phone))) errors.phone = "Enter a phone number, for example 512-555-1234. Use digits, +, parentheses, spaces, dots or hyphens.";
  return errors;
}
const examples: Address = { name: "John Smith", company: "Acme Co.", street1: "555 Main St", street2: "Suite 200", city: "Austin", state: "TX", zip: "78701", country: "US", phone: "512-555-1234" };
export function AddressFields({ value, onChange, errors = {}, onBlur, suppressRequired }: { value: Address; onChange: (v: Address) => void; errors?: Partial<Record<keyof Address, string>>; onBlur?: (key: keyof Address) => void; suppressRequired?: boolean }) {
  const fields: [keyof Address, string, boolean][] = [["name", "Full name", true], ["company", "Company", false], ["street1", "Street address", true], ["street2", "Apartment / suite", false], ["city", "City", true], ["state", "State / province", true], ["zip", "ZIP / postal code", true], ["country", "Country code (e.g. US)", true], ["phone", "Phone", true]];
  return <div className="fields">{fields.map(([key, label, required]) => <Field key={key} label={label} required={required} suppressRequired={suppressRequired} value={value[key]} placeholder={examples[key]} error={errors[key]} onBlur={() => onBlur?.(key)} maxLength={key === "country" ? 2 : 120} minLength={key === "country" ? 2 : undefined} pattern={key === "country" ? "[A-Za-z]{2}" : undefined} type={key === "phone" ? "tel" : "text"} onChange={e => onChange({ ...value, [key]: e.target.value })} />)}</div>;
}
