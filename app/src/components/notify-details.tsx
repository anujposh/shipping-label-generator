"use client";

import { useId } from "react";

export type NotifyState = {
  enabled: boolean;
  recipientEmail: string;
  shipperEmail: string;
  additionalEmail: string;
  includeMessage: boolean;
  personalMessage: string;
};

export type NotifyEmailField = "recipientEmail" | "shipperEmail" | "additionalEmail";

export function newNotify(vendorEmail = ""): NotifyState {
  return { enabled: false, recipientEmail: "", shipperEmail: vendorEmail, additionalEmail: "", includeMessage: false, personalMessage: "" };
}

export function NotifyDetails({ value, onChange, onEmailChange, error }: {
  value: NotifyState;
  onChange: (value: NotifyState) => void;
  onEmailChange: (field: NotifyEmailField, email: string) => void;
  error: string;
}) {
  const id = useId();
  return (
    <details className="pickup-details" data-notify-details>
      <summary>Email notifications</summary>
      <div className="pickup-content">
        <fieldset className="pickup-method">
          <legend className="sr-only">Email notifications</legend>
          <label className="check-row">
            <input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />
            Add shipment notifications
          </label>
        </fieldset>
        {value.enabled && (
          <>
            <div className="fields">
              {([
                ["recipientEmail", "Recipient email address"],
                ["shipperEmail", "Shipper email address"],
                ["additionalEmail", "Additional email (optional)"],
              ] as const).map(([field, label]) => (
                <label key={field}>
                  {label}
                  <input type="email" autoComplete="off" name={field} value={value[field]}
                    aria-invalid={!!error && (value[field].trim() ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value[field].trim()) : ![value.recipientEmail, value.shipperEmail, value.additionalEmail].some((email) => email.trim()))}
                    aria-describedby={[field === "additionalEmail" ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined}
                    onChange={(e) => onEmailChange(field, e.target.value)} />
                  {field === "additionalEmail" && <span id={`${id}-help`} className="text-sm">Send copy custom address.</span>}
                </label>
              ))}
            </div>
            <label className="check-row">
              <input type="checkbox" checked={value.includeMessage} onChange={(e) => onChange({ ...value, includeMessage: e.target.checked })} />
              Include personalized message
            </label>
            {value.includeMessage && (
              <label>
                Personal message
                <textarea rows={3} maxLength={500} value={value.personalMessage}
                  onChange={(e) => onChange({ ...value, personalMessage: e.target.value })} />
              </label>
            )}
          </>
        )}
        {error && <div id={`${id}-error`} className="notice error" role="alert">{error}</div>}
      </div>
    </details>
  );
}
