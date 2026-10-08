/**
 * A DynamoDB DocumentClient look-alike over Postgres, so the hosted tickets handlers
 * (packages/infra/lambda/task-routes.ts) run unchanged on the home network.
 *
 * It understands exactly what those handlers send: Get/Put/Delete by key, Scan of a whole
 * table, and Query on a child's partition (optionally `begins_with` on the sort key), newest
 * first, with a limit. Anything else throws, so a hosted change that needs more fails loudly in
 * the tests instead of quietly doing the wrong thing.
 *
 * Items map to the relational tables in the tickets schema (and core.term_dates); attributes we
 * do not model are kept in each row's `extra` jsonb so a Put → Get round trip loses nothing.
 * Sort keys compare as bytes (COLLATE "C"), the way DynamoDB orders string keys.
 */

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
}

type Item = Record<string, unknown>;
type ColumnType = "text" | "int" | "bool" | "ts" | "textarr";

interface Column {
  attr: string;
  column: string;
  type: ColumnType;
  /** Leave the attribute out of the item when the column is null (hosted items omit it). */
  omitNull?: boolean;
}

interface TableSpec {
  table: string;
  /** Item attributes that form the key, in order (partition, sort). */
  key: string[];
  columns: Column[];
  /** Rows written through the adapter get this source (awards, redemptions). */
  source?: string;
}

const col = (attr: string, type: ColumnType, extra: Partial<Column> = {}): Column => ({ attr, column: attr, type, ...extra });
const child = (): Column => ({ attr: "child_subdomain", column: "child_id", type: "text" });

export const LOGICAL_TABLES = {
  tasks: "tasks",
  completions: "task-completions",
  board: "job-board",
  rewards: "rewards",
  redemptions: "reward-redemptions",
  termDates: "term-dates",
} as const;

const SPECS: Record<string, TableSpec> = {
  [LOGICAL_TABLES.tasks]: {
    table: "tickets.tasks",
    key: ["task_id"],
    columns: [
      col("task_id", "text"),
      col("title", "text"),
      col("description", "text"),
      col("ticket_reward", "int"),
      col("assigned_to", "textarr"),
      col("icon", "text"),
      col("emoji", "text"),
      col("enabled", "bool"),
      col("created_at", "ts"),
      col("updated_at", "ts"),
    ],
  },
  [LOGICAL_TABLES.board]: {
    table: "tickets.board",
    key: ["board_id"],
    columns: [
      col("board_id", "text"),
      col("task_id", "text"),
      col("repeat", "text"),
      col("ticket_reward", "int"),
      col("assigned_to", "textarr"),
      col("posted", "bool"),
      col("posted_at", "ts"),
      col("completion_mode", "text"),
      col("created_at", "ts"),
      col("updated_at", "ts"),
    ],
  },
  [LOGICAL_TABLES.completions]: {
    table: "tickets.awards",
    key: ["child_subdomain", "task_completion"],
    source: "tickets",
    columns: [
      child(),
      col("task_completion", "text"),
      col("task_id", "text"),
      col("completed_at", "ts"),
      col("completed_by", "text"),
      col("tickets", "int"),
      col("label", "text", { omitNull: true }),
    ],
  },
  [LOGICAL_TABLES.rewards]: {
    table: "tickets.rewards",
    key: ["reward_id"],
    columns: [
      col("reward_id", "text"),
      col("title", "text"),
      col("description", "text"),
      col("ticket_cost", "int"),
      col("cost_pence", "int"),
      col("icon", "text"),
      col("emoji", "text"),
      col("limit_type", "text", { omitNull: true }),
      col("stock_remaining", "int"),
      col("period", "text"),
      col("snack_product_slug", "text"),
      col("enabled", "bool"),
      col("created_at", "ts"),
      col("updated_at", "ts"),
    ],
  },
  [LOGICAL_TABLES.redemptions]: {
    table: "tickets.redemptions",
    key: ["child_subdomain", "redemption_id"],
    source: "tickets",
    columns: [
      child(),
      col("redemption_id", "text"),
      col("reward_id", "text"),
      col("redeemed_at", "ts"),
      col("redeemed_by", "text"),
      col("tickets", "int"),
      col("status", "text"),
      col("claimed_at", "ts", { omitNull: true }),
    ],
  },
};

/** Thrown for a write the home network refuses (e.g. undoing a household chore's award here). */
export class RefusedWrite extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export class UnsupportedCommand extends Error {}

function toColumn(value: unknown, type: ColumnType): unknown {
  if (value === undefined || value === null) return null;
  switch (type) {
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new UnsupportedCommand(`not an integer: ${String(value)}`);
      return n;
    }
    case "bool":
      return Boolean(value);
    case "textarr":
      if (!Array.isArray(value)) throw new UnsupportedCommand("expected a list");
      return value.map(String);
    case "ts":
    case "text":
      return String(value);
  }
}

