/**
 * Column customization state — pure, no React for the ops; one thin hook.
 *
 * Persistence model (bc_logsitic `datatable_${tableId}_*` localStorage
 * precedent, bc_logsitic data-table.tsx:174-200): per-table key
 * `datatable_${tableId}_columnConfig` holding `{v:1, order, hidden}` where
 * `order` lists ALL known column ids in display order (hidden ones included —
 * the popover reorders the full list) and `hidden` lists ids whose columns
 * are currently not rendered.
 *
 * Merge semantics (Flutter column_config_controller.dart:135-207): stored
 * ids unknown to the current defaults are dropped; default ids missing from
 * storage are inserted at their default position; a merged-empty result
 * falls back to all defaults.
 *
 * Reorder uses Flutter insert-slot semantics (column_config_controller.dart
 * :213-223): `to` is the position in the pre-removal coordinate space, a
 * same-position move is a no-op.
 *
 * `matchesColumnFilters` mirrors lib/odata-filter.ts semantics client-side:
 * `|` OR-combines alternatives within one column, `*` wildcards translate to
 * contains/startswith/endswith (internal segments compose), plain values
 * compare for equality, and different columns AND-combine. Like the OData
 * engine, comparisons are case-sensitive.
 */
import * as React from "react";

export interface StoredColumnConfig {
  v: 1;
  order: string[];
  hidden: string[];
  /** Column pixel widths; absent in payloads written before resizing. */
  sizes?: Record<string, number>;
}

export interface ColumnConfig {
  order: string[];
  hidden: string[];
  sizes: Record<string, number>;
}

export const COLUMN_CONFIG_PERSIST_DEBOUNCE_MS = 150;

/** localStorage key for a table's persisted column configuration. */
export function columnConfigKey(tableId: string): string {
  return `datatable_${tableId}_columnConfig`;
}

function defaultConfig(
  defaultIds: readonly string[],
  defaultHiddenIds: readonly string[] = [],
): ColumnConfig {
  return { order: [...defaultIds], hidden: [...defaultHiddenIds], sizes: {} };
}

function isStoredShape(value: unknown): value is StoredColumnConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { v?: unknown }).v === 1 &&
    Array.isArray((value as { order?: unknown }).order) &&
    (value as { order: unknown[] }).order.every(
      (id) => typeof id === "string",
    ) &&
    Array.isArray((value as { hidden?: unknown }).hidden) &&
    (value as { hidden: unknown[] }).hidden.every(
      (id) => typeof id === "string",
    )
  );
}
/**
 * Merge a stored payload over the current defaults. Unknown ids are dropped,
 * missing defaults are inserted at their default position (before the first
 * stored column whose default index is greater), and a version mismatch or
 * malformed payload yields the defaults untouched.
 */
export function mergeColumnConfig(
  defaultIds: readonly string[],
  stored: unknown,
  defaultHiddenIds: readonly string[] = [],
): ColumnConfig {
  const fallback = defaultConfig(defaultIds, defaultHiddenIds);
  if (stored == null || !isStoredShape(stored)) return fallback;

  const defaultIndex = new Map(defaultIds.map((id, index) => [id, index]));
  const order = stored.order.filter((id) => defaultIndex.has(id));
  const hidden = stored.hidden.filter((id) => defaultIndex.has(id));
  const present = new Set(order);
  const inserted: string[] = [];

  for (const id of defaultIds) {
    if (present.has(id)) continue;
    const missingIndex = defaultIndex.get(id) ?? 0;
    let insertAt = order.length;
    for (let i = 0; i < order.length; i += 1) {
      const existingIndex = defaultIndex.get(order[i]);
      if (existingIndex !== undefined && existingIndex > missingIndex) {
        insertAt = i;
        break;
      }
    }
    order.splice(insertAt, 0, id);
    inserted.push(id);
  }

  if (order.length === 0) return fallback;
  // Columns introduced after the stored config was written adopt their
  // default visibility; ids the user has already ordered keep that state.
  const insertedHidden = defaultHiddenIds.filter((id) => inserted.includes(id));
  const sizes = Object.fromEntries(
    Object.entries(stored.sizes ?? {}).filter(
      ([id, width]) =>
        defaultIndex.has(id) && typeof width === "number" && width > 0,
    ),
  );
  return { order, hidden: [...hidden, ...insertedHidden], sizes };
}

