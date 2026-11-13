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
}

/** What {@link DecodingContext.readingOuterRow} built, and whether building it read the outer row. */
export interface OuterRowRead<T> {
  readonly value: T;
  readonly readsOuterRow: boolean;
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
  /** Per open subquery, outermost first: how many reads of a parameter bound outside it it made. */
  private readonly outerReads: number[] = [];
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

  public bind(id: ParameterId, binding: ArgumentBinding): void {
    this.bindings.set(String(id), binding);
    this.bindingDepths.set(String(id), this.outerReads.length);
  }

  public unbind(id: ParameterId): void {
    this.bindings.delete(String(id));
    this.bindingDepths.delete(String(id));
  }

  /** A parameter's binding; every subquery opened since it was bound now reads its outer row. */
  public arg(id: ParameterId): ArgumentBinding {
    const binding = this.bindings.get(String(id));
    assert(binding, `Unbound lambda parameter ${id}`);
    const depth = this.bindingDepths.get(String(id)) ?? 0;
    for (let level = depth; level < this.outerReads.length; level++) {
      this.outerReads[level]++;
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
    this.outerReads.push(0);
    try {
      const relation = this.relation(stages);
      return { relation, readsOuterRow: this.readsOuterRow };
    } finally {
      this.outerReads.pop();
    }
  }

  /** Whether the subquery compiling now has so far read the row of a query outside it. */
  public get readsOuterRow(): boolean {
    return this.outerReadCount > 0;
  }

  private get outerReadCount(): number {
    return this.outerReads.at(-1) ?? 0;
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
