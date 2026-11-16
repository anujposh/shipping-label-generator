import { Knex } from "knex";
import { db } from "../db";
import type { Shipment, ShipmentInsert, ShipmentStatus } from "../types";

const TABLE = "slg_shipments";

export async function createShipment(
  row: ShipmentInsert,
  knex: Knex = db,
): Promise<Shipment> {
  const [{ id }] = await knex<Shipment>(TABLE)
    .insert({
      link_id: row.link_id,
      vendor_id: row.vendor_id,
      status: row.status ?? "draft",
      ship_from: row.ship_from,
      ship_to: row.ship_to,
      // JS arrays bind as Postgres array literals, not JSON — stringify so
      // the jsonb column receives valid JSON (objects knex/pg handles fine).
      packages: JSON.stringify(row.packages) as unknown as Record<
        string,
        unknown
      >,
      selected_rate: row.selected_rate ?? null,
      carrier: row.carrier ?? null,
      service_type: row.service_type ?? null,
      tracking_number: row.tracking_number ?? null,
      customs: row.customs ?? null,
      pickup: row.pickup ?? null,
    })
    .returning("id");
  const shipment = await getShipmentById(id as number, knex);
  if (!shipment) {
    throw new Error("Shipment insert did not return a row");
  }
  return shipment;
}

export async function getShipmentById(
  id: number,
  knex: Knex = db,
): Promise<Shipment | null> {
  const rows = await knex<Shipment>(TABLE).where({ id }).limit(1);
  return rows[0] ?? null;
}

export async function getShipmentsByLink(
  linkId: number,
  knex: Knex = db,
): Promise<Shipment[]> {
  return knex<Shipment>(TABLE)
    .where({ link_id: linkId })
    .orderBy("created_at", "desc");
}

export async function listShipmentsByVendor(
  vendorId: number,
  knex: Knex = db,
): Promise<Shipment[]> {
  return knex<Shipment>(TABLE)
    .where({ vendor_id: vendorId })
    .orderBy("created_at", "desc");
}

export async function listAllShipments(knex: Knex = db): Promise<Shipment[]> {
  return knex<Shipment>(TABLE).orderBy("created_at", "desc").limit(500);
}

export async function updateShipment(
  id: number,
  patch: Partial<ShipmentInsert>,
  knex: Knex = db,
): Promise<Shipment | null> {
  const existing = await getShipmentById(id, knex);
  if (!existing) return null;

  await knex<Shipment>(TABLE)
    .where({ id })
    .update({
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.selected_rate !== undefined && {
        selected_rate: patch.selected_rate,
      }),
      ...(patch.carrier !== undefined && { carrier: patch.carrier }),
      ...(patch.service_type !== undefined && {
        service_type: patch.service_type,
      }),
      ...(patch.tracking_number !== undefined && {
        tracking_number: patch.tracking_number,
      }),
      ...(patch.customs !== undefined && { customs: patch.customs }),
      ...(patch.pickup !== undefined && { pickup: patch.pickup }),
      updated_at: knex.fn.now(),
    });
  return getShipmentById(id, knex);
}

export async function markShipmentVoided(
  id: number,
  knex: Knex = db,
): Promise<boolean> {
  const existing = await getShipmentById(id, knex);
  if (!existing) return false;

  const count = await knex<Shipment>(TABLE)
    .where({ id })
    .update({ status: "voided" as ShipmentStatus, updated_at: knex.fn.now() });
  return count > 0;
}
