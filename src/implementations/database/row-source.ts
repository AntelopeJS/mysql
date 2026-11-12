import assert from "node:assert";

import type { Dialect } from "../../dialect";
import { type Sql, sql } from "../../statement";
import { Cast, WithDefault } from "./coerce";
import { Defaulted } from "./readings";
import { DocumentKeys, type TableModel } from "./fields";
import type { KeyColumn, KeyPart, ValueKey } from "./paths";
import { KeyAt, TypedKeyReference } from "./json";
import { ValueReferenceOf } from "./value-key";
import {
  DEFAULT_INSTANCE_ID,
  EXTRA_COLUMN,
  ID_COLUMN,
  INSTANCE_COLUMN,
} from "./utils";
import {
  type Compiled,
  QualifiedColumn,
  type ValuePath,
  type ValueReference,
} from "./sql";
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

export function MemberKeyTypes(members: DocumentMember[]): KeyTypes {
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

const PATH_SEPARATOR = ".";

/**
 * Reads a field by the name an index, a sort or a lookup takes: a member by its exact name where the
 * row declares one, and otherwise a dotted name as a path below its first segment, as an index field
 * is read. So `title.fr` names the key column an index over it holds, and sorts by the nested value.
 */
export function NamedField(
  dialect: Dialect,
  source: RowSource,
  name: string,
): Compiled {
  const [head, ...rest] = name.split(PATH_SEPARATOR);
  const declared = source.keyTypes();
  if (rest.length === 0 || (declared && Object.hasOwn(declared, name))) {
    return source.field(name);
  }
  return rest.reduce(
    (value, segment) => new JsonRowSource(dialect, value).field(segment),
    source.field(head),
  );
}

/** Names a key in the message {@link Defaulted} raises for a default the column cannot hold. */
export function KeySubject(name: string): string {
  return `The default for key '${name}'`;
}

/** How a row source reaches one physical column, as the type that column holds. */
export type ColumnAddress = (column: string, type: SqlType) => Compiled;

/** A column of a real table row, which already is the type it was declared as. */
export function AliasedColumns(alias: string): ColumnAddress {
  return (column, type) => ({ sql: QualifiedColumn(alias, column), type });
}

/**
 * A column of a **logged** row: a physical row the change log's triggers stored as one JSON image.
 *
 * Each member is read back with the compiler's own reading of the JSON value the trigger wrote, so
 * it is the type the column holds. A JSON-backed member is unboxed: the image holds it as a
 * one-element array, which is what keeps a column holding SQL NULL apart from one holding a JSON
 * null. A key the image lacks, which a row logged before its column was added does, is SQL NULL.
 */
export function LoggedColumns(dialect: Dialect, row: Sql): ColumnAddress {
  return (column, type) => {
    const member = dialect.sql.json.member(row, column);
    const sql = IsJsonBacked(type)
      ? dialect.capture.unbox(member)
      : dialect.sql.json.as(member, type.kind);
    return { sql, type };
  };
}

/**
 * The key columns of a table as one row of it addresses them, the value keys among them, and the
 * columns its multi-valued indexes cover.
 */
export interface RowKeys {
  readonly alias: string;
  readonly columns: readonly KeyColumn[];
  readonly values: readonly ValueKey[];
  readonly elements: readonly string[];
}

/**
 * One part of an index key, read off a row: the value it compares, the terms it orders by, and for
 * a value of no declared type the value key a selection by it is narrowed through.
 */
export interface IndexedValue {
  readonly value: Compiled;
  readonly order: readonly Sql[];
  readonly ranked?: ValueReference;
}

type TypedRead = Extract<
  KeyColumn["read"],
  "text" | "string" | "double" | "bool"
>;

/** The type each typed key column's read has. */
const KEY_READ_TYPES: Record<TypedRead, SqlType> = {
  text: TEXT,
  string: TEXT,
  double: FLOAT,
  bool: BOOL,
};

function IsTypedRead(read: KeyColumn["read"]): read is TypedRead {
  return Object.hasOwn(KEY_READ_TYPES, read);
}

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
    const overflow = this.overflow();
    const member: Compiled = {
      sql: this.dialect.sql.json.member(overflow, name),
      type: OPAQUE,
      path: this.path(EXTRA_COLUMN, overflow, [name]),
    };
    return WithDefault(this.dialect, member, def);
  }

  private keyRead(read: TypedRead, value: Sql): Compiled {
    return {
      sql: this.dialect.sql.json.key(read, value),
      type: KEY_READ_TYPES[read],
    };
  }

  /** A declared column, with the key column over it or the path a read below it starts from. */
  private declared(column: string, type: SqlType): Compiled {
    const value = this.address(column, type);
    if (IsJsonBacked(type)) {
      return { ...value, path: this.path(column, value.sql, []) };
    }
    if (type.kind !== "text" || !this.keys) {
      return value;
    }
    const key = KeyAt(this.keys.alias, this.keys.columns, column, [], "text");
    return key ? { ...value, key } : value;
  }

  /** A read of `path` below the physical column `source`, which `document` reads. */
  private path(source: string, document: Sql, path: string[]): ValuePath {
    const keys = this.keys;
    const column = keys && {
      alias: keys.alias,
      keys: keys.columns,
      values: keys.values,
      elements: keys.elements,
      source,
    };
    return { document, path, column };
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
   * One part of a declared index read off this row: a stored column as itself, a typed key's part as
   * the value it reads beside the key column a comparison can be served by and the rows are ordered
   * by, and a value key's part as the JSON value itself, ordered by the value key's columns. Where
   * the row is not the table itself, the value is read in full and ordered by.
   */
  public indexed(part: Exclude<KeyPart, { kind: "instance" }>): IndexedValue {
    switch (part.kind) {
      case "stored":
      case "elements": {
        const value = this.field(part.field);
        return { value, order: [value.sql] };
      }
      case "value":
        return this.valued(part.field, part.key);
      case "key":
        return this.keyed(part.key);
    }
  }

  private keyed(key: KeyColumn): IndexedValue {
    assert(IsTypedRead(key.read), "A key part keys on a typed read");
    const read = this.dialect.sql.json.member(
      this.address(key.source, OPAQUE).sql,
      ...key.path,
    );
    const value = this.keyRead(key.read, read);
    if (!this.keys) {
      return { value, order: [value.sql] };
    }
    const reference = TypedKeyReference(this.keys.alias, key);
    return { value: { ...value, key: reference }, order: [reference.column] };
  }

  /** The value as the same name reads it without the index, so the index never changes what it reads. */
  private valued(field: string, key: ValueKey): IndexedValue {
    const value = NamedField(this.dialect, this, field);
    if (!this.keys) {
      return { value, order: [value.sql] };
    }
    const ranked = ValueReferenceOf(this.keys.alias, key);
    return {
      value,
      order: [ranked.text, ranked.number],
      ranked,
    };
  }
}

/** A row that is one JSON value, as a projection or a nested document yields it. */
export class JsonRowSource implements RowSource {
  public constructor(
    private readonly dialect: Dialect,
    private readonly value: Compiled,
  ) {}

  /** A member, read from the document the value itself was read from where it still is a read. */
  public field(name: string, def?: Compiled): Compiled {
    const parent = this.toJson();
    const path: ValuePath = parent.path
      ? { ...parent.path, path: [...parent.path.path, name] }
      : { document: parent.sql, path: [name] };
    const raw: Compiled = {
      sql: this.dialect.sql.json.member(path.document, ...path.path),
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
