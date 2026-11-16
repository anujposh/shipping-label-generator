import type { Knex } from "knex";

export interface FakeRow {
  [key: string]: unknown;
}

export interface FakeKnexState {
  rows: FakeRow[];
}

function whereClause(rows: FakeRow[], criteria: FakeRow): FakeRow[] {
  return rows.filter((r) =>
    Object.entries(criteria).every(([k, v]) => {
      if (k === "email") {
        return (
          String(r[k]).toLowerCase().trim() === String(v).toLowerCase().trim()
        );
      }
      return r[k] === v;
    }),
  );
}

function orderBy(
  rows: FakeRow[],
  column: string,
  direction: string,
): FakeRow[] {
  if (column !== "created_at" && column !== "occurred_at" && column !== "id") {
    throw new Error(`unexpected orderBy column ${column}`);
  }
  if (direction !== "desc" && direction !== "asc") {
    throw new Error(`unexpected orderBy direction ${direction}`);
  }
  const factor = direction === "desc" ? -1 : 1;
  return [...rows].sort(
    (a, b) => factor * (Number(a[column]) - Number(b[column])),
  );
}

class FakeQuery {
  private rows: FakeRow[];

  constructor(rows: FakeRow[]) {
    this.rows = rows;
  }

  where(criteria: FakeRow): FakeQuery {
    return new FakeQuery(whereClause(this.rows, criteria));
  }

  whereNull(column: string): FakeQuery {
    return new FakeQuery(this.rows.filter((r) => r[column] === null));
  }

  orderBy(column: string, direction: string): FakeQuery {
    return new FakeQuery(orderBy(this.rows, column, direction));
  }

  limit(n: number): FakeRow[] {
    return this.rows.slice(0, n);
  }

  offset(o: number): FakeRow[] {
    return this.rows.slice(o);
  }

  async update(values: FakeRow): Promise<number> {
    for (const row of this.rows) {
      Object.assign(row, values);
    }
    return this.rows.length;
  }

  async increment(column: string, amount: number): Promise<number> {
    for (const row of this.rows) {
      row[column] = (row[column] as number) + amount;
    }
    return this.rows.length;
  }

  /**
   * knex query builders are thenable — awaiting the builder resolves to the
   * matched rows. Implementing then() means every `await knex(...)....`
   * chain (including async-function returns) yields a real array.
   */
  then<U>(
    onFulfilled?: (rows: FakeRow[]) => U,
    onRejected?: (reason: unknown) => U,
  ): Promise<U> {
    return Promise.resolve([...this.rows]).then(onFulfilled, onRejected);
  }

  map<U>(fn: (row: FakeRow) => U): U[] {
    return this.rows.map(fn);
  }

  filter(fn: (row: FakeRow) => boolean): FakeRow[] {
    return this.rows.filter(fn);
  }

  get length(): number {
    return this.rows.length;
  }

  [Symbol.iterator](): Iterator<FakeRow> {
    return this.rows[Symbol.iterator]();
  }
}

export function fakeKnex(state: FakeKnexState): Knex {
  let insertCount = state.rows.length;

  const builder = (table: string) => {
    return {
      insert(row: FakeRow) {
        insertCount += 1;
        const inserted: FakeRow = {
          id: insertCount,
          created_at: insertCount,
          ...row,
        };
        state.rows.push(inserted);
        // Real knex: insert() returns a thenable builder; .returning("id")
        // chains on it and the await resolves to [{ id }]. Mirror both here.
        const result: Array<{ id: number }> = [{ id: insertCount }];
        const chainable: unknown = {
          returning(_columns: string | string[]) {
            return chainable;
          },
          then(
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) {
            return Promise.resolve(result).then(onFulfilled, onRejected);
          },
          catch(onRejected: (e: unknown) => unknown) {
            return Promise.resolve(result).catch(onRejected);
          },
        };
        return chainable as Promise<Array<{ id: number }>>;
      },
      where(criteria: FakeRow) {
        return new FakeQuery(whereClause(state.rows, criteria));
      },
      whereNull(column: string) {
        return new FakeQuery(state.rows.filter((r) => r[column] === null));
      },
      orderBy(column: string, direction: string) {
        return new FakeQuery(orderBy(state.rows, column, direction));
      },
    };
  };

  (builder as unknown as { rows: FakeRow[] }).rows = state.rows;
  (builder as unknown as { fn: unknown }).fn = { now: () => "NOW()" };
  return builder as unknown as Knex;
}
