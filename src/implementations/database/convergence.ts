import type { MigrationMode } from "../../config";
import { Bind, type Sql } from "../../statement";
import type {
  Dialect,
  ObservedColumn,
  ObservedIndex,
  ObservedTable,
} from "../../dialect";
import { IsKeyColumnSignature } from "./paths";
import type { DeclaredColumn, IndexPlan, TablePlan } from "./plan";
import { PlanTriggerSwap, type TriggerSwap } from "./change-log";

const VENDOR = "antelopejs:";
const DESTRUCTIVE: MigrationMode = "destructive";

/** The comment of a declared column whose field may still sit in `_extra` on some rows. */
export const PENDING = `${VENDOR}1:pending`;

/** One statement, and the column or index it changes. */
interface Statement<Kind extends string> {
  readonly kind: Kind;
  readonly target: string;
  readonly sql: Sql;
}

/**
 * One step of the tables phase. Every step but `backfill` and `swapTriggers` is one statement the
 * server applies atomically. `backfill` moves the column's field out of `_extra` in chunks, each a
 * statement that can run again, then runs `settle`, which clears the pending comment; until then
 * the next convergence backfills again. `swapTriggers` replaces a watched table's triggers while it
 * holds the table, each statement atomic and the whole planned again from the catalog.
 */
export type TableStep =
  | Statement<
      | "createTable"
      | "addColumn"
      | "dropStaleKeys"
      | "retypeColumn"
      | "dropColumn"
      | "addKeyColumn"
    >
  | {
      readonly kind: "backfill";
      readonly target: string;
      readonly column: DeclaredColumn;
      readonly settle: Sql;
    }
  | {
      readonly kind: "swapTriggers";
      readonly target: string;
      readonly swap: TriggerSwap;
    };

/** One step of the background index phase: one statement each. */
export type IndexStep = Statement<
  "addIndex" | "swapIndex" | "dropIndex" | "dropKeyColumn"
>;

/** The next step of the tables phase, if any, and what the plan leaves in place and reports. */
export interface TableAdvice {
  readonly step?: TableStep;
  readonly warnings: readonly string[];
}

interface TableView {
  readonly dialect: Dialect;
  readonly mode: MigrationMode;
  readonly plan: TablePlan;
  readonly observed: ObservedTable;
}

interface IndexView {
  readonly dialect: Dialect;
  readonly plan: TablePlan;
  readonly observed: ObservedTable;
  readonly skipped: ReadonlySet<string>;
}

type Rule<View, Step> = (view: View) => Step | undefined;

/** MySQL compares column and index names without case. */
function Folded(name: string): string {
  return name.toLowerCase();
}

/** The comment that marks a table as this module's, naming the schema and table it stores. */
export function OwnershipComment(plan: TablePlan): string {
  return `${VENDOR}1:table:${JSON.stringify([plan.schemaId, plan.tableId])}`;
}

function IsAdapterSigned(comment: string): boolean {
  return comment.startsWith(VENDOR);
}

function ColumnNamed(
  observed: ObservedTable,
  name: string,
): ObservedColumn | undefined {
  return observed.columns.find(
    (column) => Folded(column.name) === Folded(name),
  );
}

function IndexNamed(
  observed: ObservedTable,
  name: string,
): ObservedIndex | undefined {
  return observed.indexes.find((index) => Folded(index.name) === Folded(name));
}

function DeclaredColumns(plan: TablePlan): DeclaredColumn[] {
  return plan.columns.filter(
    (column): column is DeclaredColumn => column.role === "declared",
  );
}

function PhysicalType(view: TableView, column: DeclaredColumn): string {
  return Bind(view.dialect.sql.physical(column.type)).sql.toLowerCase();
}

/** Declared columns the catalog holds with another type than the declaration's. */
function Retyped(view: TableView): DeclaredColumn[] {
  return DeclaredColumns(view.plan).filter((column) => {
    const found = ColumnNamed(view.observed, column.name);
    return found !== undefined && found.type !== PhysicalType(view, column);
  });
}

function IsKeyColumn(column: ObservedColumn): boolean {
  return column.generated && IsKeyColumnSignature(column.comment);
}

/** Key columns the module made that no declared index keys on any more. */
function StaleKeys(plan: TablePlan, observed: ObservedTable): ObservedColumn[] {
  const wanted = new Set(plan.keyColumns.map((key) => Folded(key.name)));
  return observed.columns.filter(
    (column) => IsKeyColumn(column) && !wanted.has(Folded(column.name)),
  );
}

/** Columns that are neither declared, reserved, nor a key column. */
function Undeclared(view: TableView): ObservedColumn[] {
  const known = new Set(
    [...view.plan.columns, ...view.plan.keyColumns].map((column) =>
      Folded(column.name),
    ),
  );
  return view.observed.columns.filter(
    (column) => !known.has(Folded(column.name)) && !IsKeyColumn(column),
  );
}