function fromColumn(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (type === "ts") return (value instanceof Date ? value : new Date(String(value))).toISOString();
  if (type === "int") return Number(value);
  return value;
}

function rowToItem(spec: TableSpec, row: Record<string, any>): Item {
  const item: Item = { ...(row.extra ?? {}) };
  for (const column of spec.columns) {
    const value = fromColumn(row[column.column], column.type);
    if (value === null && column.omitNull) continue;
    item[column.attr] = value;
  }
  return item;
}

function selectList(spec: TableSpec): string {
  return [...spec.columns.map((c) => c.column), "extra"].join(", ");
}

function keyWhere(spec: TableSpec, key: Item, offset = 0): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const attr of spec.key) {
    if (key[attr] === undefined) throw new UnsupportedCommand(`missing key attribute ${attr}`);
    const column = spec.columns.find((c) => c.attr === attr)!;
    params.push(String(key[attr]));
    parts.push(`${column.column} = $${offset + params.length}`);
  }
  return { sql: parts.join(" AND "), params };
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, any>;
}

export interface PgDocumentClientOptions {
  /** Tables the adapter does not map, served from memory (tests only: devices, pairing). */
  memory?: Record<string, Map<string, Item>>;
}

export class PgDocumentClient {
  constructor(
    private readonly db: Queryable,
    private readonly options: PgDocumentClientOptions = {},
  ) {}

  async send(command: CommandLike): Promise<any> {
    // Bundlers may suffix class names (ScanCommand2); the build keeps names, this is a backstop.
    const name = command.constructor.name.replace(/\d+$/, "");
    const input = command.input;
    const tableName = String(input.TableName ?? "");
    if (tableName === LOGICAL_TABLES.termDates) return this.termDates(name, input);
    const spec = SPECS[tableName];
    if (!spec) {
      const memory = this.options.memory?.[tableName];
      if (memory) return memorySend(memory, name, input);
      throw new UnsupportedCommand(`table ${tableName} is not available on the home network`);
    }
    switch (name) {
      case "GetCommand":
        return this.get(spec, input.Key);
      case "PutCommand":
        return this.put(spec, input);
      case "DeleteCommand":
        return this.delete(spec, input);
      case "ScanCommand":
        return this.scan(spec, input);
      case "QueryCommand":
        return this.queryCommand(spec, input);
      default:
        throw new UnsupportedCommand(`${name} is not supported`);
    }
  }

  private async get(spec: TableSpec, key: Item) {
    const where = keyWhere(spec, key);
    const { rows } = await this.db.query(`SELECT ${selectList(spec)} FROM ${spec.table} WHERE ${where.sql}`, where.params);
    return { Item: rows[0] ? rowToItem(spec, rows[0]) : undefined };
  }

  private async put(spec: TableSpec, input: Record<string, any>) {
    if (input.ConditionExpression) throw new UnsupportedCommand("conditional puts are not supported");
    const item = (input.Item ?? {}) as Item;
    const known = new Set(spec.columns.map((c) => c.attr));
    const extra: Item = {};
    for (const [attr, value] of Object.entries(item)) if (!known.has(attr)) extra[attr] = value;
    const columns = spec.columns.map((c) => c.column);
    const params = spec.columns.map((c) => toColumn(item[c.attr], c.type));
    columns.push("extra");
    params.push(JSON.stringify(extra));
    if (spec.source) {
      columns.push("source");
      params.push(spec.source);
    }
    const keyColumns = spec.key.map((attr) => spec.columns.find((c) => c.attr === attr)!.column);
    // Replace the whole item (DynamoDB Put semantics), but never relabel where a row came from.
    const updates = columns.filter((c) => !keyColumns.includes(c) && c !== "source").map((c) => `${c} = EXCLUDED.${c}`);
    if (spec.source) await this.refuseHousehold(spec, item);
    await this.db.query(
      `INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT (${keyColumns.join(", ")}) DO UPDATE SET ${updates.join(", ")}`,
      params,
    );
    return {};
  }

  private async delete(spec: TableSpec, input: Record<string, any>) {
    if (input.ConditionExpression) throw new UnsupportedCommand("conditional deletes are not supported");
    if (spec.source) await this.refuseHousehold(spec, input.Key);
    const where = keyWhere(spec, input.Key);
    await this.db.query(`DELETE FROM ${spec.table} WHERE ${where.sql}`, where.params);
    return {};
  }

