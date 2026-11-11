import type { Dialect } from "../../dialect";
import { type Sql, sql } from "../../statement";
import { Cast, WithDefault } from "./coerce";
import { Defaulted } from "./readings";
import { DocumentKeys, type TableModel } from "./fields";
import type { KeyColumn, KeyPart } from "./paths";
import { KeyAt } from "./json";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";
import { type Compiled, QualifiedColumn, type ValuePath } from "./sql";
import {
  BOOL,
  FLOAT,
  IsJsonBacked,
  JsonOf,
  OPAQUE,
  KeyTypesOf,
  type KeyTypes,
  type SqlType,
  TEXT,
} from "./types";

/**
 * Field access over a row, so the same expression compiler works against typed columns and
 * against a JSON value.
 */
export interface RowSource {
  field(name: string, def?: Compiled): Compiled;
  dynamicField(key: Compiled, def?: Compiled): Compiled;
  toJson(): Compiled;
  keyTypes(): KeyTypes | undefined;
}

export interface DocumentMember extends Compiled {
  name: string;
}

function MemberKeyTypes(members: DocumentMember[]): KeyTypes {
  const keyTypes: Record<string, SqlType> = {};
  for (const member of members) {
    keyTypes[member.name] = member.type;
  }
  return keyTypes;
}

/**
 * Materializes named members as one JSON document.
 *
 * A member that is SQL NULL is absent, and a JSON-backed member keeps the nulls inside it.
 * `overflow` is merged in beside them, for the unstructured column a table carries beside its
 * declared fields; its keys are unknown, so they are absent from the returned type.
 */
export function BuildDocument(
  dialect: Dialect,
  members: DocumentMember[],
  overflow?: Sql,
): Compiled {
  const parts = members.map((member) => ({
    name: member.name,
    value: Cast(dialect, member, OPAQUE).sql,
    container: IsJsonBacked(member.type),
  }));
  return {
    sql: dialect.sql.json.document(parts, overflow),
    type: JsonOf(MemberKeyTypes(members)),
  };
}

/** Names a key in the message {@link Defaulted} raises for a default the column cannot hold. */
function KeySubject(name: string): string {
  return `The default for key '${name}'`;
}

/** How a row source reaches one physical column, as the type that column holds. */
export type ColumnAddress = (column: string, type: SqlType) => Compiled;

/** A column of a real table row, which already is the type it was declared as. */
export function AliasedColumns(alias: string): ColumnAddress {
  return (column, type) => ({ sql: QualifiedColumn(alias, column), type });
}

/** The key columns of a table as one row of it addresses them. */
export interface RowKeys {
  readonly alias: string;
  readonly columns: readonly KeyColumn[];
}

/** One part of an index key, read off a row: the value it compares, and what it orders by. */
export interface IndexedValue {
  readonly value: Compiled;
  readonly order: Sql;
}

/**
 * The type a key column's read has. A `json` key holds the canonical text of its value, which the
 * compiler reads as the value itself.
 */
const KEY_READ_TYPES: Record<Exclude<KeyColumn["read"], "json">, SqlType> = {
  text: TEXT,
  string: TEXT,
  double: FLOAT,
  bool: BOOL,
};

/**
 * A row of a table the adapter owns: declared fields are their own typed columns, anything else a
 * member of the overflow column. `keys` are the table's key columns where the row is the table
 * itself, so a read that a key column holds can name it; a subselect over the table leaves them
 * out of its select list.
 */
export class ColumnRowSource implements RowSource {
  public constructor(
    private readonly dialect: Dialect,
    private readonly address: ColumnAddress,
    private readonly table: TableModel,
    private readonly keys?: RowKeys,
  ) {}

  public field(name: string, def?: Compiled): Compiled {
    if (name === ID_COLUMN) {
      return Defaulted(
        this.dialect,
        this.address(ID_COLUMN, TEXT),
        def,
        KeySubject(name),
      );
    }
    if (name === INSTANCE_COLUMN) {
      return Defaulted(this.dialect, this.instance(), def, KeySubject(name));
    }
    if (Object.hasOwn(this.table.fields, name)) {
      const spec = this.table.fields[name];
      return Defaulted(
        this.dialect,
        this.declared(spec.column, spec.type),
        def,
        KeySubject(name),
      );
    }
    const member: Compiled = {
      sql: this.dialect.sql.json.member(this.overflow(), name),
      type: OPAQUE,
      path: this.path(EXTRA_COLUMN, [name]),
    };
    return WithDefault(this.dialect, member, def);
  }

