"use client";
import { useId, useState } from "react";
import { Field } from "./fields";
import {
  newCommodity,
  totals,
  type Customs,
  type Party,
  type TaxId,
  type Upload,
} from "@/lib/customs";

function Choice({
  label,
  value,
  options,
  onChange,
  error,
  labels,
}: {
  label: string;
  value: string;
  options: string[];
  error?: string;
  labels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <label>
      {label}
      <select
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? id : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((x) => (
          <option key={x} value={x}>
            {labels?.[x] ?? x.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      {error && (
        <span id={id} className="field-error-message" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
export function TaxFields({
  value = [],
  onChange,
  errors = {},
  prefix = "taxIds",
}: {
  value?: TaxId[];
  onChange: (v: TaxId[]) => void;
  errors?: Record<string, string>;
  prefix?: string;
}) {
  return (
    <>
      {value.map((tax, i) => (
        <div className="fields package" key={i}>
          <Field
            label="Tax ID"
            required
            error={errors[`${prefix}.${i}.number`]}
            value={tax.number}
            placeholder="123456789"
            onChange={(e) =>
              onChange(
                value.map((t, n) =>
                  n === i ? { ...t, number: e.target.value } : t,
                ),
              )
            }
          />
          <Choice
            label="Tax ID type"
            value={tax.tinType}
            options={[
              "PERSONAL_NATIONAL",
              "PERSONAL_STATE",
              "FEDERAL",
              "BUSINESS_NATIONAL",
              "BUSINESS_STATE",
              "BUSINESS_UNION",
            ]}
            labels={{
              PERSONAL_NATIONAL: "Personal - national",
              PERSONAL_STATE: "Personal - state",
              FEDERAL: "Federal",
              BUSINESS_NATIONAL: "Business - national",
              BUSINESS_STATE: "Business - state",
              BUSINESS_UNION: "Business - union",
            }}
            onChange={(tinType) =>
              onChange(
                value.map((t, n) =>
                  n === i ? { ...t, tinType: tinType as TaxId["tinType"] } : t,
                ),
              )
            }
          />
          <button
            type="button"
            className="secondary"
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            Remove tax ID {i + 1}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onChange([...value, { number: "", tinType: "BUSINESS_NATIONAL" }])
        }
      >
        Add tax ID
      </button>
    </>
  );
}
function PartyFields({
  value,
  onChange,
  prefix,
  errors,
  account = false,
}: {
  value: Party;
  onChange: (v: Party) => void;
  prefix: string;
  errors: Record<string, string>;
  account?: boolean;
}) {
  return (
    <div className="package">
      <div className="fields">
        {(
          [
            ...(account ? [["accountNumber", "FedEx account number"]] : []),
            ["contactName", "Contact name"],
            ["companyName", "Company"],
            ["contactPhone", "Phone"],
            ["contactEmail", "Email"],
          ] as [keyof Party, string][]
        ).map(([key, label]) => (
          <Field
            key={key}
            label={label}
            required={["accountNumber", "contactName", "contactPhone"].includes(
              key,
            )}
            value={String(value[key] ?? "")}
            error={errors[`${prefix}.${key}`]}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        ))}
        {(
          [
            ["addressLine1", "Street address"],
            ["addressLine2", "Address line 2"],
            ["city", "City"],
            ["state", "State / province"],
            ["zipCode", "Postal code"],
            ["countryCode", "Country code"],
          ] as const
        ).map(([key, label]) => (
          <Field
            key={key}
            label={label}
            required={["addressLine1", "city", "countryCode"].includes(key)}
            value={value.address?.[key] ?? ""}
            error={errors[`${prefix}.address.${key}`]}
            onChange={(e) =>
              onChange({
                ...value,
                address: {
                  addressLine1: "",
                  city: "",
                  state: "",
                  zipCode: "",
                  countryCode: "",
                  ...value.address,
                  [key]:
                    key === "countryCode"
                      ? e.target.value.toUpperCase()
                      : e.target.value,
                },
              })
            }
          />
        ))}
      </div>
      <h3>Tax identification</h3>
      <TaxFields
        value={value.taxIds}
        onChange={(taxIds) => onChange({ ...value, taxIds })}
      />
    </div>
  );
}
const generated = [
  "COMMERCIAL_INVOICE",
  "PRO_FORMA_INVOICE",
  "CERTIFICATE_OF_ORIGIN",
  "USMCA_CERTIFICATION_OF_ORIGIN",
  "USMCA_COMMERCIAL_INVOICE_CERTIFICATION_OF_ORIGIN",
];
export function CustomsFields({
  value: c,
  onChange,
  errors,
  onUploading,
}: {
  value: Customs;
  onChange: (c: Customs) => void;
  errors: Record<string, string>;
  onUploading: (busy: boolean) => void;
}) {
  const [uploadError, setUploadError] = useState("");
  const set = (patch: Partial<Customs>) => onChange({ ...c, ...patch });
  const text = (
    key:
      | "documentDescription"
      | "invoiceNumber"
      | "shipmentReference"
      | "exportComplianceStatement"
      | "declarationStatement"
      | "specialInstructions"
      | "originatorName",
    label: string,
    required = false,
  ) => (
    <Field
      label={label}
      required={required}
      value={c[key] ?? ""}
      error={errors[`customs.${key}`]}
      onChange={(e) => set({ [key]: e.target.value })}
    />
  );
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploadError("");
    if (files.length + c.documents.uploads.length > 5) {
      setUploadError("Upload at most 5 files.");
      return;
    }
    if (
      Array.from(files).some((f) => f.size > 5 * 1024 * 1024 || f.size === 0)
    ) {
      setUploadError("Each file must be nonempty and no larger than 5 MiB.");
      return;
    }
    if (
      Array.from(files).some(
        (f) =>
          ![
            "application/pdf",
            "image/png",
            "image/jpeg",
            "image/tiff",
            "text/plain",
          ].includes(f.type),
      )
    ) {
      setUploadError("Choose PDF, PNG, JPEG, TIFF or text files.");
      return;
    }
    onUploading(true);
    try {
      const uploads = await Promise.all(
        Array.from(files).map(
          (file) =>
            new Promise<Upload>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () =>
                reject(
                  new Error("Unable to read file. Please select it again."),
                );
              reader.onload = () =>
                resolve({
                  fileName: file.name,
                  contentType: file.type,
                  shipDocumentType: "COMMERCIAL_INVOICE",
                  contentBase64: String(reader.result).split(",")[1],
                });
              reader.readAsDataURL(file);
            }),
        ),
      );
      set({
        documents: {
          ...c.documents,
          uploads: [...c.documents.uploads, ...uploads],
        },
      });
    } catch {
      setUploadError("Unable to read file. Please select it again.");
    } finally {
      onUploading(false);
    }
  }
  const sum = totals(c);
  return (
    <section className="customs" aria-labelledby="customs-heading">
      <h2 id="customs-heading">International customs</h2>
      <p>
        Describe exactly what you are sending. You are responsible for
        classifications and export requirements.
      </p>
      <Choice
        label="Shipment contents"
        value={c.isDocumentOnly ? "DOCUMENTS_ONLY" : "COMMODITIES"}
        options={["COMMODITIES", "DOCUMENTS_ONLY"]}
        onChange={(v) => set({ isDocumentOnly: v === "DOCUMENTS_ONLY" })}
      />
      {c.isDocumentOnly && (
        <>
          {text("documentDescription", "Document description", true)}
          <Field
            label={`Declared customs value (${c.currency})`}
            required
            type="number"
            min="0"
            step="any"
            value={
              Number.isFinite(c.totalCustomsValue.amount)
                ? c.totalCustomsValue.amount
                : ""
            }
            error={errors["customs.totalCustomsValue.amount"]}
            onChange={(e) =>
              set({
                totalCustomsValue: {
                  amount: e.target.valueAsNumber,
                  currency: c.currency,
                },
              })
            }
          />
          <p className="text-sm">
            Some destinations require a positive nominal value for documents.
            Declare the value accurately in {c.currency}.
          </p>
        </>
      )}
      <div className="fields mt-4">
        <Choice
          label="Shipment purpose"
          value={c.shipmentPurpose}
          options={[
            "COMMERCIAL",
            "GIFT",
            "SAMPLE",
            "REPAIR_AND_RETURN",
            "PERSONAL_EFFECTS",
            "NOT_COMMERCIAL",
          ]}
          onChange={(shipmentPurpose) => set({ shipmentPurpose })}
        />
        {text("invoiceNumber", "Invoice number", false)}
        {text("shipmentReference", "Shipment reference")}
        <Choice
          label="Terms of sale (Incoterm)"
          value={c.termsOfSale}
          options={[
            "DAP",
            "DDP",
            "EXW",
            "FCA",
            "CPT",
            "CIP",
            "DPU",
            "FAS",
            "FOB",
            "CFR",
            "CIF",
          ]}
          onChange={(termsOfSale) => set({ termsOfSale })}
        />
        <Field
          label="Shipment currency"
          required
          maxLength={3}
          value={c.currency}
          error={errors["customs.currency"]}
          onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
        />
      </div>
      <p className="text-sm">
        One currency per shipment. Changing the currency does not convert prices
        or update item currencies; review each amount and currency.
      </p>
      {!c.isDocumentOnly && (
        <>
          <h3>Commodities</h3>
          {c.commodities.map((item, i) => (
            <fieldset className="package" key={i}>
              <legend>Commodity {i + 1}</legend>
              <div className="fields">
                {(
                  [
                    ["name", "Item name"],
                    ["description", "Detailed description"],
                    ["intendedUse", "Intended use"],
                    ["hsCode", "HS code"],
                    ["countryOfManufacture", "Country of manufacture"],
                    ["quantityUnits", "Quantity units"],
                    ["currency", "Item currency"],
                  ] as const
                ).map(([key, label]) => (
                  <Field
                    key={key}
                    label={label}
                    required
                    value={item[key]}
                    error={errors[`customs.commodities.${i}.${key}`]}
                    onChange={(e) =>
                      set({
                        commodities: c.commodities.map((x, n) =>
                          n === i
                            ? {
                                ...x,
                                [key]: [
                                  "currency",
                                  "countryOfManufacture",
                                ].includes(key)
                                  ? e.target.value.toUpperCase()
                                  : e.target.value,
                              }
                            : x,
                        ),
                      })
                    }
                  />
                ))}
                {(
                  [
                    ["quantity", "Quantity"],
                    ["weight", "Total line weight (not per item)"],
                    ["unitPrice", "Unit price"],
                  ] as const
                ).map(([key, label]) => (
                  <Field
                    key={key}
                    label={label}
                    required
                    type="number"
                    min="0"
                    step={key === "quantity" ? "1" : "any"}
                    value={Number.isFinite(item[key]) ? item[key] : ""}
                    error={errors[`customs.commodities.${i}.${key}`]}
                    onChange={(e) =>
                      set({
                        commodities: c.commodities.map((x, n) =>
                          n === i ? { ...x, [key]: e.target.valueAsNumber } : x,
                        ),
                      })
                    }
                  />
                ))}
                <Choice
                  label="Weight units"
                  value={item.weightUnits}
                  options={["LB", "KG"]}
                  onChange={(v) =>
                    set({
                      commodities: c.commodities.map((x, n) =>
                        n === i ? { ...x, weightUnits: v as "LB" | "KG" } : x,
                      ),
                    })
                  }
                />
                <Choice
                  label="Item purpose"
                  value={item.purpose ?? "BUSINESS"}
                  options={["BUSINESS", "CONSUMER"]}
                  onChange={(purpose) =>
                    set({
                      commodities: c.commodities.map((x, n) =>
                        n === i ? { ...x, purpose } : x,
                      ),
                    })
                  }
                />
              </div>
              <p>
                Line value:{" "}
                {Number.isFinite(item.quantity * item.unitPrice)
                  ? (item.quantity * item.unitPrice).toFixed(2)
                  : "--"}{" "}
                {item.currency}
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  set({ commodities: c.commodities.filter((_, n) => n !== i) })
                }
              >
                Remove commodity {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="secondary mt-4"
            onClick={() =>
              set({ commodities: [...c.commodities, newCommodity(c.currency)] })
            }
          >
            Add commodity
          </button>
        </>
      )}
      <div className="shipping-summary" aria-live="polite">
        Customs value:{" "}
        {Number.isFinite(sum.amount) ? sum.amount.toFixed(2) : "--"}{" "}
        {c.currency}
        <br />
        Commodity weight:{" "}
        {Number.isFinite(sum.weight) ? sum.weight.toFixed(3) : "--"} lb
      </div>
      {errors["customs.commodities"] && (
        <p role="alert" className="field-error-message">
          {errors["customs.commodities"]}
        </p>
      )}
      <h3>Duties and taxes</h3>
      <Choice
        label="Duties payer"
        value={c.dutiesPayment.paymentType}
        options={["SENDER", "RECIPIENT", "THIRD_PARTY"]}
        onChange={(paymentType) =>
          set({
            dutiesPayment: {
              paymentType,
              ...(paymentType === "THIRD_PARTY"
                ? { payor: { contactName: "" } }
                : {}),
            },
          })
        }
      />
      {c.dutiesPayment.paymentType === "THIRD_PARTY" && (
        <PartyFields
          account
          value={c.dutiesPayment.payor ?? { contactName: "" }}
          prefix="customs.dutiesPayment.payor"
          errors={errors}
          onChange={(payor) =>
            set({ dutiesPayment: { ...c.dutiesPayment, payor } })
          }
        />
      )}
      <details>
        <summary>Parties and tax identification</summary>
        <p>
          Your vendor details supply the shipper, exporter, and shipper tax IDs.
          Use Edit details to update them.
        </p>
        <h3>Recipient tax IDs</h3>
        <TaxFields
          value={c.recipientTaxIds}
          onChange={(recipientTaxIds) => set({ recipientTaxIds })}
        />
        {([["importerOfRecord", "Specify importer of record"]] as const).map(
          ([key, label]) => (
            <div key={key}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!!c[key]}
                  onChange={(e) =>
                    set({
                      [key]: e.target.checked ? { contactName: "" } : undefined,
                    })
                  }
                />
                {label}
              </label>
              {c[key] && (
                <PartyFields
                  value={c[key]}
                  prefix={`customs.${key}`}
                  errors={errors}
                  onChange={(v) => set({ [key]: v })}
                />
              )}
            </div>
          ),
        )}
      </details>
      <details>
        <summary>Charges, declarations and export information</summary>
        <div className="fields">
          {[
            "freight",
            "insurance",
            "taxesOrMiscellaneous",
            "packing",
            "handling",
          ].map((key) => (
            <Field
              key={key}
              label={`${key.replace(/([A-Z])/g, " $1")} (${c.currency})`}
              type="number"
              min="0"
              step="any"
              value={c.charges?.[key]?.amount ?? ""}
              error={errors[`customs.charges.${key}.amount`]}
              onChange={(e) => {
                const charges = { ...c.charges };
                if (e.target.value === "") delete charges[key];
                else
                  charges[key] = {
                    amount: e.target.valueAsNumber,
                    currency: c.currency,
                  };
                set({ charges });
              }}
            />
          ))}
          {text("originatorName", "Invoice originator")}
          {text("declarationStatement", "Declaration statement")}
          {text("specialInstructions", "Special instructions")}
          <Field
            label="Comments (one per line separated by semicolons)"
            value={c.comments?.join("; ") ?? ""}
            onChange={(e) =>
              set({
                comments: e.target.value
                  .split(";")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={c.relatedParties ?? false}
            onChange={(e) => set({ relatedParties: e.target.checked })}
          />
          Sender and recipient are related parties
        </label>
      </details>
      <Choice
        label="Canadian export filing (B13A)"
        value={c.b13AFilingOption ?? ""}
        options={[
          "",
          "NOT_REQUIRED",
          "MANUALLY_ATTACHED",
          "FILED_ELECTRONICALLY",
          "SUMMARY_REPORTING",
          "FEDEX_TO_STAMP",
        ]}
        labels={{
          "": "Select if applicable",
          NOT_REQUIRED: "Not required",
          MANUALLY_ATTACHED: "Manually attached",
          FILED_ELECTRONICALLY: "Filed electronically",
          SUMMARY_REPORTING: "Summary reporting",
          FEDEX_TO_STAMP: "FedEx to stamp",
        }}
        error={errors["customs.b13AFilingOption"]}
        onChange={(b13AFilingOption) =>
          set({ b13AFilingOption: b13AFilingOption || undefined })
        }
      />
      <p className="text-sm">
        Required for goods exported from Canada outside Canada, the US, Puerto
        Rico and the US Virgin Islands. This is separate from any export
        compliance statement.
      </p>
      {text(
        "exportComplianceStatement",
        "Export compliance statement / exemption citation",
      )}
      <h3>Trade documents</h3>
      <p className="text-sm">
        FedEx and destination acceptance varies. Physical originals may still be
        required even with electronic trade documents (ETD).
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={c.documents.etdEnabled}
          onChange={(e) =>
            set({
              documents: {
                ...c.documents,
                etdEnabled: e.target.checked,
                uploads: e.target.checked ? c.documents.uploads : [],
              },
            })
          }
        />
        Use electronic trade documents (ETD)
      </label>
      <p>Generate documents</p>
      {generated.map((type) => (
        <label className="check-row" key={type}>
          <input
            type="checkbox"
            checked={c.documents.generatedTypes.includes(type)}
            onChange={(e) =>
              set({
                documents: {
                  ...c.documents,
                  generatedTypes: e.target.checked
                    ? [...c.documents.generatedTypes, type]
                    : c.documents.generatedTypes.filter((t) => t !== type),
                },
              })
            }
          />
          {type.replaceAll("_", " ")}
        </label>
      ))}
      {c.documents.etdEnabled && (
        <>
          <Choice
            label="Upload timing"
            value={c.documents.uploadTiming}
            options={["PRE_SHIPMENT", "POST_SHIPMENT"]}
            onChange={(uploadTiming) =>
              set({ documents: { ...c.documents, uploadTiming } })
            }
          />
          <p className="text-sm">
            Before shipment: upload must succeed before creating a label. After
            shipment: a failed upload does not cancel the label; do not create
            another label.
          </p>
          <Field
            label="Upload trade documents (up to 5 files, 5 MiB each)"
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt"
            error={uploadError || errors["customs.documents.uploads"]}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
          {c.documents.uploads.map((file, i) => (
            <div className="package" key={i}>
              <p className="break-all">{file.fileName}</p>
              <Choice
                label={`Document type for ${file.fileName}`}
                value={file.shipDocumentType}
                options={[...generated, "ETD_LABEL", "OTHER"]}
                onChange={(shipDocumentType) =>
                  set({
                    documents: {
                      ...c.documents,
                      uploads: c.documents.uploads.map((f, n) =>
                        n === i ? { ...f, shipDocumentType } : f,
                      ),
                    },
                  })
                }
              />
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  set({
                    documents: {
                      ...c.documents,
                      uploads: c.documents.uploads.filter((_, n) => n !== i),
                    },
                  })
                }
              >
                Remove {file.fileName}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
