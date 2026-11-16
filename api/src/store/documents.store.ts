import { Knex } from "knex";
import { db } from "../db";
import type { ShipmentDocumentInsert, ShipmentDocumentRow } from "../types";

const TABLE = "slg_documents";

export async function createDocument(
  row: ShipmentDocumentInsert,
  knex: Knex = db,
): Promise<ShipmentDocumentRow> {
  const [{ id }] = await knex<ShipmentDocumentRow>(TABLE)
    .insert({
      shipment_id: row.shipment_id,
      label_id: row.label_id ?? null,
      document_type: row.document_type,
      doc_type: row.doc_type,
      file_name: row.file_name,
      content_base64: row.content_base64,
      source: row.source,
      upload_status: row.upload_status ?? null,
      fedex_document_id: row.fedex_document_id ?? null,
    })
    .returning("id");
  const document = await getDocumentById(id as number, knex);
  if (!document) {
    throw new Error("Document insert did not return a row");
  }
  return document;
}

export async function getDocumentById(
  id: number,
  knex: Knex = db,
): Promise<ShipmentDocumentRow | null> {
  const rows = await knex<ShipmentDocumentRow>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function listDocumentsByShipment(
  shipmentId: number,
  knex: Knex = db,
): Promise<ShipmentDocumentRow[]> {
  return knex<ShipmentDocumentRow>(TABLE)
    .where({ shipment_id: shipmentId })
    .orderBy("created_at", "asc")
    .orderBy("id", "asc");
}

/**
 * Idempotent persistence: a document is unique per (shipment, type, source,
 * file name) so a retried create response never duplicates stored bytes.
 */
export async function upsertDocument(
  row: ShipmentDocumentInsert,
  knex: Knex = db,
): Promise<ShipmentDocumentRow> {
  const existing = await knex<ShipmentDocumentRow>(TABLE)
    .where({
      shipment_id: row.shipment_id,
      document_type: row.document_type,
      source: row.source,
      file_name: row.file_name,
    })
    .limit(1);
  if (existing[0]) return existing[0];
  return createDocument(row, knex);
}

export async function deleteDocumentsByShipment(
  shipmentId: number,
  knex: Knex = db,
): Promise<number> {
  return knex<ShipmentDocumentRow>(TABLE)
    .where({ shipment_id: shipmentId })
    .del();
}