/** The indexes any of whose parts is one of `columns`. */
function IndexesOver(
  observed: ObservedTable,
  columns: readonly string[],
): string[] {
  const dropped = new Set(columns.map(Folded));
  return observed.indexes
    .filter((index) =>
      index.columns.some(
        (column) => column !== undefined && dropped.has(Folded(column)),
      ),
    )
    .map((index) => index.name);
}

function AddColumn(view: TableView): TableStep | undefined {
  const missing = DeclaredColumns(view.plan).find(
    (column) => !ColumnNamed(view.observed, column.name),
  );
  if (!missing) {
    return undefined;
  }
  const sql = view.dialect.ddl.addColumn(view.plan.table, missing, PENDING);
  return { kind: "addColumn", target: missing.name, sql };
}

/**
 * Before a retype or a column drop, drops the key columns no index needs any more and the indexes
 * over them: a key column over a dropped column blocks the drop, and one over a retyped column
 * would be read with the new type by every write until the index phase dropped it.
 */
function DropStaleKeys(view: TableView): TableStep | undefined {
  const destructiveChange =
    Retyped(view).length > 0 || Undeclared(view).length > 0;
  if (view.mode !== DESTRUCTIVE || !destructiveChange) {
    return undefined;
  }
  const stale = StaleKeys(view.plan, view.observed).map(
    (column) => column.name,
  );
  if (stale.length === 0) {
    return undefined;
  }
  const indexes = IndexesOver(view.observed, stale);
  const sql = view.dialect.ddl.dropColumns(view.plan.table, stale, indexes);
  return { kind: "dropStaleKeys", target: stale.join(", "), sql };
}

/** Retypes a column in place; a pending column stays pending, so its backfill still runs. */
function RetypeColumn(view: TableView): TableStep | undefined {
  const [column] = Retyped(view);
  const found = column && ColumnNamed(view.observed, column.name);
  if (view.mode !== DESTRUCTIVE || !found) {
    return undefined;
  }
  const { ddl } = view.dialect;
  const sql = ddl.modifyColumn(view.plan.table, column, found.comment);
  return { kind: "retypeColumn", target: column.name, sql };
}

function Backfill(view: TableView): TableStep | undefined {
  const pending = DeclaredColumns(view.plan).find(
    (column) => ColumnNamed(view.observed, column.name)?.comment === PENDING,
  );
  if (!pending) {
    return undefined;
  }
  const settle = view.dialect.ddl.modifyColumn(view.plan.table, pending, "");
  return { kind: "backfill", target: pending.name, column: pending, settle };
}

function DropUndeclared(view: TableView): TableStep | undefined {
  const [column] = Undeclared(view);
  if (view.mode !== DESTRUCTIVE || !column) {
    return undefined;
  }
  const indexes = IndexesOver(view.observed, [column.name]);
  const { table } = view.plan;
  const sql = view.dialect.ddl.dropColumns(table, [column.name], indexes);
  return { kind: "dropColumn", target: column.name, sql };
}

/**
 * Brings a watched table's triggers in line with its columns. A trigger can only be created over
 * columns that exist and must stop reading a column before it is dropped, so this runs once every
 * declared column is added and retyped, and before a backfill moves values into a new column or an
 * undeclared column is dropped.
 */
function SwapTriggers(view: TableView): TableStep | undefined {
  const { dialect, plan, observed } = view;
  const swap = PlanTriggerSwap(dialect, plan, observed.triggers, "converge");
  return swap && { kind: "swapTriggers", target: plan.table, swap };
}

function AddKeyColumn(view: TableView): TableStep | undefined {
  const missing = view.plan.keyColumns.find(
    (key) => !ColumnNamed(view.observed, key.name),
  );
  if (!missing) {
    return undefined;
  }
  const sql = view.dialect.ddl.addKeyColumn(view.plan.table, missing);
  return { kind: "addKeyColumn", target: missing.name, sql };
}

/**
 * The tables phase: one rule per kind of step, in the order steps are taken. The first rule with
 * something to do names the next step. Columns come first and key columns last, so every key
 * column reads a column of its declared type; a watched table's triggers follow its columns.
 */
const TABLE_RULES: readonly Rule<TableView, TableStep>[] = [
  AddColumn,
  DropStaleKeys,
  RetypeColumn,
  SwapTriggers,
  Backfill,
  DropUndeclared,
  AddKeyColumn,
];

function AddIndex(view: IndexView): IndexStep | undefined {
  const index = Building(view).find(
    (wanted) => !IndexNamed(view.observed, wanted.name),
  );
  if (!index) {
    return undefined;
  }
  const sql = view.dialect.ddl.addIndex(view.plan.table, index);
  return { kind: "addIndex", target: index.name, sql };
}

/** Replaces an index whose signature differs, an unsigned one at a declared name included. */
function SwapIndex(view: IndexView): IndexStep | undefined {
  const index = Building(view).find((wanted) => {
    const found = IndexNamed(view.observed, wanted.name);
    return found !== undefined && found.comment !== wanted.signature;
  });
  if (!index) {
    return undefined;
  }
  const sql = view.dialect.ddl.swapIndex(view.plan.table, index);
  return { kind: "swapIndex", target: index.name, sql };
}

