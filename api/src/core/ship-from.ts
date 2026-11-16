import type { ShipFromAddress } from "../types";

export function loadAllowedShipFroms(): ShipFromAddress[] | null {
  const raw = process.env.SLG_ALLOWED_SHIP_FROMS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isShipFromAddress);
  } catch {
    return null;
  }
}

export function isShipFromAddress(value: unknown): value is ShipFromAddress {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  if (!record) return false;
  return (
    typeof record.name === "string" &&
    typeof record.street === "string" &&
    typeof record.city === "string" &&
    typeof record.state === "string" &&
    typeof record.zip === "string" &&
    (record.country === undefined || typeof record.country === "string")
  );
}

export function validateShipFrom(
  input: ShipFromAddress,
): { ok: true } | { ok: false; error: string } {
  const allowed = loadAllowedShipFroms();
  if (allowed === null) return { ok: true };

  const matches = allowed.some(
    (entry) =>
      entry.name === input.name &&
      entry.street === input.street &&
      entry.city === input.city &&
      entry.state === input.state &&
      entry.zip === input.zip &&
      (entry.country ?? "US").toUpperCase() ===
        (input.country ?? "US").toUpperCase(),
  );

  if (!matches) {
    return { ok: false, error: "ship_from is not in the allowed list" };
  }
  return { ok: true };
}
