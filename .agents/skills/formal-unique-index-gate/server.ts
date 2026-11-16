/**
 * The MySQL server the real code converges a schema on, reduced to what the unique-index gate
 * depends on: the catalog of a table, the DDL that changes it, named locks, sessions that die, and
 * the ways a statement fails. A statement it does not know stops the check, so an edit to the SQL
 * cannot pass unread.
 */
import type { VirtualClock } from "./clock";

export const DATABASE = "db";
const DEFAULT_LOCK_WAIT_SECONDS = 50;
const MS = 1000;
const BUILD_MS = 2000;

const LOCK_WAIT_TIMEOUT = 1205;
const QUERY_INTERRUPTED = 1317;
const DUPLICATE_ENTRY = 1062;
const DUPLICATE_KEY_NAME = 1061;
const TABLE_EXISTS = 1050;
const DUPLICATE_COLUMN = 1060;
const CANT_DROP_KEY = 1091;
const KEY_TOO_LONG = 1071;

export type Cell = string | number | null;
export type Out = Readonly<Record<string, Cell>>;

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

/** A connection the server ended: a restart, a network drop or a `KILL` of the connection. */
export class LostConnection extends Error {
  readonly fatal = true;
  readonly code = "PROTOCOL_CONNECTION_LOST";
  constructor() {
    super("Connection lost: The server closed the connection.");
  }
}

export interface Column {
  readonly name: string;
  readonly type: string;
  readonly isGenerated: boolean;
  readonly comment: string;
}

export interface Index {
  readonly name: string;
  readonly isUnique: boolean;
  readonly comment: string;
  readonly columns: readonly string[];
}

interface Table {
  readonly comment: string;
  columns: Column[];
  indexes: Index[];
}

export interface Session {
  readonly id: number;
  readonly born: number;
  isDead: boolean;
  isBuilding: boolean;
  isKilled: boolean;
  isClosing: boolean;
  lockWaitSeconds: number;
  readonly locks: Set<string>;
}

/** Where a statement fails, and how. Each fault fires once, on the n-th statement of its class. */
export interface Fault {
  readonly on: "tableDdl" | "indexDdl" | "lock";
  readonly nth: number;
  readonly kind: "lockTimeout" | "interrupted" | "lost" | "lostAfter" | "present" | "restart" | "tooLong";
}

/** What is wrong with the server from the start, and until when, in seconds of virtual time. */
export interface Conditions {
  readonly faults: readonly Fault[];
  /** Rows that hold the same key keep a unique index from being built until then; `undefined` for ever. */
  readonly duplicatesUntil: number | undefined;
  readonly tableHeldUntil: number;
  readonly lockHeldUntil: { readonly tables: number; readonly indexes: number };
}

export interface Answer {
  readonly rows: readonly Out[];
  readonly affected: number;
}

export interface Trace {
  readonly session: number;
  readonly text: string;
  readonly answer: string;
}

const NO_CONDITIONS: Conditions = { faults: [], duplicatesUntil: 0, tableHeldUntil: 0, lockHeldUntil: { tables: 0, indexes: 0 } };

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = false;
  let current = "";
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote) {
      current += char;
      quote = char !== "'" || text.charAt(at + 1) === "'" ? quote : false;
      if (char === "'" && text.charAt(at + 1) === "'") {
        current += "'";
        at += 1;
      }
      continue;
    }
    if (char === "'") {
      quote = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function commentOf(definition: string): string {
  const found = /COMMENT '((?:[^']|'')*)'\s*$/.exec(definition.trim());
  return (found?.[1] ?? "").replaceAll("''", "'").replaceAll("\\\\", "\\");
}

