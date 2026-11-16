import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Dialect } from "../../dialect";
import type { Sql } from "../../statement";
import type { Compiled } from "./sql";
import type { Relation } from "./relation";
import type { RowSource } from "./row-source";
import type { OriginResolver } from "./selection";

/**
 * The key a lambda parameter is bound under. A `func` rebuilt from JSON may carry an id of any
 * shape, so callers pass `String(id)`, which is the key a plain object gave it.
 */
export type ParameterId = number | string;

export type SubqueryProvider = (stages: QueryStage[]) => Compiled;

export type ArgumentBinding = RowSource | SubqueryProvider | Compiled;

/** Whether a binding is a subquery provider, the one binding that is called rather than read. */
export function IsSubqueryProvider(
  binding: ArgumentBinding,
): binding is SubqueryProvider {
  return typeof binding === "function";
}

type ExpressionCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
  source?: RowSource,
) => Compiled;

type SubqueryCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
) => Compiled;

type RelationCompiler = (
  stages: QueryStage[],
  context: DecodingContext,
) => Relation;

/**
 * The nested compilations a stage or an expression can ask for, injected rather than imported.
 *
 * Named rather than positional because `expression` and `subquery` take the same parameters and
 * answer the same type, so swapping them would still typecheck. A compilation belongs here only
 * when the caller sits *below* the compiler it needs, so importing it would close a require cycle.
 */
export interface Compilers {
  expression: ExpressionCompiler;
  subquery: SubqueryCompiler;
  relation: RelationCompiler;
}

const ALIAS_PREFIX = "t";

/** A query nested inside another one as a value, compiled. */
export interface NestedRelation {
  readonly relation: Relation;
  /** Whether it read the row of a query outside it, through a parameter bound there. */
  readonly readsOuterRow: boolean;
  /** The rows of the one query outside it whose row it read, where {@link DecodingContext.outerRows} knows them. */
  readonly outerRows?: Relation;
}

/** What {@link DecodingContext.readingOuterRow} built, and whether building it read the outer row. */
export interface OuterRowRead<T> {
  readonly value: T;
  readonly readsOuterRow: boolean;
}

/**
 * One subquery compiling now: how many reads of a parameter bound outside it it made, and the rows
 * each parameter it read ranges over, `undefined` for a parameter bound with no rows named.
 */
interface OpenSubquery {
  reads: number;
  readonly rows: Set<Relation | undefined>;
}

/**
 * A query nested in a group's mapper that reads the group's key, its stream or a row from outside
 * the group. MySQL and MariaDB run such a query's aggregate in the group's select, where it fails
 * or answers another group's rows, so the module refuses it while it builds the statement.
 */
export class NestedGroupRead extends Error {
  public readonly code = "ANTELOPEJS_MYSQL_NESTED_GROUP_READ";

  public constructor(refused: string) {
    super(
      `${refused}, which MySQL and MariaDB cannot run as one statement. Read the group's key and stream in the group's own select, outside any nested query, aggregate values that read the group's rows, or run two queries`,
    );
  }
}

/** What a lambda of the innermost group's stream read, beside what it built. */
export interface StreamLambdaRead<T> {
  readonly value: T;
  /** A row from outside the group. */
  readonly outside: boolean;
  /** The lambda's own parameter, the value the stream held before it, outside any array walk. */
  readonly parameter: boolean;
  /** A value bound in the group's select before the lambda, such as the group's key. */
  readonly group: boolean;
}

/** What a build read so far, by where the parameters it read were bound. */
interface StreamLambdaWatch {
  outside: boolean;
  /** The reads of the lambda's own parameter not yet found inside an array walk, by read number. */
  readonly parameter: Set<number>;
  group: boolean;
  readonly before: number;
  readonly depth: number;
  /** Whether the parameter holds a value that read the group's key or stream, or an outside row. */
  readonly tainted: boolean;
}

/** A group whose mapper is compiling now. */
interface OpenGroup {
  /** How many subqueries were open when the group's select began. */
  readonly depth: number;
  /** What the mapper's own parameters are bound to: the group's stream and key. */
  readonly own: ReadonlySet<ArgumentBinding>;
}

/**
 * State shared by every layer compiling a single statement: the dialect it is written for, the
 * table alias counter and the bindings of lambda parameters. Bound values travel inside each
 * fragment, so there is no parameter ledger to keep in step.
 *
 * The compilers are injected so this module stays free of a circular import back onto them.
 */