/** Column ids in display order with hidden ids removed. */
export function orderedVisibleIds(config: ColumnConfig): string[] {
  const hidden = new Set(config.hidden);
  return config.order.filter((id) => !hidden.has(id));
}

/**
 * TanStack `VisibilityState` for a config: every ordered column maps to
 * `true` unless hidden. Absent ids default to visible in TanStack, so only
 * the ordered set needs entries.
 */
export function columnVisibilityFromConfig(
  config: ColumnConfig,
): Record<string, boolean> {
  const hidden = new Set(config.hidden);
  return Object.fromEntries(config.order.map((id) => [id, !hidden.has(id)]));
}

/**
 * Keep pinned ids at the edges of an id list: `pinnedFirst` ids move to the
 * front (in their pinned order), `pinnedLast` ids to the end. Ids absent
 * from the list are ignored. Default pins the row-selection `__select`
 * column first.
 */
export function applyPinnedColumns(
  ids: readonly string[],
  pinnedFirst: readonly string[] = ["__select"],
  pinnedLast: readonly string[] = [],
): string[] {
  const middle = ids.filter(
    (id) => !pinnedFirst.includes(id) && !pinnedLast.includes(id),
  );
  return [
    ...pinnedFirst.filter((id) => ids.includes(id)),
    ...middle,
    ...pinnedLast.filter((id) => ids.includes(id)),
  ];
}

/** Pure visibility toggle for one column id. */
export function toggleColumnConfig(
  config: ColumnConfig,
  id: string,
): ColumnConfig {
  const isHidden = config.hidden.includes(id);
  return {
    order: [...config.order],
    hidden: isHidden
      ? config.hidden.filter((hiddenId) => hiddenId !== id)
      : [...config.hidden, id],
    sizes: { ...config.sizes },
  };
}

/**
 * Pure reorder with Flutter insert-slot semantics: `to` is expressed in the
 * pre-removal coordinate space (ReorderableListView convention), a
 * same-position move is a no-op returning the same config object.
 */
export function reorderColumnConfig(
  config: ColumnConfig,
  from: number,
  to: number,
): ColumnConfig {
  const { order } = config;
  if (from < 0 || from >= order.length) return config;
  let insertAt = to > from ? to - 1 : to;
  insertAt = Math.min(Math.max(insertAt, 0), order.length - 1);
  if (insertAt === from) return config;
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(insertAt, 0, moved);
  return {
    order: next,
    hidden: [...config.hidden],
    sizes: { ...config.sizes },
  };
}

function wildcardMatcher(pattern: string): (value: string) => boolean {
  const parts = pattern.split("*");
  const source =
    "^" +
    parts
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*") +
    "$";
  const regex = new RegExp(source);
  return (value: string) => regex.test(value);
}

function alternativeMatcher(alternative: string): (value: string) => boolean {
  if (alternative.includes("*")) return wildcardMatcher(alternative);
  return (value: string) => value === alternative;
}

function filterPredicate(value: string): (cell: string) => boolean {
  const alternatives = value
    .split("|")
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative !== "");
  if (alternatives.length === 0) return () => true;
  const matchers = alternatives.map(alternativeMatcher);
  return (cell: string) => matchers.some((matcher) => matcher(cell));
}

export interface ColumnFilterClause {
  column: string;
  value: string;
}

/**
 * Client-side mirror of the OData filter engine (`buildODataFilter`): rows
 * match when EVERY filter's column value satisfies at least one of its `|`
 * alternatives. Cell values are stringified; comparisons are case-sensitive,
 * matching server-side `eq`/`contains`/`startswith`/`endswith`.
 */