function columnOf(definition: string): Column {
  const found = /^`((?:[^`]|``)+)` (.+)$/s.exec(definition);
  if (!found?.[1] || found[2] === undefined) {
    throw new ModelError(`the server does not know the column definition ${definition}`);
  }
  const rest = found[2];
  const type = /^(.*?)(?: NULL| NOT NULL| GENERATED| COMMENT|$)/s.exec(rest)?.[1] ?? rest;
  return { name: found[1].replaceAll("``", "`"), type: type.trim().toLowerCase(), isGenerated: /GENERATED ALWAYS AS/.test(rest), comment: commentOf(rest) };
}

function indexOf(definition: string): Index {
  const found = /^(UNIQUE )?INDEX `((?:[^`]|``)+)` \((.*)\) COMMENT '/s.exec(definition);
  if (!found?.[2] || found[3] === undefined) {
    throw new ModelError(`the server does not know the index definition ${definition}`);
  }
  const columns = [...found[3].matchAll(/`((?:[^`]|``)+)`/g)].map((one) => one[1] ?? "");
  return { name: found[2].replaceAll("``", "`"), isUnique: found[1] !== undefined, comment: commentOf(definition), columns };
}

export class MysqlServer {
  readonly tables = new Map<string, Table>();
  readonly trace: Trace[] = [];
  statements = 0;
  beforeStatement: ((count: number) => void) | undefined;
  conditions: Conditions = NO_CONDITIONS;
  epoch = 0;
  /** How many pools have connected to the server, and on which of them a statement failed. */
  pools = 0;
  readonly failedOn = new Set<number>();
  private nextSession = 1;
  private readonly sessions = new Map<number, Session>();
  private readonly held = new Map<string, Session>();
  private readonly seen: Record<Fault["on"], number> = { tableDdl: 0, indexDdl: 0, lock: 0 };
  private readonly fired = new Set<Fault>();

  constructor(private readonly clock: VirtualClock) {}

  open(): Session {
    const session: Session = {
      id: this.nextSession,
      born: this.epoch,
      isDead: false,
      isBuilding: false,
      isKilled: false,
      isClosing: false,
      lockWaitSeconds: DEFAULT_LOCK_WAIT_SECONDS,
      locks: new Set(),
    };
    this.nextSession += 1;
    this.sessions.set(session.id, session);
    return session;
  }

  /** Ends every session and releases every named lock, as a server restart does; the tables stay. */
  restart(): void {
    this.epoch += 1;
    for (const session of this.sessions.values()) {
      this.end(session);
    }
  }

  /** Forgets the statements counted so far, so a fault names the n-th statement from here on. */
  begin(conditions: Conditions): void {
    this.conditions = conditions;
    this.statements = 0;
    this.seen.tableDdl = 0;
    this.seen.indexDdl = 0;
    this.seen.lock = 0;
    this.fired.clear();
    this.trace.length = 0;
  }

  /** Whether the table holds the index, as the catalog lists it. */
  holds(table: string, name: string, signature: string): boolean {
    return this.tables.get(table)?.indexes.some((index) => index.name === name && index.comment === signature) ?? false;
  }

  /** The rows the catalog answers for an index of a table, for the model of another process's build. */
  indexNames(table: string): string[] {
    return this.tables.get(table)?.indexes.map((index) => index.name) ?? [];
  }

  /** Ends a session whose connection the client destroyed, with the named locks it held. */
  terminate(session: Session): void {
    this.end(session);
  }

  /** Ends a session whose pool ended, so no statement of it answers any more. */
  close(session: Session): void {
    if (session.isBuilding) {
      session.isClosing = true;
    } else {
      this.end(session);
    }
  }

  private end(session: Session): void {
    session.isDead = true;
    for (const name of session.locks) {
      this.held.delete(name);
    }
    session.locks.clear();
  }

  private boundary(): void {
    this.beforeStatement?.(this.statements);
    this.statements += 1;
  }

  private fault(on: Fault["on"]): Fault["kind"] | undefined {
    const nth = this.seen[on];
    this.seen[on] += 1;
    const fault = this.conditions.faults.find((candidate) => candidate.on === on && candidate.nth === nth && !this.fired.has(candidate));
    if (fault) {
      this.fired.add(fault);
    }
    return fault?.kind;
  }

