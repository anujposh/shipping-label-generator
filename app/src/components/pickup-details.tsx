"use client";

import { AddressFields, Field } from "./fields";
import { emptyAddress, localDate, type Address } from "@/lib/client";
import type { VendorDetails } from "@/lib/vendor";

export type PickupState = {
  type: "pickup" | "dropoff";
  date: string;
  /** True once the user edits the pickup date — stops ship-date sync. */
  dateTouched: boolean;
  readyTime: string;
  closeTime: string;
  instructions: string;
  useDifferentAddress: boolean;
  addressInitialized: boolean;
  address: Address;
  contact: { name: string; phone: string; email: string };
};

export function newPickup(): PickupState {
  return {
    type: "pickup", date: localDate(), dateTouched: false, readyTime: "09:00", closeTime: "17:00",
    instructions: "", useDifferentAddress: false, addressInitialized: false,
    address: { ...emptyAddress }, contact: { name: "", phone: "", email: "" },
  };
}

function vendorAddress(vendor: VendorDetails): Address {
  return {
    name: vendor.contactName, company: vendor.companyName,
    street1: vendor.addressLine1, street2: vendor.addressLine2 ?? "",
    city: vendor.city, state: vendor.state, zip: vendor.zipCode,
    country: vendor.countryCode, phone: vendor.contactPhone,
  };
}

export function PickupDetails({ value, onChange, vendor, carrier, shipDate, error }: {
  value: PickupState;
  onChange: (value: PickupState) => void;
  vendor: VendorDetails;
  carrier: string;
  shipDate: string;
  error: string;
}) {
  const location = value.useDifferentAddress ? value.address : vendorAddress(vendor);
  const update = (patch: Partial<PickupState>) => onChange({ ...value, ...patch });
  return (
    <details className="pickup-details" open>
      <summary>Pickup/drop-off</summary>
      <div className="pickup-content">
        <fieldset className="pickup-method">
          <legend className="sr-only">How will you hand over your shipment?</legend>
          <label><input type="radio" name="pickup-method" checked={value.type === "pickup"} onChange={() => update({ type: "pickup" })} />Schedule new pickup</label>
          <label><input type="radio" name="pickup-method" checked={value.type === "dropoff"} onChange={() => update({ type: "dropoff" })} />Drop off shipment</label>
        </fieldset>
        {value.type === "pickup" ? (
          <>
            <div className="fields pickup-times">
              <Field label="Pickup date" type="date" required min={localDate()} value={value.date} onChange={(e) => update({ date: e.target.value, dateTouched: true })} />
              <Field label="Ready time" type="time" required value={value.readyTime} onChange={(e) => update({ readyTime: e.target.value })} />
              <Field label="Close time" type="time" required value={value.closeTime} onChange={(e) => update({ closeTime: e.target.value })} />
            </div>
            <p className="text-sm">Times are local to the pickup address.</p>
            <div className="pickup-location">
              <span className="eyebrow">Pickup address</span>
              <address>
                <strong>{value.useDifferentAddress ? value.contact.name : location.name}</strong><br />
                {location.company && <>{location.company}<br /></>}
                {location.street1}{location.street2 && <>, {location.street2}</>}<br />
                {location.city}, {location.state} {location.zip}<br />{location.country}
              </address>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={value.useDifferentAddress} onChange={(e) => {
                const checked = e.target.checked;
                update({ useDifferentAddress: checked, ...(checked && !value.addressInitialized ? {
                  addressInitialized: true, address: { ...vendorAddress(vendor) },
                  contact: { name: vendor.contactName, phone: vendor.contactPhone, email: vendor.contactEmail },
                } : {}) });
              }} />Use different pickup address
            </label>
            {value.useDifferentAddress && (
              <div className="pickup-address-fields">
                <AddressFields value={value.address} onChange={(address) => update({ address })} />
                <div className="fields">
                  <Field label="Pickup contact name" required value={value.contact.name} onChange={(e) => update({ contact: { ...value.contact, name: e.target.value } })} />
                  <Field label="Pickup contact phone" type="tel" value={value.contact.phone} onChange={(e) => update({ contact: { ...value.contact, phone: e.target.value } })} />
                  <Field label="Pickup contact email" type="email" value={value.contact.email} onChange={(e) => update({ contact: { ...value.contact, email: e.target.value } })} />
                </div>
              </div>
            )}
            <label>Pickup instructions (optional)
              <textarea maxLength={300} rows={3} value={value.instructions} onChange={(e) => update({ instructions: e.target.value })} />
            </label>
          </>
        ) : (
          <div>
            <p>Drop off at any authorized {carrier} location.</p>
            <dl className="detail-rows"><div><dt>Planned drop-off date</dt><dd>{shipDate}</dd></div></dl>
          </div>
        )}
        {error && <p className="notice error" role="alert">{error}</p>}
      </div>
    </details>
  );
}
