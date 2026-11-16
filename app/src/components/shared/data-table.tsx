"use client";

import * as React from "react";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type VisibilityState,
  type OnChangeFn,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowUpDownIcon,
  CircleXIcon,
  InboxIcon,
  SearchIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { applyPinnedColumns } from "@/lib/column-config";
import { Button } from "@/components/shared/button";
import { Checkbox } from "@/components/shared/checkbox";
import { Input } from "@/components/shared/input";
import { Skeleton } from "@/components/shared/skeleton";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import en from "@/messages/en.json";
import {
  caseInsensitiveSortFn,
  getSelectedRowIds,
  includesGlobalFilterFn,
} from "@/components/shared/data-table-utils";

const t = en;

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  getRowId: (row: TData) => string;
  selectable?: boolean;
  onSelectionChange?: (selectedIds: string[]) => void;
  /**
   * Controlled row-selection state. When provided, the table defers selection
   * updates to `onRowSelectionChange` and the parent owns clearing/resetting
   * (e.g. after a toolbar action completes).
   */
  rowSelection?: Record<string, boolean>;
  onRowSelectionChange?: (selection: Record<string, boolean>) => void;
  /** Single-select semantics — selecting a row deselects the others. */
  singleSelect?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Existing page filters displayed beside the built-in search. */
  toolbarFilters?: React.ReactNode;
  initialPageSize?: number;
  pageSizeOptions?: number[];
  isLoading?: boolean;
  error?: string | null;
  /** When set, the error block renders an inline retry (refetch) button. */
  onRetry?: () => void;
  emptyMessage?: string;
  /**
   * Sticky header row. `true` keeps the header visible while the page
   * scrolls (default `false`; detail pages opt in). The sticky offset
   * clears the fixed 48px app header.
   */
  stickyHeader?: boolean;
  /**
   * Pixel offset for the page-level sticky header row — set when the page
   * keeps its own sticky header pinned at the top, so the thead sticks
   * below it instead of sliding underneath. Ignored with `innerScroll`
   * (inner-scroll tables stick inside their own container).
   */
  stickyHeaderTop?: number;
  rowActions?: (row: TData) => React.ReactNode;
  className?: string;
  /**
   * Footer rendered below the table. `undefined` (default) renders the
   * standard pagination footer; `null` renders no footer; any other node
   * (e.g. `<InfiniteTableFooter />`) replaces the pagination footer.
   */
  footer?: React.ReactNode;
  /**
   * Controlled column order (column ids, `__select` handled internally).
   * Supplied by the page's single `useColumnConfig` instance; when absent
   * the table renders columns in definition order.
   */
  columnOrderState?: ColumnOrderState;
  /** Controlled column visibility keyed by column id (`true` = visible). */
  columnVisibilityState?: VisibilityState;
  /**
   * Enable drag-to-resize column handles on header cells. The first render
   * auto-sizes columns; once widths are measured (or hydrated from storage)
   * the table switches to fixed layout so drags are authoritative in both
   * directions, and body cells truncate to honor shrunken widths.
   */
  resizable?: boolean;
  /**
   * Bounded inner scroll viewport: the table box scrolls on both axes, the
   * header row sticks to the box top (`top-0`, not the page-level `top-12`
   * offset), and the footer renders inside the scroller so its sentinel
   * keeps firing as the box scrolls. The page must constrain the box height
   * (flex `min-h-0` chain) for the scrollbar to sit at the screen bottom.
   */
  innerScroll?: boolean;
  /**
   * Column pixel widths (persisted `useColumnConfig.sizes`). Entries
   * arriving here (e.g. localStorage hydration after mount) are merged
   * into the table's sizing state, overriding measured defaults.
   */
  columnSizingState?: ColumnSizingState;
  /** Notified with the full sizing map on every resize gesture update. */
  onColumnSizingChange?: (sizes: ColumnSizingState) => void;
  /**
   * Controlled global search value. When provided, the internal search
   * input defers to this value (toolbar Search slot wiring) and the
   * DataTable-internal `searchable` input is not rendered.
   */
  searchValue?: string;
  onSearchValueChange?: (value: string) => void;
}