export function matchesColumnFilters<Row>(
  rows: readonly Row[],
  filters: readonly ColumnFilterClause[],
): Row[] {
  const predicates = filters
    .map(({ column, value }) => ({ column, predicate: filterPredicate(value) }))
    .filter(({ predicate }) => {
      // keep only clauses that constrain (filterPredicate returns a
      // match-all function for empty/wildcard-only values)
      let matchesAll = true;
      const probe = (cell: string) => {
        if (!predicate(cell)) matchesAll = false;
        return true;
      };
      probe("");
      probe("x");
      return !matchesAll;
    });
  if (predicates.length === 0) return [...rows];
  return rows.filter((row) =>
    predicates.every(({ column, predicate }) =>
      predicate(String((row as Record<string, unknown>)[column] ?? "")),
    ),
  );
}

/**
 * Client-side mirror of DataTable's global search (`includesGlobalFilterFn`):
 * a row matches when ANY of the given column keys contains the query,
 * case-insensitively. Keeps toolbar-search filtering and export scoping on
 * the same visible-row set.
 */
export function matchesGlobalSearch<Row>(
  rows: readonly Row[],
  keys: readonly string[],
  query: string,
): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    return keys.some((key) =>
      String(record[key] ?? "")
        .toLowerCase()
        .includes(needle),
    );
  });
}

export interface ColumnConfigStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Storage binding for one table's persisted config. All localStorage access
 * is guarded — a disabled or corrupted storage surface reads as "no stored
 * config" and never throws into the render path.
 */
export function createColumnConfigStore(
  tableId: string,
  storage: ColumnConfigStorage | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
) {
  const key = columnConfigKey(tableId);
  return {
    read(): unknown {
      if (!storage) return null;
      try {
        const raw = storage.getItem(key);
        return raw == null ? null : (JSON.parse(raw) as unknown);
      } catch (error) {
        console.error(
          `column-config: unreadable stored config for ${tableId}`,
          error,
        );
        return null;
      }
    },
    write(config: ColumnConfig): void {
      if (!storage) return;
      try {
        const payload: StoredColumnConfig = {
          v: 1,
          order: config.order,
          hidden: config.hidden,
          sizes: config.sizes,
        };
        storage.setItem(key, JSON.stringify(payload));
      } catch (error) {
        console.error(
          `column-config: failed to persist config for ${tableId}`,
          error,
        );
      }
    },
    remove(): void {
      if (!storage) return;
      try {
        storage.removeItem(key);
      } catch (error) {
        console.error(
          `column-config: failed to clear config for ${tableId}`,
          error,
        );
      }
    },
  };
}

export type PersistScheduler = ReturnType<typeof createPersistScheduler>;

/**
 * Debounced persist driver: repeated `schedule(value)` calls coalesce into
 * one write of the LATEST value after the debounce window; `cancel()` drops
 * the pending write (unmount / reset). Injectable clock for tests.
 */
export function createPersistScheduler(
  write: (value: ColumnConfig) => void,
  delayMs: number = COLUMN_CONFIG_PERSIST_DEBOUNCE_MS,
  schedule: (cb: () => void, ms: number) => unknown = (cb, ms) =>
    setTimeout(cb, ms),
  cancel: (timer: unknown) => void = (timer) =>
    clearTimeout(timer as ReturnType<typeof setTimeout>),
) {
  let timer: unknown;
  let pending: ColumnConfig | undefined;
  return {
    schedule(value: ColumnConfig) {
      pending = value;
      if (timer !== undefined) cancel(timer);
      timer = schedule(() => {
        timer = undefined;
        if (pending !== undefined) write(pending);
        pending = undefined;
      }, delayMs);
    },
    cancel() {
      if (timer === undefined) return;
      cancel(timer);
      timer = undefined;
    },
  };
}

export type ColumnConfigAction =
  | { type: "hydrate"; stored: unknown }
  | { type: "toggle"; id: string }
  | { type: "reorder"; from: number; to: number }
  | { type: "resize"; sizes: Record<string, number> }
  | { type: "reset" };

