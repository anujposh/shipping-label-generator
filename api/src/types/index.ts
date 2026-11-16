export interface Vendor {
  id: number;
  name: string;
  contact_email: string | null;
  notes: string | null;
  created_at: string | Date;
  archived_at: string | Date | null;
}

export interface VendorInsert {
  name: string;
  contact_email?: string | null;
  notes?: string | null;
}

/** FedEx `TaxpayerIdentification.tinType` (official enum). */
export type VendorTaxIdType =
  | "PERSONAL_NATIONAL"
  | "PERSONAL_STATE"
  | "FEDERAL"
  | "BUSINESS_NATIONAL"
  | "BUSINESS_STATE"
  | "BUSINESS_UNION";

export interface VendorTaxId {
  number: string;
  tinType: VendorTaxIdType;
}

/**
 * Reusable pickup/shipping identity submitted by a shared-link vendor.
 * Persisted on `slg_links.vendor_details` and snapshotted on each shipment.
 */
export interface VendorDetails {
  companyName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zipCode: string;
  countryCode: string;
  taxIds: VendorTaxId[];
}

export interface Link {
  id: number;
  /** NULL for unassigned admin links created without a vendor. */
  vendor_id: number | null;
  /** Business Central company GUID, when the admin picked one at creation. */
  bc_company_id: string | null;
  /** Business Central display name snapshot for that company. */
  bc_company_name: string | null;
  token_hash: string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  max_uses: number | null;
  use_count: number;
  created_by: string;
  ship_from: Record<string, unknown>;
  /** Last validated vendor identity submitted on this link (null for legacy). */
  vendor_details: Record<string, unknown> | null;
  created_at: string | Date;
}

export interface LinkInsert {
  vendor_id: number | null;
  bc_company_id?: string | null;
  bc_company_name?: string | null;
  token_hash: string;
  expires_at: string | Date;
  max_uses?: number | null;
  created_by: string;
  ship_from: Record<string, unknown>;
  vendor_details?: Record<string, unknown> | null;
}

export type ShipmentStatus =
  "draft" | "rated" | "label_created" | "voided" | "expired";

export interface Shipment {
  id: number;
  link_id: number;
  /** Inherited from the link; NULL for shipments on unassigned links. */
  vendor_id: number | null;
  status: ShipmentStatus;
  ship_from: Record<string, unknown>;
  ship_to: Record<string, unknown>;
  packages: Record<string, unknown>;
  selected_rate: Record<string, unknown> | null;
  carrier: string | null;
  service_type: string | null;
  tracking_number: string | null;
  /** Validated FedEx international customs payload, when supplied. */
  customs: Record<string, unknown> | null;
  /** Pickup/drop-off selection persisted from vendor flow. */
  pickup: Record<string, unknown> | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ShipmentInsert {
  link_id: number;
  /** Inherited from the link; NULL for shipments on unassigned links. */
  vendor_id: number | null;
  status?: ShipmentStatus;
  ship_from: Record<string, unknown>;
  ship_to: Record<string, unknown>;
  packages: Record<string, unknown>;
  selected_rate?: Record<string, unknown> | null;
  carrier?: string | null;
  service_type?: string | null;
  tracking_number?: string | null;
  customs?: Record<string, unknown> | null;
  pickup?: Record<string, unknown> | null;
}

/** Persisted customs/generated/uploaded shipment document. */
export interface ShipmentDocumentRow {
  id: number;
  shipment_id: number;
  label_id: number | null;
  document_type: string;
  doc_type: string;
  file_name: string;
  content_base64: string;
  source: "FEDEX_GENERATED" | "UPLOADED";
  upload_status: "ATTACHED" | "UPLOADED" | "FAILED" | null;
  fedex_document_id: string | null;
  created_at: string | Date;
}

export interface ShipmentDocumentInsert {
  shipment_id: number;
  label_id?: number | null;
  document_type: string;
  doc_type: string;
  file_name: string;
  content_base64: string;
  source: "FEDEX_GENERATED" | "UPLOADED";
  upload_status?: "ATTACHED" | "UPLOADED" | "FAILED" | null;
  fedex_document_id?: string | null;
}

export interface Label {
  id: number;
  shipment_id: number;
  label_pdf_base64: string;
  carrier_response: Record<string, unknown> | null;
  label_size: string | null;
  tracking_number: string | null;
  carrier: string | null;
  service_type: string | null;
  voided_at: string | Date | null;
  voided_by: string | null;
  created_at: string | Date;
}

export interface LabelInsert {
  shipment_id: number;
  label_pdf_base64: string;
  carrier_response?: Record<string, unknown> | null;
  label_size?: string | null;
  tracking_number?: string | null;
  carrier?: string | null;
  service_type?: string | null;
}

export interface AdminUser {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  is_active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface AdminUserInsert {
  email: string;
  password_hash: string;
  name?: string | null;
}

export type AuditEventType =
  | "link_created"
  | "link_revoked"
  | "link_expired"
  | "submission_created"
  | "rate_retrieved"
  | "label_created"
  | "label_downloaded"
  | "label_voided"
  | "admin_login_success"
  | "admin_login_failure"
  | "notification_email_sent"
  | "notification_email_failed"
  | "notification_email_skipped";

export type AuditActorType = "vendor" | "admin" | "system";

export interface AuditEvent {
  id: number;
  event_type: AuditEventType;
  actor: string | null;
  actor_type: AuditActorType;
  ip_address: string | null;
  occurred_at: string | Date;
  request_id: string | null;
  link_id: number | null;
  vendor_id: number | null;
  shipment_id: number | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditEventInsert {
  event_type: AuditEventType;
  actor?: string | null;
  actor_type?: AuditActorType;
  ip_address?: string | null;
  request_id?: string | null;
  link_id?: number | null;
  vendor_id?: number | null;
  shipment_id?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface ShipFromAddress {
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}
