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
 * A group's key as a read outside the group's rows takes it, and how many folds of the group's
 * rows are compiling now, inside which a read takes the key of the row being folded.
 */
interface GroupKey {
  readonly aggregated: Compiled;
  folds: number;
  /** How many `map` stages over an array were compiling their callback when its mapper began. */
  elementMaps: number;
  /** How many queries over ordered or bounded rows were compiling their mapper when it began. */
  windows: number;
}

/** Where a read of a group's stream sits, among what the group's mapper opened around it. */
export interface StreamReadPlace {
  /** Inside the mapper of another group nested in the group's mapper. */
  readonly innerGroup: boolean;
  /** Inside the callback of a `map` stage over an array, whose value the walk aggregates. */
  readonly elementMap: boolean;
  /** Inside a query nested in the mapper over ordered or bounded rows. */
  readonly window: boolean;
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
  /** The key each group's mapper is bound to, by the binding. */
  private readonly groupKeys = new WeakMap<ArgumentBinding, GroupKey>();
  /** The keys of the groups whose mappers are compiling now, outermost first. */
  private readonly mappers: Compiled[] = [];
  /** How many `map` stages over an array are compiling their callback now. */
  private elementMapDepth = 0;
  /** How many queries over ordered or bounded rows are compiling their mapper now. */
  private windowDepth = 0;
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
  }

  /** A parameter's binding; every subquery opened since it was bound now reads its outer row. */
  public arg(id: ParameterId): ArgumentBinding {
    const key = String(id);
    const binding = this.bindings.get(key);
    assert(binding, `Unbound lambda parameter ${id}`);
    const depth = this.bindingDepths.get(key) ?? 0;
    for (const subquery of this.open.slice(depth)) {
      subquery.reads++;
      subquery.rows.add(this.bindingRows.get(key));
    }
    const group = this.groupKeys.get(binding);
    return group === undefined || group.folds > 0 ? binding : group.aggregated;
  }

  /**
   * Binds a group's key: `key` where a fold of the group's rows reads it, `aggregated` anywhere
   * else in the group's mapper. Answers the binding the mapper's key parameter takes.
   */
  public groupKey(key: Compiled, aggregated: Compiled): Compiled {
    this.groupKeys.set(key, {
      aggregated,
      folds: 0,
      elementMaps: 0,
      windows: 0,
    });
    return key;
  }

  /** Builds the mapper of the group whose key {@link DecodingContext.groupKey} bound. */
  public mappingGroup<T>(key: Compiled, build: () => T): T {
    const group = this.groupKeys.get(key);
    assert(group, "A group's mapper names a key no group bound");
    group.elementMaps = this.elementMapDepth;
    group.windows = this.windowDepth;
    this.mappers.push(key);
    try {
      return build();
    } finally {
      this.mappers.pop();
    }
  }

  /** Builds the callback of a `map` stage over an array, which the walk's aggregate reads. */
  public mappingElements<T>(build: () => T): T {
    this.elementMapDepth++;
    try {
      return build();
    } finally {
      this.elementMapDepth--;
    }
  }

  /** Builds the mapper of a query, over ordered or bounded rows where `windowed`. */
  public mappingRows<T>(windowed: boolean, build: () => T): T {
    const step = windowed ? 1 : 0;
    this.windowDepth += step;
    try {
      return build();
    } finally {
      this.windowDepth -= step;
    }
  }

  /** Where a read of the stream of the group whose key {@link DecodingContext.groupKey} bound sits now. */
  public streamReadPlace(key: Compiled): StreamReadPlace {
    const group = this.groupKeys.get(key);
    assert(group, "A read of a group's stream names a key no group bound");
    return {
      innerGroup: this.mappers.at(-1) !== key,
      elementMap: this.elementMapDepth > group.elementMaps,
      window: this.windowDepth > group.windows,
    };
  }

  /** Builds a fold of the rows of the group whose key {@link DecodingContext.groupKey} bound. */
  public foldingGroupRows<T>(key: Compiled, build: () => T): T {
    const group = this.groupKeys.get(key);
    assert(group, "A fold of a group's rows names a key no group bound");
    group.folds++;
    try {
      return build();
    } finally {
      group.folds--;
    }
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

  /** How many subqueries are open, which a parameter bound now is nested in. */
  public get depth(): number {
    return this.open.length;
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