  private keyRead(read: KeyColumn["read"], value: Sql): Compiled {
    if (read === "json") {
      return { sql: value, type: OPAQUE };
    }
    return {
      sql: this.dialect.sql.json.key(read, value),
      type: KEY_READ_TYPES[read],
    };
  }

  /** A declared column, with the key column over it or the path a read below it starts from. */
  private declared(column: string, type: SqlType): Compiled {
    const value = this.address(column, type);
    if (IsJsonBacked(type)) {
      return { ...value, path: this.path(column, []) };
    }
    if (type.kind !== "text" || !this.keys) {
      return value;
    }
    const key = KeyAt(this.keys.alias, this.keys.columns, column, [], "text");
    return key ? { ...value, key } : value;
  }

  private path(source: string, path: string[]): ValuePath | undefined {
    if (!this.keys) {
      return undefined;
    }
    return { alias: this.keys.alias, keys: this.keys.columns, source, path };
  }

  /**
   * The instance a row is in, as the caller sees it: the default instance is stored as the empty
   * string so it compares like any other, and is answered as SQL NULL so a document carries the
   * instance it came from only when there is a named one to carry.
   */
  private instance(): Compiled {
    const stored = this.address(INSTANCE_COLUMN, TEXT);
    return {
      sql: sql`NULLIF(${stored.sql}, ${this.dialect.sql.scalar.bind.text(DEFAULT_INSTANCE_ID)})`,
      type: TEXT,
    };
  }

  private overflow(): Sql {
    return this.address(EXTRA_COLUMN, OPAQUE).sql;
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    const document = this.toJson().sql;
    const name = Cast(this.dialect, key, TEXT).sql;
    return WithDefault(
      this.dialect,
      {
        sql: this.dialect.sql.json.dynamicMember(document, name),
        type: OPAQUE,
      },
      def,
    );
  }

  private members(): DocumentMember[] {
    return DocumentKeys(this.table).map((name) => ({
      name,
      ...this.field(name),
    }));
  }

  public toJson(): Compiled {
    const json = this.dialect.sql.json;
    const overflow = sql`COALESCE(${this.overflow()}, ${json.emptyObject})`;
    return BuildDocument(this.dialect, this.members(), overflow);
  }

  public keyTypes(): KeyTypes {
    return MemberKeyTypes(this.members());
  }

  /**
   * One part of a declared index read off this row: a stored column as itself, and a key column's
   * part as the whole value it reads, beside the key column a comparison can be served by and the
   * column the rows are ordered by. Where the row is not the table itself, the value is read in
   * full and ordered by.
   */
  public indexed(part: Exclude<KeyPart, { kind: "instance" }>): IndexedValue {
    if (part.kind !== "key") {
      const value = this.field(part.field);
      return { value, order: value.sql };
    }
    const key = part.key;
    const json = this.dialect.sql.json;
    const read = key.path.reduce(
      (document, segment) => json.member(document, segment),
      this.address(key.source, OPAQUE).sql,
    );
    const value = this.keyRead(key.read, read);
    if (!this.keys) {
      return { value, order: value.sql };
    }
    const column = QualifiedColumn(this.keys.alias, key.name);
    const comparable =
      key.read === "json" ? value : { ...value, key: { column, key } };
    return { value: comparable, order: column };
  }
}

/** A row that is one JSON value, as a projection or a nested document yields it. */
export class JsonRowSource implements RowSource {
  public constructor(
    private readonly dialect: Dialect,
    private readonly value: Compiled,
  ) {}

  public field(name: string, def?: Compiled): Compiled {
    const parent = this.toJson();
    const path = parent.path && {
      ...parent.path,
      path: [...parent.path.path, name],
    };
    const raw: Compiled = {
      sql: this.dialect.sql.json.member(parent.sql, name),
      type: OPAQUE,
      path,
    };
    return WithDefault(
      this.dialect,
      Cast(this.dialect, raw, this.fieldType(name)),
      def,
    );
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    const name = Cast(this.dialect, key, TEXT).sql;
    return WithDefault(
      this.dialect,
      {
        sql: this.dialect.sql.json.dynamicMember(this.toJson().sql, name),
        type: OPAQUE,
      },
      def,
    );
  }

  private fieldType(name: string): SqlType {
    const keyTypes = this.keyTypes();
    if (!keyTypes || !Object.hasOwn(keyTypes, name)) {
      return OPAQUE;
    }
    return keyTypes[name];
  }

  public toJson(): Compiled {
    return Cast(
      this.dialect,
      this.value,
      this.value.type.kind === "json" ? this.value.type : OPAQUE,
    );
  }

  public keyTypes(): KeyTypes | undefined {
    return KeyTypesOf(this.value.type);
  }
}