export class DecodingContext {
  private readonly bindings = new Map<string, ArgumentBinding>();
  /** How many subqueries were open when each lambda parameter was bound. */
  private readonly bindingDepths = new Map<string, number>();
  /** The rows each lambda parameter ranges over, where the stage that bound it named them. */
  private readonly bindingRows = new Map<string, Relation>();
  /** Each group whose mapper is compiling now, outermost first. */
  private readonly groups: OpenGroup[] = [];
  /** The order each lambda parameter was bound in. */
  private readonly bindingOrder = new Map<string, number>();
  private bindCount = 0;
  private readonly streamLambdaWatches: StreamLambdaWatch[] = [];
  private groupReadCount = 0;
  private readCount = 0;
  /** Per open subquery, outermost first. */
  private readonly open: OpenSubquery[] = [];
  /** Fragments built while the subquery they are in read no parameter bound outside it. */
  private readonly outerFree = new WeakSet<Sql>();
  private aliasCounter = 0;

  /**
   * @param compilers The nested compilations this statement's layers reach back for.
   * @param dialect The engine every fragment of the statement is spelled for.
   * @param resolveOrigin How a root learns about its table; absent in production, which reads the
   * live registry, and set by a spec that compiles against a stub one. Supplied once, so both sides
   * of a union resolve against the same registry.
   */
  public constructor(
    private readonly compilers: Compilers,
    public readonly dialect: Dialect,
    public readonly resolveOrigin?: OriginResolver,
  ) {}

  /** A context compiling a separate statement, with the same compilers and dialect. */
  public sibling(): DecodingContext {
    return new DecodingContext(
      this.compilers,
      this.dialect,
      this.resolveOrigin,
    );
  }

  public nextAlias(): string {
    return `${ALIAS_PREFIX}${this.aliasCounter++}`;
  }

  /**
   * Binds a lambda parameter. `rows` names the relation the parameter ranges over, one row of it per
   * call, where the binding stage calls the lambda once for each of its rows.
   */
  public bind(
    id: ParameterId,
    binding: ArgumentBinding,
    rows?: Relation,
  ): void {
    const key = String(id);
    this.bindings.set(key, binding);
    this.bindingDepths.set(key, this.open.length);
    this.bindingOrder.set(key, this.bindCount++);
    if (rows) {
      this.bindingRows.set(key, rows);
    } else {
      this.bindingRows.delete(key);
    }
  }

  public unbind(id: ParameterId): void {
    this.bindings.delete(String(id));
    this.bindingDepths.delete(String(id));
    this.bindingRows.delete(String(id));
    this.bindingOrder.delete(String(id));
  }

  /**
   * A parameter's binding; every subquery opened since it was bound now reads its outer row. A read
   * from a query nested in a group's mapper of anything bound at or outside the group is refused.
   */
  public arg(id: ParameterId): ArgumentBinding {
    const key = String(id);
    const binding = this.bindings.get(key);
    assert(binding, `Unbound lambda parameter ${id}`);
    const depth = this.bindingDepths.get(key) ?? 0;
    for (const subquery of this.open.slice(depth)) {
      subquery.reads++;
      subquery.rows.add(this.bindingRows.get(key));
    }
    const reading = this.open.length;
    if (
      this.groups.some((group) => depth <= group.depth && reading > group.depth)
    ) {
      throw new NestedGroupRead(
        "A query nested in a group's mapper reads a value bound in the group's select or outside it, such as the group's key, the group's stream or a row from outside the group",
      );
    }
    const order = this.bindingOrder.get(key) ?? 0;
    const group = this.groups.at(-1);
    if (
      group !== undefined &&
      group.depth > 0 &&
      (depth < group.depth ||
        group.own.has(binding) ||
        this.streamLambdaWatches.some(
          (watch) => watch.tainted && watch.before === order,
        ))
    ) {
      this.groupReadCount++;
    }
    this.readCount++;
    for (const watch of this.streamLambdaWatches) {
      watch.outside ||= depth < watch.depth;
      if (order === watch.before) {
        watch.parameter.add(this.readCount);
      }
      watch.group ||= depth === watch.depth && order < watch.before;
    }
    return binding;
  }

  public expression(stages: QueryStage[], source?: RowSource): Compiled {
    return this.compilers.expression(stages, this, source);
  }

