/**
 * The MariaDB 11.8 server the real code talks to, reduced to the one channel this check is about:
 * the warnings a statement raises and where they stay. Every rule of its behaviour below was read
 * off a real `mariadb:11.8` session (see SKILL.md, "What the model assumes"). A statement it does
 * not know stops the check, so an edit to the SQL cannot pass unread.
 */

export const PACKET = 1000;
/** A JSON function reaches the engine's nesting limit, and answers NULL with warning 4040, at this many containers. */
export const NEST_REACHED = 32;
export const LISTED_BY_DEFAULT = 64;
export const LISTED_AT_MOST = 65_535;

export const TOO_DEEP = 4040;
export const CUT_AGGREGATE = 1260;
export const HARMLESS = 1292;
export const SUBQUERY_ROWS = 1242;

/** A row of the table the payloads read: the document's nesting, its size and the warnings computing it raises. */
export interface DocRow {
  readonly containers: number;
  readonly bytes: number;
  readonly warns: number;
}

export type PayloadKind = "rows" | "aggregate" | "plain" | "update" | "stamp";

/** What a statement of the scenario asks the engine to compute. */
export interface Payload {
  readonly kind: PayloadKind;
  /** The containers the statement wraps each document in. */
  readonly wrap: number;
}

export type Cell = string | number | null;
export type Out = Readonly<Record<string, Cell>>;

interface Group {
  readonly level: "Warning" | "Error";
  readonly code: number;
  readonly count: number;
}

/** A statement the engine ran, in the order it ran. */
export interface Trace {
  readonly session: number;
  readonly text: string;
  readonly answer: string;
}

/** One computation of a payload over one version of the table. */
export interface Evaluation {
  readonly payload: Payload;
  readonly session: number;
  readonly reference: readonly Out[];
  readonly emitted: readonly Out[];
  readonly raised: number;
  readonly isDeep: boolean;
  readonly isCut: boolean;
  readonly isStrictFailure: boolean;
  readonly storesCut: boolean;
  readonly opIndex: number;
}

export class ModelError extends Error {}

