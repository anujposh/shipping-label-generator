import type { Row } from "@tanstack/react-table";

/**
 * Pure, framework-free table logic. Kept free of React so it is directly
 * unit-testable; the DataTable registers `caseInsensitiveSortFn` as a
 * `sortingFns` entry and `includesGlobalFilterFn` as its `globalFilterFn`.
 */

/** Locale-aware, numeric-aware, null-safe comparison for a single value. */
export function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Case-insensitive column sort (TanStack `sortingFns` signature). */
export function caseInsensitiveSortFn<TData>(
  rowA: Row<TData>,
  rowB: Row<TData>,
  columnId: string,
): number {
  return compareValues(rowA.getValue(columnId), rowB.getValue(columnId));
}

/** Global filter that matches a query against any cell's rendered value. */
export function includesGlobalFilterFn<TData>(
  row: Row<TData>,
  _columnId: string,
  filterValue: string,
): boolean {
  const query = String(filterValue ?? "")
    .trim()
    .toLowerCase();
  if (!query) return true;
  return row.getAllCells().some((cell) =>
    String(cell.getValue() ?? "")
      .toLowerCase()
      .includes(query),
  );
}

/** Extracts the ids of selected rows from TanStack's row-selection state. */
export function getSelectedRowIds(
  selection: Record<string, boolean>,
): string[] {
  return Object.entries(selection)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

/**
 * One-based window of visible items for the "Showing X–Y of Z" footer.
 * Returns `{ from: 0, to: 0 }` when there are no items.
 */
export function getPaginationWindow(
  totalItems: number,
  pageIndex: number,
  pageSize: number,
): { from: number; to: number } {
  if (totalItems <= 0) return { from: 0, to: 0 };
  const from = pageIndex * pageSize + 1;
  const to = Math.min(from + pageSize - 1, totalItems);
  return { from, to };
}