/** Drops an index the module signed that nothing declares any more; an unsigned one is left alone. */
function DropIndex(view: IndexView): IndexStep | undefined {
  const wanted = new Set(view.plan.indexes.map((index) => Folded(index.name)));
  const index = view.observed.indexes.find(
    (found) =>
      IsAdapterSigned(found.comment) &&
      !wanted.has(Folded(found.name)) &&
      !view.skipped.has(Folded(found.name)),
  );
  if (!index) {
    return undefined;
  }
  const sql = view.dialect.ddl.dropIndex(view.plan.table, index.name);
  return { kind: "dropIndex", target: index.name, sql };
}

/** Drops a stale key column once no index keys on it. */
function DropKeyColumn(view: IndexView): IndexStep | undefined {
  const keyed = new Set(
    view.observed.indexes.flatMap((index) =>
      index.columns.flatMap((column) => (column ? [Folded(column)] : [])),
    ),
  );
  const column = StaleKeys(view.plan, view.observed).find(
    (stale) =>
      !keyed.has(Folded(stale.name)) && !view.skipped.has(Folded(stale.name)),
  );
  if (!column) {
    return undefined;
  }
  const sql = view.dialect.ddl.dropColumns(view.plan.table, [column.name], []);
  return { kind: "dropKeyColumn", target: column.name, sql };
}

/**
 * Pure. Whether the catalog already holds every unique index the plan declares, each as the plan
 * signs it, so no write to the table can store a duplicate whatever the index phase still has to do.
 */
export function HoldsUniqueIndexes(
  plan: TablePlan,
  observed: ObservedTable | undefined,
): boolean {
  return plan.indexes
    .filter((index) => index.unique)
    .every(
      (index) =>
        observed !== undefined &&
        IndexNamed(observed, index.name)?.comment === index.signature,
    );
}

/** The declared indexes this phase still tries to build. */
function Building(view: IndexView): IndexPlan[] {
  return view.plan.indexes.filter(
    (index) => !view.skipped.has(Folded(index.name)),
  );
}

/** The index phase: builds first, then drops, so no declared index waits on a drop. */
const INDEX_RULES: readonly Rule<IndexView, IndexStep>[] = [
  AddIndex,
  SwapIndex,
  DropIndex,
  DropKeyColumn,
];

function FirstStep<View, Step>(
  rules: readonly Rule<View, Step>[],
  view: View,
): Step | undefined {
  for (const rule of rules) {
    const step = rule(view);
    if (step) {
      return step;
    }
  }
  return undefined;
}

function AssertOwned(plan: TablePlan, observed: ObservedTable): void {
  if (
    observed.kind === "table" &&
    observed.comment === OwnershipComment(plan)
  ) {
    return;
  }
  throw new Error(
    `Table '${plan.table}' already exists and was not created by @antelopejs/mysql for '${plan.schemaId}.${plan.tableId}'; rename or drop it, or set another schemaPrefix`,
  );
}

function AssertSafe(view: TableView): void {
  const [column] = Retyped(view);
  const found = column && ColumnNamed(view.observed, column.name);
  if (view.mode === DESTRUCTIVE || !found) {
    return;
  }
  throw new Error(
    `Column '${column.name}' on '${view.plan.table}' is ${found.type} but the schema declares ${PhysicalType(view, column)}; set migrations: "destructive" to alter it`,
  );
}

function Warnings(view: TableView): string[] {
  if (view.mode === DESTRUCTIVE) {
    return [];
  }
  return Undeclared(view).map(
    (column) =>
      `Column '${column.name}' on '${view.plan.table}' is no longer declared and was left in place; set migrations: "destructive" to drop it`,
  );
}

/**
 * Pure. The next step that brings a table closer to its plan, from what the catalog holds now, or
 * none once it matches. Nothing but the catalog records progress, so a run that stopped anywhere is
 * finished by planning again. Throws, before any step, for a table the module does not own and, in
 * `safe` mode, for a column whose type changed.
 */
export function NextTableStep(
  dialect: Dialect,
  mode: MigrationMode,
  plan: TablePlan,
  observed: ObservedTable | undefined,
): TableAdvice {
  if (!observed) {
    const sql = dialect.ddl.createTable(plan, OwnershipComment(plan));
    return {
      step: { kind: "createTable", target: plan.table, sql },
      warnings: [],
    };
  }
  AssertOwned(plan, observed);
  const view: TableView = { dialect, mode, plan, observed };
  AssertSafe(view);
  return { step: FirstStep(TABLE_RULES, view), warnings: Warnings(view) };
}

/**
 * Pure. The next index step for a table whose columns converged, or none. `skipped` names the
 * indexes and key columns this phase already failed on, which it leaves for the next registration.
 */
export function NextIndexStep(
  dialect: Dialect,
  plan: TablePlan,
  observed: ObservedTable,
  skipped: ReadonlySet<string>,
): IndexStep | undefined {
  const folded = new Set([...skipped].map(Folded));
  return FirstStep(INDEX_RULES, { dialect, plan, observed, skipped: folded });
}