/**
 * Presentation-only data table. Sorting, filtering, pagination and selection
 * are managed here via TanStack Table; no business logic lives in this
 * component (thin client).
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  getRowId,
  selectable = false,
  onSelectionChange,
  rowSelection: controlledRowSelection,
  onRowSelectionChange,
  singleSelect = false,
  searchable = false,
  searchPlaceholder = "Search...",
  toolbarFilters,
  initialPageSize = 10,
  pageSizeOptions = [5, 10, 25, 50],
  isLoading = false,
  error,
  onRetry,
  emptyMessage = "No results found",
  stickyHeader = true,
  rowActions,
  className,
  footer,
  columnOrderState,
  columnVisibilityState,
  resizable = false,
  innerScroll = false,
  stickyHeaderTop,
  columnSizingState,
  onColumnSizingChange,
  searchValue,
  onSearchValueChange,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [internalGlobalFilter, setInternalGlobalFilter] = React.useState("");
  const globalFilter =
    searchValue !== undefined ? searchValue : internalGlobalFilter;
  const setGlobalFilter =
    searchValue !== undefined
      ? (value: string) => onSearchValueChange?.(value)
      : setInternalGlobalFilter;
  const [internalRowSelection, setInternalRowSelection] = React.useState<
    Record<string, boolean>
  >({});
  const [columnSizing, setColumnSizing] = React.useState<ColumnSizingState>(
    columnSizingState ?? {},
  );
  const tableRef = React.useRef<HTMLTableElement | null>(null);
  const sizesSeededRef = React.useRef(false);
  const persistedSizesRef = React.useRef<ColumnSizingState | undefined>(
    undefined,
  );

  // Seed unsized columns with their rendered auto widths so the first drag
  // deltas from the width the user actually sees (pre-paint, no flash).
  // Waits for data: seeding against the loading skeleton would capture the
  // empty table's collapsed column widths.
  React.useLayoutEffect(() => {
    if (!resizable || sizesSeededRef.current || isLoading) return;
    sizesSeededRef.current = true;
    const tableEl = tableRef.current;
    if (!tableEl) return;
    const next: ColumnSizingState = { ...columnSizing };
    tableEl
      .querySelectorAll<HTMLTableCellElement>("th[data-column-id]")
      .forEach((th) => {
        const id = th.dataset.columnId;
        if (id && next[id] === undefined) next[id] = th.offsetWidth;
      });
    setColumnSizing(next);
  }, [resizable, isLoading, columnSizing]);

  // Persisted sizes arrive asynchronously (localStorage hydration after
  // mount); they override the measured seed for columns the user resized
  // in a previous session.
  React.useEffect(() => {
    if (!resizable) return;
    if (persistedSizesRef.current === columnSizingState) return;
    persistedSizesRef.current = columnSizingState;
    if (!columnSizingState) return;
    setColumnSizing((prev) => ({ ...prev, ...columnSizingState }));
  }, [resizable, columnSizingState]);

  // Resize gestures dispatch from TanStack's document-level mousemove
  // listener, so React runs functional updaters during the render pass —
  // notifying the parent from inside one would be a cross-component
  // setState-during-render. Resolve `next` from the latest state here
  // (both deps kept fresh) and dispatch the plain value instead.
  const handleColumnSizingChange: OnChangeFn<ColumnSizingState> =
    React.useCallback(
      (updater) => {
        const next =
          typeof updater === "function"
            ? (updater as (old: ColumnSizingState) => ColumnSizingState)(
                columnSizing,
              )
            : updater;
        setColumnSizing(next);
        onColumnSizingChange?.(next);
      },
      [columnSizing, onColumnSizingChange],
    );

  const isControlled = controlledRowSelection !== undefined;
  const rowSelection = isControlled
    ? controlledRowSelection
    : internalRowSelection;

  const handleRowSelectionChange: OnChangeFn<RowSelectionState> =
    React.useCallback(
      (updater) => {
        const next =
          typeof updater === "function" ? updater(rowSelection) : updater;
        if (isControlled) {
          onRowSelectionChange?.(next);
        } else {
          setInternalRowSelection(next);
        }
      },
      [rowSelection, isControlled, onRowSelectionChange],
    );

  const selectionColumn: ColumnDef<TData, TValue> = React.useMemo(
    () => ({
      id: "__select",
      header: ({ table }) => (
        <span
          className="flex size-10 cursor-pointer items-center justify-center sm:size-8"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            table.toggleAllPageRowsSelected(!table.getIsAllPageRowsSelected());
          }}
        >
          <Checkbox
            checked={table.getIsAllPageRowsSelected()}
            indeterminate={table.getIsSomePageRowsSelected()}
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(Boolean(value))
            }
            aria-label={t.select_all_rows}
          />
        </span>
      ),
      cell: ({ row }) => (
        <span
          className="flex size-10 cursor-pointer items-center justify-center sm:size-8"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            row.toggleSelected();
          }}
        >
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(Boolean(value))}
            aria-label={t.select_row}
          />
        </span>
      ),
      enableSorting: false,
      enableHiding: false,
      size: 40,
    }),
    [],
  );

  const tableColumns = React.useMemo(
    () => (selectable ? [selectionColumn, ...columns] : columns),
    [selectable, selectionColumn, columns],
  );

  const effectiveColumnOrder = React.useMemo(() => {
    if (columnOrderState === undefined) return undefined;
    const knownIds = tableColumns
      .map((column) => column.id)
      .filter((id): id is string => typeof id === "string");
    const missingIds = knownIds.filter((id) => !columnOrderState.includes(id));
    return applyPinnedColumns(
      [...columnOrderState, ...missingIds],
      selectable ? ["__select"] : [],
    );
  }, [columnOrderState, tableColumns, selectable]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    getRowId,
    state: {
      sorting,
      globalFilter,
      ...(selectable ? { rowSelection } : {}),
      ...(effectiveColumnOrder !== undefined
        ? { columnOrder: effectiveColumnOrder }
        : {}),
      ...(columnVisibilityState !== undefined
        ? { columnVisibility: columnVisibilityState }
        : {}),
      ...(resizable ? { columnSizing } : {}),
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: selectable ? handleRowSelectionChange : undefined,
    onColumnSizingChange: resizable ? handleColumnSizingChange : undefined,
    enableColumnResizing: resizable,
    columnResizeMode: "onChange",
    enableRowSelection: selectable,
    enableMultiRowSelection: !singleSelect,
    globalFilterFn: includesGlobalFilterFn,
    sortingFns: { caseInsensitive: caseInsensitiveSortFn },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: initialPageSize },
    },
  });

  React.useEffect(() => {
    if (selectable && onSelectionChange) {
      onSelectionChange(getSelectedRowIds(rowSelection));
    }
  }, [rowSelection, selectable, onSelectionChange]);

  const toolbar = toolbarFilters || (searchable && searchValue === undefined) ? (
    <div className="data-table-toolbar">
      {toolbarFilters}
      {searchable && searchValue === undefined ? (
        <label className="data-table-search">
          <span className="sr-only">Search</span>
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder={searchPlaceholder}
          />
        </label>
      ) : null}
    </div>
  ) : null;

  if (error) {
    return (
      <>
      {toolbar}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-none border border-destructive/40 bg-destructive/5 px-4 py-10 text-center",
          className,
        )}
      >
        <CircleXIcon className="size-8 text-destructive" />
        <p className="text-sm font-medium text-destructive">{error}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t.retry}
          </Button>
        ) : null}
      </div>
      </>
    );
  }

  const rows = table.getRowModel().rows;
  const columnCount = tableColumns.length + (rowActions ? 1 : 0);
  // `getSize()` resolves measured/persisted sizing first, then the column
  // def `size` (40 for `__select`), then TanStack's 150px default — a safe
  // fallback for columns revealed after the one-shot seeding pass.
  const minTableWidth = resizable
    ? table
        .getVisibleLeafColumns()
        .reduce((total, column) => total + column.getSize(), 0) +
      (rowActions ? 40 : 0)
    : 0;
  // Fixed layout makes those widths authoritative — auto layout lets content
  // constraints outvote the width style, so drags redistribute space instead
  // of resizing the grabbed column. It engages only once sizing state exists
  // so the very first render still auto-sizes, which is what the one-shot
  // seeding effect measures.
  const fixedLayout = resizable && Object.keys(columnSizing).length > 0;

  return (
    <div
      className={cn(
        "w-full min-w-0",
        innerScroll && "flex min-h-0 flex-1 flex-col",
        className,
      )}
    >
      {toolbar}

      <div
        data-slot="table-scroller"
        className={cn(
          "w-full min-w-0 rounded-none border border-border scrollbar-stylish",
          innerScroll ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto",
          // Always show horizontal scrollbar when content overflows
          "scrollbar-gutter-stable",
          // Ensure horizontal scrollbar is visible and functional
          "overflow-x-auto",
        )}
      >
        <table
          ref={tableRef}
          style={
            resizable && minTableWidth ? { minWidth: minTableWidth } : undefined
          }
          className={cn(
            "w-full caption-bottom text-sm",
            fixedLayout && "table-fixed",
          )}
        >
          <thead
            className={cn(
              stickyHeader &&
                "sticky top-0 z-20 bg-background shadow-[0_1px_0_0_hsl(var(--border))]",
            )}
            style={
              stickyHeader && !innerScroll && stickyHeaderTop
                ? { top: `${stickyHeaderTop}px` }
                : undefined
            }
          >
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-border">
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const showResizeHandle =
                    resizable &&
                    header.column.getCanResize() &&
                    header.id !== "__select";
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      data-column-id={header.column.id}
                      style={
                        resizable
                          ? { width: header.column.getSize() }
                          : undefined
                      }
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                      className={cn(
                        "h-10 whitespace-normal break-words px-3 py-2 text-left align-middle font-medium leading-snug text-muted-foreground",
                        // For inner scroll tables, individual th cells need sticky positioning
                        innerScroll &&
                          "sticky top-0 z-20 bg-background shadow-[0_1px_0_0_hsl(var(--border))]",
                        resizable && "relative",
                      )}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() &&
                        !header.id.includes("__select") ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-start gap-1 text-left hover:text-foreground"
                        >
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                          {sorted === "asc" ? (
                            <ArrowUpIcon className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDownIcon className="size-3.5" />
                          ) : (
                            <ArrowUpDownIcon className="size-3.5 opacity-50" />
                          )}
                        </button>
                      ) : (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      )}
                      {showResizeHandle ? (
                        <div
                          data-slot="column-resize-handle"
                          aria-hidden="true"
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onClick={(event) => event.stopPropagation()}
                          className={cn(
                            "absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none select-none",
                            header.column.getIsResizing()
                              ? "bg-teal-600 dark:bg-teal-400"
                              : "bg-transparent hover:bg-border",
                          )}
                        />
                      ) : null}
                    </th>
                  );
                })}
                {rowActions ? <th scope="col" className="w-10" /> : null}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading ? (
              <LoadingRows
                rowCount={initialPageSize}
                columnCount={columnCount}
              />
            ) : rows.length === 0 ? (
              <EmptyRow
                columnCount={columnCount}
                message={emptyMessage}
                showClearFilters={globalFilter.length > 0}
                onClearFilters={() => setGlobalFilter("")}
              />
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-0 data-state-selected:bg-accent/50"
                  data-state={row.getIsSelected() ? "selected" : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn(
                        "h-8 px-3 py-0 align-middle",
                        // Fixed widths clip instead of re-wrapping so a
                        // shrunken column keeps the width the user set.
                        fixedLayout && "truncate",
                      )}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="h-8 w-10 px-2 py-0 align-middle">
                      {rowActions(row.original)}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {innerScroll ? (
          footer === undefined ? (
            <DataTablePagination
              table={table}
              pageSizeOptions={pageSizeOptions}
            />
          ) : (
            footer
          )
        ) : null}
      </div>

      {innerScroll ? null : footer === undefined ? (
        <DataTablePagination table={table} pageSizeOptions={pageSizeOptions} />
      ) : (
        footer
      )}
    </div>
  );
}

function LoadingRows({
  rowCount,
  columnCount,
}: {
  rowCount: number;
  columnCount: number;
}) {
  return Array.from({ length: Math.min(rowCount, 8) }).map((_, rowIndex) => (
    <tr key={rowIndex} className="border-b border-border last:border-0">
      {Array.from({ length: columnCount }).map((__, colIndex) => (
        <td key={colIndex} className="h-8 px-3 py-0">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  ));
}

function EmptyRow({
  columnCount,
  message,
  showClearFilters = false,
  onClearFilters,
}: {
  columnCount: number;
  message: string;
  showClearFilters?: boolean;
  onClearFilters?: () => void;
}) {
  return (
    <tr>
      <td colSpan={columnCount} className="px-4 py-12">
        <div className="flex flex-col items-center justify-center gap-2 text-center">
          <InboxIcon className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{message}</p>
          {showClearFilters && onClearFilters ? (
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              {t.clear_filters}
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
