import { Knex } from "knex";
import { db } from "../db";
import type { AuditEvent, AuditEventInsert } from "../types";

const TABLE = "slg_audit_events";

export async function recordAuditEvent(
  input: AuditEventInsert,
  knex: Knex = db,
): Promise<AuditEvent> {
  const [{ id }] = await knex<AuditEvent>(TABLE)
    .insert({
      event_type: input.event_type,
      actor: input.actor ?? null,
      actor_type: input.actor_type ?? "system",
      ip_address: input.ip_address ?? null,
      request_id: input.request_id ?? null,
      link_id: input.link_id ?? null,
      vendor_id: input.vendor_id ?? null,
      shipment_id: input.shipment_id ?? null,
      metadata: input.metadata ?? null,
    })
    .returning("id");
  const event = await getAuditEventById(id as number, knex);
  if (!event) {
    throw new Error("Audit event insert did not return a row");
  }
  return event;
}

export async function getAuditEventById(
  id: number,
  knex: Knex = db,
): Promise<AuditEvent | null> {
  const rows = await knex<AuditEvent>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function listAuditEvents(
  options: {
    linkId?: number;
    vendorId?: number;
    shipmentId?: number;
    limit?: number;
    offset?: number;
  } = {},
  knex: Knex = db,
): Promise<AuditEvent[]> {
  let query = knex<AuditEvent>(TABLE).orderBy("occurred_at", "desc");
  if (options.linkId !== undefined) {
    query = query.where({ link_id: options.linkId });
  }
  if (options.vendorId !== undefined) {
    query = query.where({ vendor_id: options.vendorId });
  }
  if (options.shipmentId !== undefined) {
    query = query.where({ shipment_id: options.shipmentId });
  }
  if (options.limit !== undefined) {
    query = query.limit(options.limit);
  }
  if (options.offset !== undefined) {
    query = query.offset(options.offset);
  }
  return query;
}