  public subquery(stages: QueryStage[]): Compiled {
    return this.compilers.subquery(stages, this);
  }

  /** The one door to a query nested inside another one. */
  public relation(stages: QueryStage[]): Relation {
    return this.compilers.relation(stages, this);
  }

  /** A query nested inside another one as a value. */
  public subqueryRelation(stages: QueryStage[]): NestedRelation {
    this.open.push({ reads: 0, rows: new Set() });
    try {
      const relation = this.relation(stages);
      return {
        relation,
        readsOuterRow: this.readsOuterRow,
        outerRows: this.outerRows,
      };
    } finally {
      this.open.pop();
    }
  }

  /**
   * Builds a one-parameter lambda of the innermost group's stream, and tells what it read: a row
   * from outside the group, its own parameter, or a value bound in the group's select before it.
   * Where `tainted`, the parameter holds a value that read the group's key or stream, or a row from
   * outside the group, and a read of it counts as one of those.
   */
  public readingStreamLambda<T>(
    tainted: boolean,
    build: () => T,
  ): StreamLambdaRead<T> {
    const watch: StreamLambdaWatch = {
      outside: false,
      parameter: new Set(),
      group: false,
      before: this.bindCount,
      depth: this.groups.at(-1)?.depth ?? 0,
      tainted,
    };
    this.streamLambdaWatches.push(watch);
    try {
      const value = build();
      const { outside, group } = watch;
      return { value, outside, parameter: watch.parameter.size > 0, group };
    } finally {
      this.streamLambdaWatches.splice(
        this.streamLambdaWatches.indexOf(watch),
        1,
      );
    }
  }

  /**
   * Builds a group's mapper, whose parameters are bound to `own`. A query nested in it may read its
   * own rows and constants only: a read of anything bound at or outside the group's select is
   * refused.
   */
  public inGroup<T>(own: readonly ArgumentBinding[], build: () => T): T {
    this.groups.push({ depth: this.open.length, own: new Set(own) });
    try {
      return build();
    } finally {
      this.groups.pop();
    }
  }

  /**
   * How many reads of the innermost group's key or stream, or of a row from outside it, were made
   * while that group sits in another query. It only grows, so two readings bracket a build.
   */
  public get groupReads(): number {
    return this.groupReadCount;
  }

  /** How many parameter reads were made so far. It only grows, so two readings bracket a build. */
  public get reads(): number {
    return this.readCount;
  }

  /**
   * Marks the parameter reads made since `since` as inside an array walk. Neither engine reads such
   * a column when it picks the select an aggregate runs in, so a stream lambda's own parameter read
   * there does not count as reading the group's rows.
   */
  public walked(since: number): void {
    for (const watch of this.streamLambdaWatches) {
      for (const read of watch.parameter) {
        if (read >= since) {
          watch.parameter.delete(read);
        }
      }
    }
  }

  /** Whether the subquery compiling now has so far read the row of a query outside it. */
  public get readsOuterRow(): boolean {
    return this.outerReadCount > 0;
  }

  /**
   * The rows of the one query outside the subquery compiling now whose row it has read so far, where
   * every parameter it read ranges over those rows; none where it read none, or rows of another.
   */
  public get outerRows(): Relation | undefined {
    const rows = this.open.at(-1)?.rows;
    return rows?.size === 1 ? [...rows][0] : undefined;
  }

  private get outerReadCount(): number {
    return this.open.at(-1)?.reads ?? 0;
  }

  /**
   * Builds part of the subquery compiling now, and tells whether building it read the row of a
   * query outside that subquery.
   */
  public readingOuterRow<T>(build: () => T): OuterRowRead<T> {
    const before = this.outerReadCount;
    const value = build();
    return { value, readsOuterRow: this.outerReadCount !== before };
  }

  /**
   * Builds a fragment of the subquery compiling now, and remembers it as reading no row of a query
   * outside it when building it read none.
   */
  public fragment(build: () => Sql): Sql {
    const { value, readsOuterRow } = this.readingOuterRow(build);
    if (!readsOuterRow) {
      this.outerFree.add(value);
    }
    return value;
  }

  /**
   * Whether {@link DecodingContext.fragment} saw it read no row of a query outside the
   * subquery it was built in. A fragment built any other way may read one.
   */
  public readsNoOuterRow(fragment: Sql): boolean {
    return this.outerFree.has(fragment);
  }
}
