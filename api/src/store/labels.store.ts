import { Knex } from "knex";
import { db } from "../db";
import type { Label, LabelInsert } from "../types";

const TABLE = "slg_labels";

export async function createLabel(
  row: LabelInsert,
  knex: Knex = db,
): Promise<Label> {
  const [{ id }] = await knex<Label>(TABLE)
    .insert({
      shipment_id: row.shipment_id,
      label_pdf_base64: row.label_pdf_base64,
      carrier_response: row.carrier_response ?? null,
      label_size: row.label_size ?? null,
      tracking_number: row.tracking_number ?? null,
      carrier: row.carrier ?? null,
      service_type: row.service_type ?? null,
    })
    .returning("id");
  const label = await getLabelById(id as number, knex);
  if (!label) {
    throw new Error("Label insert did not return a row");
  }
  return label;
}

export async function getLabelById(
  id: number,
  knex: Knex = db,
): Promise<Label | null> {
  const rows = await knex<Label>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function getLabelsByShipment(
  shipmentId: number,
  knex: Knex = db,
): Promise<Label[]> {
  return knex<Label>(TABLE)
    .where({ shipment_id: shipmentId })
    .orderBy("created_at", "desc");
}

/**
 * All labels across every shipment belonging to a link. Vendor conflict
 * checks must scope by link (join through slg_shipments.link_id) — passing
 * a link id into getLabelsByShipment() collides with unrelated shipments
 * whose numeric id equals the link id.
 */
export async function getLabelsByLink(
  linkId: number,
  knex: Knex = db,
): Promise<Label[]> {
  return knex<Label>(`${TABLE} as label`)
    .join("slg_shipments as shipment", "label.shipment_id", "shipment.id")
    .where("shipment.link_id", linkId)
    .select("label.*")
    .orderBy("label.created_at", "desc");
}

export async function latestLabelByShipment(
  shipmentId: number,
  knex: Knex = db,
): Promise<Label | null> {
  const rows = await knex<Label>(TABLE)
    .where({ shipment_id: shipmentId })
    .orderBy("created_at", "desc")
    .limit(1);
  return rows[0] ?? null;
}

export async function markLabelVoided(
  id: number,
  voidedBy: string,
  knex: Knex = db,
): Promise<Label | null> {
  const existing = await getLabelById(id, knex);
  if (!existing || existing.voided_at !== null) return null;

  await knex<Label>(TABLE)
    .where({ id })
    .update({ voided_at: knex.fn.now(), voided_by: voidedBy });
  return getLabelById(id, knex);
}
