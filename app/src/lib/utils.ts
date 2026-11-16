import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dates render as MM/DD/YYYY everywhere. Date-only strings (BC date fields,
 * `YYYY-MM-DD`) are formatted from their string parts directly — parsing
 * them with `new Date()` treats them as UTC midnight and localizing shifts
 * the displayed day in non-UTC timezones. The explicit "en-US" locale keeps
 * server and browser output identical (default-locale rendering differs
 * between the two and would cause hydration mismatches).
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (DATE_ONLY.test(iso)) {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (DATE_ONLY.test(iso)) return formatDate(iso);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} ${time}`;
}