  /** Household chore awards belong to household: completing or undoing the chore there changes them. */
  private async refuseHousehold(spec: TableSpec, key: Item) {
    if (spec.table !== "tickets.awards") return;
    const where = keyWhere(spec, key);
    const { rows } = await this.db.query(`SELECT source FROM tickets.awards WHERE ${where.sql}`, where.params);
    if (rows[0]?.source === "household") {
      throw new RefusedWrite("Those tickets came from a household chore: undo the chore in Household instead");
    }
  }

  private async scan(spec: TableSpec, input: Record<string, any>) {
    if (input.FilterExpression || input.ExclusiveStartKey) throw new UnsupportedCommand("filtered or paged scans are not supported");
    const { rows } = await this.db.query(`SELECT ${selectList(spec)} FROM ${spec.table}`);
    return { Items: rows.map((row) => rowToItem(spec, row)), Count: rows.length };
  }

  private async queryCommand(spec: TableSpec, input: Record<string, any>) {
    if (input.IndexName || input.FilterExpression) throw new UnsupportedCommand("index or filtered queries are not supported");
    const expression = String(input.KeyConditionExpression ?? "").replace(/\s+/g, " ").trim();
    const values = (input.ExpressionAttributeValues ?? {}) as Item;
    const [partitionAttr, sortAttr] = spec.key;
    if (!sortAttr || partitionAttr !== "child_subdomain") throw new UnsupportedCommand(`queries on ${spec.table} are not supported`);
    const sortColumn = spec.columns.find((c) => c.attr === sortAttr)!.column;
    const params: unknown[] = [];
    let where: string;
    const simple = expression.match(/^(\w+) = (:\w+)$/);
    const prefix = expression.match(/^(\w+) = (:\w+) AND begins_with\((\w+), (:\w+)\)$/);
    if (simple && simple[1] === partitionAttr) {
      params.push(String(values[simple[2]]));
      where = "child_id = $1";
    } else if (prefix && prefix[1] === partitionAttr && prefix[3] === sortAttr) {
      params.push(String(values[prefix[2]]), String(values[prefix[4]]));
      // starts_with, not LIKE: task ids may contain % or _.
      where = `child_id = $1 AND starts_with(${sortColumn}, $2)`;
    } else {
      throw new UnsupportedCommand(`key condition not supported: ${expression}`);
    }
    const direction = input.ScanIndexForward === false ? "DESC" : "ASC";
    const limit = Number.isInteger(input.Limit) && input.Limit > 0 ? ` LIMIT ${Number(input.Limit)}` : "";
    const { rows } = await this.db.query(
      `SELECT ${selectList(spec)} FROM ${spec.table} WHERE ${where} ORDER BY ${sortColumn} COLLATE "C" ${direction}${limit}`,
      params,
    );
    return { Items: rows.map((row) => rowToItem(spec, row)), Count: rows.length };
  }

  /** Term dates come from the shared core.term_dates, one item per academic year. Snacks edits them. */
  private async termDates(name: string, input: Record<string, any>) {
    const load = async (year?: string) => {
      const { rows } = await this.db.query(
        `SELECT academic_year, name, to_char(opens, 'YYYY-MM-DD') AS opens, to_char(closes, 'YYYY-MM-DD') AS closes,
                to_char(half_term_start, 'YYYY-MM-DD') AS half_term_start, to_char(half_term_end, 'YYYY-MM-DD') AS half_term_end
         FROM core.term_dates ${year ? "WHERE academic_year = $1" : ""} ORDER BY academic_year, position`,
        year ? [year] : [],
      );
      const years = new Map<string, Item>();
      for (const row of rows) {
        const entry = years.get(row.academic_year) ?? { academic_year: row.academic_year, terms: [] as Item[], updated_at: "" };
        (entry.terms as Item[]).push({
          name: row.name,
          opens: row.opens,
          closes: row.closes,
          half_term_start: row.half_term_start,
          half_term_end: row.half_term_end,
        });
        years.set(row.academic_year, entry);
      }
      return [...years.values()];
    };
    if (name === "GetCommand") return { Item: (await load(String(input.Key?.academic_year ?? "")))[0] };
    if (name === "ScanCommand") {
      const items = await load();
      return { Items: items, Count: items.length };
    }
    throw new RefusedWrite("Term dates are edited in Snacks on the home network", 405);
  }
}

/** The in-memory tables used by tests for devices and pairing (never in production). */
function memorySend(table: Map<string, Item>, name: string, input: Record<string, any>) {
  if (name === "GetCommand") return { Item: table.get(JSON.stringify(input.Key)) };
  if (name === "ScanCommand") return { Items: [...table.values()] };
  throw new UnsupportedCommand(`${name} on an in-memory table`);
}
