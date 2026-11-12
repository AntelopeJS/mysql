import type { Dialect } from "../../dialect";
import type { Conversion } from "../../dialect/external";
import { type Sql, join, sql } from "../../statement";
import { Cast, WithDefault } from "./coerce";
import { Defaulted } from "./readings";
import type { TableModel } from "./fields";
import type { ColumnDescriptor } from "./external-types";
import { ID_COLUMN, INSTANCE_COLUMN } from "./utils";
import { type Compiled, type NativeOperand, QualifiedColumn } from "./sql";
import {
  BuildDocument,
  type DocumentMember,
  KeySubject,
  MemberKeyTypes,
  type RowSource,
} from "./row-source";
import { type KeyTypes, OPAQUE, TEXT } from "./types";

/**
 * The names a row of an external relation answers with, `_id` first when it has a key.
 *
 * The one owner of that list: the select list a row-mode read renders and the document a value-mode
 * read builds have to name the same members, or a nested read addresses a column its subselect
 * never selected.
 */
export function ExternalNames(model: TableModel): string[] {
  const declared = Object.keys(model.fields);
  return model.external?.key ? [ID_COLUMN, ...declared] : declared;
}

const Unconverted: Conversion = (other) => other;

/**
 * A composite key compared as the row of its columns, which its primary key index serves, against
 * a `_id` decoded part by part, each part converted to its column's type under its own guard. A
 * malformed `_id` (not JSON, not an array, the wrong width, a part its column cannot hold) has a
 * NULL part, and a row with a NULL part matches nothing.
 */
function CompositeOperand(
  dialect: Dialect,
  key: ColumnDescriptor[],
  columns: Sql[],
): NativeOperand {
  const conversions = key.map((part) => part.conversion ?? Unconverted);
  return {
    sql: sql`ROW(${join(columns, sql`, `)})`,
    order: columns,
    bind: (other, operator) => {
      const parts = dialect.external.types.idParts(other, key.length);
      const converted = conversions.map((convert, position) =>
        convert(parts[position], operator),
      );
      return sql`ROW(${join(converted, sql`, `)})`;
    },
    numeric: false,
    type: `row(${key.map((part) => part.native).join(", ")})`,
  };
}

/**
 * Where an external row source reads its columns from.
 *
 * - `table`: the relation itself, each declared field through its descriptor's value expression.
 * - `output`: a subselect over it, whose select list already holds every value under its field name.
 */
export type ExternalReads = "table" | "output";

/**
 * Field access over a relation the adapter did not create, from the descriptors registration built.
 *
 * Every declared field is its column read as the declared kind, and `_id` is the key read as text:
 * one column's value, or the key's parts as a JSON array for a composite key. `_instance`, an
 * undeclared key and, on a keyless relation, `_id` read as absent; there is no overflow column, so
 * the document is the declared fields and `_id`, and nothing else.
 */
export class ExternalRowSource implements RowSource {
  public constructor(
    private readonly dialect: Dialect,
    private readonly alias: string,
    private readonly table: TableModel,
    private readonly reads: ExternalReads,
  ) {}

  private column(name: string): Sql {
    return QualifiedColumn(this.alias, name);
  }

  private absentText(): Compiled {
    return { sql: this.dialect.sql.scalar.cast(sql`NULL`, "text"), type: TEXT };
  }

  private key(): Compiled {
    const key = this.table.external?.key;
    if (!key) {
      return this.absentText();
    }
    if (this.reads === "output") {
      return { sql: this.column(ID_COLUMN), type: TEXT };
    }
    if (key.length === 1) {
      return this.native(key[0]);
    }
    const columns = key.map((part) => this.column(part.column));
    const parts = key.map((part, position) => part.value(columns[position]));
    return {
      sql: this.dialect.external.types.compositeId(parts),
      type: TEXT,
      native: CompositeOperand(this.dialect, key, columns),
    };
  }

  /** A column read through its descriptor, carrying the bare column for comparisons that can use it. */
  private native(descriptor: ColumnDescriptor): Compiled {
    const column = this.column(descriptor.column);
    const value: Compiled = {
      sql: descriptor.value(column),
      type: descriptor.kind,
    };
    if (!descriptor.conversion) {
      return value;
    }
    const native: NativeOperand = {
      sql: column,
      order: [column],
      bind: descriptor.conversion,
      numeric: descriptor.numeric,
      type: descriptor.native,
      present: descriptor.present?.(column),
    };
    return { ...value, native };
  }

  private declared(name: string): Compiled {
    const spec = this.table.fields[name];
    if (this.reads === "output" || !spec.native) {
      return { sql: this.column(name), type: spec.type };
    }
    return { ...this.native(spec.native), type: spec.type };
  }

  public field(name: string, def?: Compiled): Compiled {
    if (name === ID_COLUMN) {
      return Defaulted(this.dialect, this.key(), def, KeySubject(name));
    }
    if (Object.hasOwn(this.table.fields, name)) {
      return Defaulted(
        this.dialect,
        this.declared(name),
        def,
        KeySubject(name),
      );
    }
    const absent: Compiled =
      name === INSTANCE_COLUMN
        ? this.absentText()
        : { sql: sql`NULL`, type: OPAQUE };
    return WithDefault(this.dialect, absent, def);
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
    return ExternalNames(this.table).map((name) => ({
      name,
      ...this.field(name),
    }));
  }

  public toJson(): Compiled {
    return BuildDocument(this.dialect, this.members());
  }

  public keyTypes(): KeyTypes {
    return MemberKeyTypes(this.members());
  }
}
