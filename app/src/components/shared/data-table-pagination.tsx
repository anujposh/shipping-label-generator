"use client";

import { type Table } from "@tanstack/react-table";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from "lucide-react";

import { Button } from "@/components/shared/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/shared/select";
import { getPaginationWindow } from "@/components/shared/data-table-utils";
import en from "@/messages/en.json";

const t = en;

export function DataTablePagination<TData>({
  table,
  pageSizeOptions = [5, 10, 25, 50],
}: {
  table: Table<TData>;
  pageSizeOptions?: number[];
}) {
  const { pageIndex, pageSize } = table.getState().pagination;
  const totalItems = table.getFilteredRowModel().rows.length;
  const { from, to } = getPaginationWindow(totalItems, pageIndex, pageSize);
  const pageCount = Math.max(table.getPageCount(), 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          {t.showing} {from}–{to} {t.of} {totalItems}
        </span>
        <Select
          value={String(pageSize)}
          onValueChange={(next) => table.setPageSize(Number(next))}
        >
          <SelectTrigger className="h-7 w-[70px]" aria-label={t.rows_per_page}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>{t.per_page}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
          aria-label={t.first_page}
        >
          <ChevronsLeftIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
          aria-label={t.previous}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="px-2 text-sm text-muted-foreground">
          {pageIndex + 1} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
          aria-label={t.next}
        >
          <ChevronRightIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => table.setPageIndex(pageCount - 1)}
          disabled={!table.getCanNextPage()}
          aria-label={t.last_page}
        >
          <ChevronsRightIcon />
        </Button>
      </div>
    </div>
  );
}