export interface ColumnConfigReducerState extends ColumnConfig {
  hydrated: boolean;
  /** Whether this transition should schedule a persisted write. */
  persist: boolean;
}

export function columnConfigReducer(
  state: ColumnConfigReducerState,
  action: ColumnConfigAction,
  defaultIds: readonly string[],
  defaultHiddenIds: readonly string[] = [],
): ColumnConfigReducerState {
  switch (action.type) {
    case "hydrate":
      return {
        ...mergeColumnConfig(defaultIds, action.stored, defaultHiddenIds),
        hydrated: true,
        persist: false,
      };
    case "toggle":
      if (!state.hydrated) return state;
      return {
        ...toggleColumnConfig(state, action.id),
        hydrated: true,
        persist: true,
      };
    case "reorder":
      if (!state.hydrated) return state;
      return {
        ...reorderColumnConfig(state, action.from, action.to),
        hydrated: true,
        persist: true,
      };
    case "resize":
      if (!state.hydrated) return state;
      return {
        ...state,
        sizes: { ...action.sizes },
        hydrated: true,
        persist: true,
      };
    case "reset":
      return {
        ...defaultConfig(defaultIds, defaultHiddenIds),
        hydrated: true,
        persist: false,
      };
  }
}

export interface UseColumnConfigResult {
  order: string[];
  hidden: string[];
  sizes: Record<string, number>;
  hydrated: boolean;
  toggle: (id: string) => void;
  reorder: (from: number, to: number) => void;
  resize: (sizes: Record<string, number>) => void;
  reset: () => void;
}

/**
 * Single-owner column configuration for one table. The page calls this ONCE
 * and passes the result to both the toolbar Columns popover and DataTable's
 * controlled `columnOrderState`/`columnVisibilityState` props — no second
 * instance anywhere (review decision rr-ttp-1).
 *
 * SSR-safe: state starts at defaults; storage is merged post-mount. Mutations
 * before hydration are no-ops; afterwards they persist through a 150ms
 * debounce. `reset()` cancels the pending write, removes the key, and does
 * NOT re-persist the restored defaults (the key stays absent).
 */
export function useColumnConfig(
  tableId: string,
  defaultIds: readonly string[],
  defaultHiddenIds: readonly string[] = [],
): UseColumnConfigResult {
  const [store] = React.useState(() => createColumnConfigStore(tableId));
  const [state, dispatch] = React.useReducer(
    (state: ColumnConfigReducerState, action: ColumnConfigAction) =>
      columnConfigReducer(state, action, defaultIds, defaultHiddenIds),
    undefined,
    () => ({
      ...defaultConfig(defaultIds, defaultHiddenIds),
      hydrated: false,
      persist: false,
    }),
  );

  const [scheduler] = React.useState(() =>
    createPersistScheduler((value) => store.write(value)),
  );

  React.useEffect(() => {
    dispatch({ type: "hydrate", stored: store.read() });
  }, [store]);

  React.useEffect(() => {
    if (!state.persist) return;
    scheduler.schedule({
      order: state.order,
      hidden: state.hidden,
      sizes: state.sizes,
    });
  }, [state, scheduler]);

  React.useEffect(() => () => scheduler.cancel(), [scheduler]);

  const toggle = React.useCallback(
    (id: string) => dispatch({ type: "toggle", id }),
    [],
  );
  const reorder = React.useCallback(
    (from: number, to: number) => dispatch({ type: "reorder", from, to }),
    [],
  );
  const resize = React.useCallback(
    (sizes: Record<string, number>) => dispatch({ type: "resize", sizes }),
    [],
  );
  const reset = React.useCallback(() => {
    scheduler.cancel();
    store.remove();
    dispatch({ type: "reset" });
  }, [scheduler, store]);

  return {
    order: state.order,
    hidden: state.hidden,
    sizes: state.sizes,
    hydrated: state.hydrated,
    toggle,
    reorder,
    resize,
    reset,
  };
}