  /** Runs a statement as the server does, answering its rows or failing as it fails. */
  async run(session: Session, text: string, args: readonly unknown[]): Promise<Answer> {
    this.boundary();
    try {
      this.assertAlive(session);
    } catch (error) {
      this.trace.push({ session: session.id, text: text.replace(/\s+/g, " ").slice(0, 110), answer: "the connection is gone" });
      throw error;
    }
    let answer: Answer;
    try {
      answer = await this.answer(session, text.trim(), args);
    } catch (error) {
      this.trace.push({ session: session.id, text: text.replace(/\s+/g, " ").slice(0, 110), answer: error instanceof Error ? `error ${error.message.slice(0, 60)}` : "error" });
      throw error;
    }
    this.trace.push({ session: session.id, text: text.replace(/\s+/g, " ").slice(0, 110), answer: `${answer.rows.length} rows, ${answer.affected} affected` });
    return answer;
  }

  private assertAlive(session: Session): void {
    if (session.born !== this.epoch) {
      this.end(session);
    }
    if (session.isDead) {
      throw new LostConnection();
    }
  }

  private ok(rows: readonly Out[] = [], affected = 0): Answer {
    return { rows, affected };
  }

  private async answer(session: Session, text: string, args: readonly unknown[]): Promise<Answer> {
    const answered = this.sessionStatement(session, text);
    if (answered) {
      return answered;
    }
    if (/^CREATE TABLE IF NOT EXISTS /i.test(text) || /^INSERT (?:IGNORE )?INTO `__antelope_/i.test(text)) {
      return this.ok();
    }
    if (/FROM information_schema\./i.test(text)) {
      return this.catalog(text, args);
    }
    if (text.startsWith("CREATE TABLE `")) {
      return this.createTable(session, text);
    }
    const alter = /^ALTER TABLE `((?:[^`]|``)+)` (.*)$/s.exec(text);
    if (alter?.[1] && alter[2] !== undefined) {
      return this.alter(session, alter[1], alter[2]);
    }
    throw new ModelError(`the server does not know the statement ${text}`);
  }

  /** The statements that act on the session: its settings, its named locks and a kill. */
  private sessionStatement(session: Session, text: string): Answer | undefined {
    if (/^SET NAMES /i.test(text)) {
      return this.ok();
    }
    const wait = /^SET SESSION lock_wait_timeout = (DEFAULT|\d+)$/i.exec(text)?.[1];
    if (wait !== undefined) {
      session.lockWaitSeconds = wait === "DEFAULT" ? DEFAULT_LOCK_WAIT_SECONDS : Number(wait);
      return this.ok();
    }
    if (/^SELECT DATABASE\(\) AS `?name`?$/i.test(text)) {
      return this.ok([{ name: DATABASE }]);
    }
    const lock = /^SELECT GET_LOCK\('([^']+)', (\d+)\) AS `?acquired`?$/i.exec(text);
    if (lock?.[1]) {
      return this.getLock(session, lock[1]);
    }
    const release = /^SELECT RELEASE_LOCK\('([^']+)'\) AS `?released`?$/i.exec(text);
    if (release?.[1]) {
      const was = this.held.get(release[1]) === session;
      this.held.delete(release[1]);
      session.locks.delete(release[1]);
      return this.ok([{ released: was ? 1 : 0 }]);
    }
    const kill = /^KILL QUERY (\d+)$/i.exec(text)?.[1];
    if (kill !== undefined) {
      const target = this.sessions.get(Number(kill));
      if (target?.isBuilding) {
        target.isKilled = true;
      }
      return this.ok();
    }
    return undefined;
  }

  private purposeOf(name: string): "tables" | "indexes" {
    const purpose = name.split(":")[1];
    if (purpose !== "tables" && purpose !== "indexes") {
      throw new ModelError(`the server does not know the named lock ${name}`);
    }
    return purpose;
  }

  private getLock(session: Session, name: string): Answer {
    const kind = this.fault("lock");
    if (kind === "lost") {
      this.end(session);
      throw new LostConnection();
    }
    if (kind === "restart") {
      this.restart();
      throw new LostConnection();
    }
    const heldElsewhere = this.held.get(name);
    const external = this.clock.now < this.conditions.lockHeldUntil[this.purposeOf(name)] * MS;
    if ((heldElsewhere && heldElsewhere !== session) || external) {
      return this.ok([{ acquired: 0 }]);
    }
    this.held.set(name, session);
    session.locks.add(name);
    return this.ok([{ acquired: 1 }]);
  }

  private catalog(text: string, args: readonly unknown[]): Answer {
    const table = this.tables.get(String(args[0]));
    if (/information_schema\.TABLES/i.test(text)) {
      return this.ok(table ? [{ kind: "BASE TABLE", comment: table.comment }] : []);
    }
    if (!table) {
      return this.ok();
    }
    if (/information_schema\.COLUMNS/i.test(text)) {
      return this.ok(table.columns.map((column) => ({ name: column.name, type: column.type, extra: column.isGenerated ? "VIRTUAL GENERATED" : "", comment: column.comment })));
    }
    if (/information_schema\.STATISTICS/i.test(text)) {
      const sorted = [...table.indexes].sort((left, right) => (left.name < right.name ? -1 : 1));
      return this.ok(sorted.flatMap((index) => index.columns.map((column) => ({ name: index.name, non_unique: index.isUnique ? 0 : 1, comment: index.comment, column_name: column }))));
    }
    if (/information_schema\.TRIGGERS/i.test(text)) {
      return this.ok();
    }
    throw new ModelError(`the server does not know the catalog read ${text}`);
  }

  private createTable(session: Session, text: string): Answer {
    const found = /^CREATE TABLE `((?:[^`]|``)+)` \((.*)\) ENGINE=InnoDB[^)]* COMMENT='((?:[^']|'')*)'$/s.exec(text);
    if (!found?.[1] || found[2] === undefined) {
      throw new ModelError(`the server does not know the statement ${text}`);
    }
    const kind = this.fault("tableDdl");
    this.fail(session, kind);
    if (this.tables.has(found[1])) {
      throw new ServerError(TABLE_EXISTS, `Table '${found[1]}' already exists`);
    }
    const columns: Column[] = [];
    const indexes: Index[] = [];
    for (const definition of splitTop(found[2])) {
      if (definition.startsWith("PRIMARY KEY")) {
        continue;
      }
      if (/^(?:UNIQUE )?INDEX /.test(definition)) {
        indexes.push(indexOf(definition));
      } else {
        columns.push(columnOf(definition));
      }
    }
    this.tables.set(found[1], { comment: found[3] ?? "", columns, indexes });
    return this.ok();
  }

  private fail(session: Session, kind: Fault["kind"] | undefined): void {
    switch (kind) {
      case "lockTimeout":
        throw new ServerError(LOCK_WAIT_TIMEOUT, "Lock wait timeout exceeded; try restarting transaction");
      case "interrupted":
        throw new ServerError(QUERY_INTERRUPTED, "Query execution was interrupted");
      case "lost":
        this.end(session);
        throw new LostConnection();
      case "restart":
        this.restart();
        throw new LostConnection();
      case "tooLong":
        throw new ServerError(KEY_TOO_LONG, "Specified key was too long");
      case "lostAfter":
      case "present":
      case undefined:
        return;
    }
  }

  private async alter(session: Session, name: string, actions: string): Promise<Answer> {
    const table = this.tables.get(name);
    const items = splitTop(actions).filter((item) => !/^(?:ALGORITHM|LOCK)=/.test(item));
    const isIndexDdl = items.some((item) => /INDEX /.test(item));
    const kind = this.fault(isIndexDdl ? "indexDdl" : "tableDdl");
    this.fail(session, kind);
    if (!table) {
      throw new ServerError(1146, `Table '${name}' doesn't exist`);
    }
    if (isIndexDdl) {
      await this.hold(session);
      session.isBuilding = true;
      try {
        await this.clock.delay(BUILD_MS);
        this.boundary();
        this.assertAlive(session);
        if (session.isKilled) {
          throw new ServerError(QUERY_INTERRUPTED, "Query execution was interrupted");
        }
        if (kind === "present") {
          this.raced(table, items);
        }
        this.apply(table, items);
      } finally {
        session.isBuilding = false;
        session.isKilled = false;
        if (session.isClosing) {
          this.end(session);
        }
      }
      if (kind === "lostAfter") {
        this.end(session);
        throw new LostConnection();
      }
      return this.ok();
    }
    await this.hold(session);
    this.apply(table, items);
    if (kind === "lostAfter") {
      this.end(session);
      throw new LostConnection();
    }
    return this.ok();
  }

  private async hold(session: Session): Promise<void> {
    const until = this.conditions.tableHeldUntil * MS;
    if (this.clock.now >= until) {
      return;
    }
    const wait = session.lockWaitSeconds * MS;
    if (until - this.clock.now > wait) {
      await this.clock.delay(wait);
      throw new ServerError(LOCK_WAIT_TIMEOUT, "Lock wait timeout exceeded; try restarting transaction");
    }
    await this.clock.delay(until - this.clock.now);
  }

  private raced(table: Table, items: readonly string[]): void {
    const added = items.find((item) => /^ADD (?:UNIQUE )?INDEX /.test(item));
    if (added) {
      table.indexes = table.indexes.filter((index) => index.name !== indexOf(added.replace(/^ADD /, "")).name);
      table.indexes.push(indexOf(added.replace(/^ADD /, "")));
    }
  }

  private apply(table: Table, items: readonly string[]): void {
    const columns = [...table.columns];
    let indexes = [...table.indexes];
    for (const item of items) {
      const dropIndex = /^DROP INDEX `((?:[^`]|``)+)`$/.exec(item)?.[1];
      const dropColumn = /^DROP COLUMN `((?:[^`]|``)+)`$/.exec(item)?.[1];
      if (dropIndex !== undefined) {
        if (!indexes.some((index) => index.name === dropIndex)) {
          throw new ServerError(CANT_DROP_KEY, `Can't DROP '${dropIndex}'; check that column/key exists`);
        }
        indexes = indexes.filter((index) => index.name !== dropIndex);
      } else if (dropColumn !== undefined) {
        columns.splice(columns.findIndex((column) => column.name === dropColumn), 1);
      } else if (item.startsWith("ADD COLUMN ")) {
        const column = columnOf(item.replace(/^ADD COLUMN /, ""));
        if (columns.some((one) => one.name === column.name)) {
          throw new ServerError(DUPLICATE_COLUMN, `Duplicate column name '${column.name}'`);
        }
        columns.push(column);
      } else if (item.startsWith("MODIFY COLUMN ")) {
        const column = columnOf(item.replace(/^MODIFY COLUMN /, ""));
        columns.splice(columns.findIndex((one) => one.name === column.name), 1, column);
      } else if (/^ADD (?:UNIQUE )?INDEX /.test(item)) {
        const index = indexOf(item.replace(/^ADD /, ""));
        if (indexes.some((one) => one.name === index.name)) {
          throw new ServerError(DUPLICATE_KEY_NAME, `Duplicate key name '${index.name}'`);
        }
        const duplicates = this.conditions.duplicatesUntil === undefined || this.clock.now < this.conditions.duplicatesUntil * MS;
        if (index.isUnique && duplicates) {
          throw new ServerError(DUPLICATE_ENTRY, `Duplicate entry '1' for key '${index.name}'`);
        }
        indexes.push(index);
      } else {
        throw new ModelError(`the server does not know the alteration ${item}`);
      }
    }
    table.columns = columns;
    table.indexes = indexes;
  }
}