export class ServerError extends Error {
  readonly sqlState = "HY000";
  constructor(
    readonly errno: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  readonly id: number;
  cap: number;
  groups: Group[];
  snapshot: readonly DocRow[] | undefined;
}

export interface Answer {
  readonly rows: readonly Out[];
  readonly affected: number;
  readonly warningStatus: number;
  readonly error: ServerError | undefined;
}

const KINDS: readonly PayloadKind[] = ["rows", "aggregate", "plain", "update", "stamp"];
const TAG = /'(rows|aggregate|plain|update|stamp);wrap=(\d)'/;
const CHECK = /@@warning_count \+ RAND\(\) >= (\d+)/;
const READS_A_TABLE = /\b(?:FROM|UPDATE)\b/i;

export function tagOf(payload: Payload): string {
  return `${payload.kind};wrap=${payload.wrap}`;
}

function docText(index: number, row: DocRow, wrap: number): string {
  return `doc${index}:c${row.containers}:b${row.bytes}:w${wrap}`;
}

function isDeep(row: DocRow, wrap: number): boolean {
  return row.containers + wrap >= NEST_REACHED;
}

function total(groups: readonly Group[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

function listed(groups: readonly Group[], cap: number): Out[] {
  const rows: Out[] = [];
  for (const group of groups) {
    for (let at = 0; at < group.count && rows.length < cap; at += 1) {
      rows.push({ Level: group.level, Code: group.code, Message: `${group.code}` });
    }
  }
  return rows;
}

interface Computed {
  readonly reference: Out[];
  readonly emitted: Out[];
  readonly groups: Group[];
  readonly isDeep: boolean;
  readonly isCut: boolean;
}

function computeRows(state: readonly DocRow[], payload: Payload): Computed {
  const groups: Group[] = [];
  const reference: Out[] = [];
  const emitted: Out[] = [];
  let isAnyDeep = false;
  state.forEach((row, index) => {
    const text = docText(index, row, payload.wrap);
    reference.push({ id: index, j: text });
    const deep = payload.kind !== "plain" && isDeep(row, payload.wrap);
    isAnyDeep ||= deep;
    emitted.push({ id: index, j: deep ? null : text });
    if (deep) {
      groups.push({ level: "Warning", code: TOO_DEEP, count: 1 });
    }
    if (payload.kind !== "plain" && row.warns > 0) {
      groups.push({ level: "Warning", code: HARMLESS, count: row.warns });
    }
  });
  return { reference, emitted, groups, isDeep: isAnyDeep, isCut: false };
}

function computeAggregate(state: readonly DocRow[], payload: Payload): Computed {
  const groups: Group[] = [];
  const texts: string[] = [];
  const emittedTexts: string[] = [];
  let length = 1;
  let isAnyDeep = false;
  state.forEach((row, index) => {
    const text = docText(index, row, payload.wrap);
    texts.push(text);
    const deep = isDeep(row, payload.wrap);
    isAnyDeep ||= deep;
    emittedTexts.push(deep ? "null" : text);
    length += row.bytes + 1;
    if (deep) {
      groups.push({ level: "Warning", code: TOO_DEEP, count: 1 });
    }
    if (row.warns > 0) {
      groups.push({ level: "Warning", code: HARMLESS, count: row.warns });
    }
  });
  const reference = state.length === 0 ? null : `[${texts.join(",")}]`;
  const isCut = length > PACKET;
  let emitted: string | null = reference === null ? null : `[${emittedTexts.join(",")}]`;
  if (isCut) {
    groups.push({ level: "Warning", code: CUT_AGGREGATE, count: 1 });
    emitted = `[${emittedTexts.join(",")}`.slice(0, PACKET);
  }
  return { reference: [{ j: reference }], emitted: [{ j: emitted }], groups, isDeep: isAnyDeep, isCut };
}

function describe(rows: readonly Out[]): string {
  return rows.length === 1 && rows[0]
    ? `1 row ${JSON.stringify(rows[0])}`
    : `${rows.length} rows`;
}

/** The server: the committed table, its sessions, and the hook that lets another session write between statements. */
export class MariaDb {
  table: DocRow[];
  readonly trace: Trace[] = [];
  readonly evaluations: Evaluation[] = [];
  opIndex = 0;
  statements = 0;
  beforeStatement: ((count: number) => void) | undefined;
  private nextSession = 1;

  constructor(table: readonly DocRow[]) {
    this.table = [...table];
  }

  open(): Session {
    const session: Session = { id: this.nextSession, cap: LISTED_BY_DEFAULT, groups: [], snapshot: undefined };
    this.nextSession += 1;
    return session;
  }

  /** Runs a statement as the engine does and answers what the driver would hand over. */
  run(session: Session, text: string): Answer {
    this.beforeStatement?.(this.statements);
    this.statements += 1;
    const answer = this.answer(session, text);
    this.trace.push({
      session: session.id,
      text: text.replace(/\s+/g, " ").slice(0, 96),
      answer: answer.error
        ? `error ${answer.error.errno}`
        : `${describe(answer.rows)}, ${total(session.groups)} warnings raised`,
    });
    return answer;
  }

  private answer(session: Session, text: string): Answer {
    const done = (rows: readonly Out[] = [], error?: ServerError, affected = 0, warningStatus = 0): Answer => ({
      rows,
      affected,
      warningStatus,
      error,
    });
    if (/^SHOW WARNINGS$/i.test(text.trim())) {
      return done(listed(session.groups, session.cap));
    }
    if (/^SELECT @@warning_count AS `warnings`$/i.test(text.trim())) {
      return done([{ warnings: total(session.groups) }]);
    }
    if (/^SET\b/i.test(text)) {
      return this.set(session, text);
    }
    if (/^START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY$/i.test(text.trim())) {
      session.snapshot = [...this.table];
      return done();
    }
    if (/^ROLLBACK$/i.test(text.trim())) {
      session.snapshot = undefined;
      return done();
    }
    if (!READS_A_TABLE.test(text)) {
      return this.tableless(text, done);
    }
    session.groups = [];
    return this.reads(session, text, done);
  }

  private set(session: Session, text: string): Answer {
    const cap = /max_error_count = (\d+)/.exec(text)?.[1];
    if (cap !== undefined) {
      session.cap = Number(cap);
    }
    if (!/^SET (?:NAMES |TRANSACTION ISOLATION LEVEL REPEATABLE READ$)/i.test(text.trim())) {
      throw new ModelError(`the engine does not know the statement ${text}`);
    }
    return { rows: [], affected: 0, warningStatus: 0, error: undefined };
  }

  private tableless(text: string, done: (rows?: readonly Out[]) => Answer): Answer {
    if (/^SELECT 1 AS `one`$/i.test(text.trim())) {
      return done([{ one: 1 }]);
    }
    throw new ModelError(`the engine does not know the statement ${text}`);
  }

  private reads(
    session: Session,
    text: string,
    done: (rows?: readonly Out[], error?: ServerError, affected?: number, warningStatus?: number) => Answer,
  ): Answer {
    if (/^SELECT 1 FROM \(SELECT 1\) AS `cleared`$/i.test(text.trim())) {
      return done([{ 1: 1 }]);
    }
    const tag = TAG.exec(text);
    const kind = KINDS.find((known) => known === tag?.[1]);
    if (!kind || !tag?.[2]) {
      throw new ModelError(`the engine does not know the statement ${text}`);
    }
    const payload: Payload = { kind, wrap: Number(tag[2]) };
    const state = session.snapshot ?? this.table;
    if (payload.kind === "update" || payload.kind === "stamp") {
      return this.writes(session, payload, state, done);
    }
    const computed = payload.kind === "aggregate" ? computeAggregate(state, payload) : computeRows(state, payload);
    session.groups = [...computed.groups];
    const check = CHECK.exec(text)?.[1];
    const evaluation = (error: ServerError | undefined, emitted: readonly Out[]): Evaluation => ({
      payload,
      session: session.id,
      reference: computed.reference,
      emitted,
      raised: total(computed.groups),
      isDeep: computed.isDeep,
      isCut: computed.isCut,
      isStrictFailure: error !== undefined,
      storesCut: false,
      opIndex: this.opIndex,
    });
    if (check !== undefined && computed.emitted.length > 0 && total(computed.groups) >= Number(check)) {
      session.groups.push({ level: "Error", code: SUBQUERY_ROWS, count: 1 });
      const error = new ServerError(SUBQUERY_ROWS, "Subquery returns more than 1 row");
      this.evaluations.push(evaluation(error, []));
      return done([], error);
    }
    const rows = check === undefined ? computed.emitted : computed.emitted.map((row) => ({ ...row, checked: null }));
    this.evaluations.push(evaluation(undefined, computed.emitted));
    return done(rows);
  }

  private writes(
    session: Session,
    payload: Payload,
    state: readonly DocRow[],
    done: (rows?: readonly Out[], error?: ServerError, affected?: number, warningStatus?: number) => Answer,
  ): Answer {
    const computed = payload.kind === "stamp" ? computeAggregate(state, payload) : computeRows(state, payload);
    const first = payload.kind === "update" ? state.findIndex((row) => isDeep(row, payload.wrap)) : -1;
    const raised = first === -1 ? computed.groups : this.before(state, first, payload);
    session.groups = [...raised];
    const base = {
      payload,
      session: session.id,
      reference: computed.reference,
      emitted: computed.emitted,
      raised: total(computed.groups),
      isDeep: computed.isDeep,
      isCut: computed.isCut,
      opIndex: this.opIndex,
    };
    if (first !== -1) {
      session.groups.push({ level: "Error", code: TOO_DEEP, count: 1 });
      this.evaluations.push({ ...base, isStrictFailure: true, storesCut: false });
      return done([], new ServerError(TOO_DEEP, "Limit of 32 on JSON nested structures depth is reached"));
    }
    this.evaluations.push({
      ...base,
      isStrictFailure: false,
      storesCut: payload.kind === "stamp" && (computed.isCut || computed.isDeep),
    });
    return done([], undefined, state.length, Math.min(total(computed.groups), LISTED_AT_MOST));
  }

  private before(state: readonly DocRow[], failing: number, payload: Payload): Group[] {
    return computeRows(state.slice(0, failing), payload).groups;
  }
}
