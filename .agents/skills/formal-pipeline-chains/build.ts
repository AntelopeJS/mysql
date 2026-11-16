import type { QueryValue } from "@antelopejs/interface-database/common";
import type { Stream } from "@antelopejs/interface-database/stream";
import type { ValueProxy } from "@antelopejs/interface-database/valueproxy";

import type { Compare, Doc, Expression, Json, Stage, Terminal } from "./model";
import { IsString } from "./guards";
import type { Handles } from "./seed";

type Row = ValueProxy<Doc>;

type Outer = ValueProxy<Doc> | undefined;

/** The comparison of `operand` with the field of `row`, written as the module's operators are. */
function Condition(
  row: Row,
  field: string,
  compare: Compare,
  operand: number | string | ValueProxy<number>,
): ValueProxy<boolean> {
  const left = row.key(field);
  if (compare === "eq") {
    return left.eq(operand);
  }
  if (compare === "ne") {
    return left.ne(operand);
  }
  const above = compare === "gt";
  if (IsString(operand)) {
    const text = left.cast<string>();
    return above ? text.gt(operand) : text.lt(operand);
  }
  const number = left.cast<number>();
  return above ? number.gt(operand) : number.lt(operand);
}

function Taken(outer: Outer): ValueProxy<number> {
  if (!outer) {
    throw new Error(
      "a stage that reads the outer owner runs outside an owner's query",
    );
  }
  return outer.key("take").cast<number>();
}

function Numeric(row: Row, field: string): ValueProxy<number> {
  return row.key(field).cast<number>();
}

function Computed(
  expression: Expression,
  row: Row,
  outer: Outer,
  handles: Handles,
): QueryValue {
  switch (expression.kind) {
    case "number":
    case "text":
      return expression.value;
    case "add":
      return Numeric(row, expression.field).add(expression.by);
    case "mul":
      return Numeric(row, expression.field).mul(expression.by);
    case "owners":
      return handles
        .owners()
        .filter((owner) => owner.key("take").eq(Numeric(row, expression.field)))
        .count();
    case "label":
      return handles
        .owners()
        .filter((owner) =>
          owner.key("take").cast<number>().ge(Numeric(row, expression.field)),
        )
        .orderBy("_id")
        .nth(0)
        .key("label");
    case "outer":
      return Numeric(row, expression.field).add(Taken(outer));
    case "keys":
      return row.merge({ w: 1 }).keys().count();
  }
}

function Grouped(
  stream: Stream<Doc>,
  stage: Extract<Stage, { kind: "group" }>,
  outer: Outer,
): Stream<Doc> {
  return stream
    .group(stage.field, (members, key) => {
      const sum = stage.sum;
      if (!sum) {
        return { k: key, c: members.count() };
      }
      const total = sum.withOuter
        ? members.map((row) => Numeric(row, sum.field).add(Taken(outer))).sum()
        : members.sum(sum.field);
      return { k: key, c: members.count(), t: total };
    })
    .cast<Doc>();
}

function Applied(
  stream: Stream<Doc>,
  stage: Stage,
  prefix: readonly Stage[],
  outer: Outer,
  handles: Handles,
): Stream<Doc> {
  switch (stage.kind) {
    case "filter":
      return stream.filter((row) =>
        Condition(row, stage.field, stage.compare, stage.value),
      );
    case "filterOuter":
      return stream.filter((row) =>
        Condition(row, stage.field, stage.compare, Taken(outer)),
      );
    case "merge":
      return stream
        .map((row) =>
          row.merge({
            [stage.name]: Computed(stage.expression, row, outer, handles),
          }),
        )
        .cast<Doc>();
    case "orderBy":
      return stream.orderBy(stage.field, stage.direction);
    case "slice":
      return stage.count === undefined
        ? stream.slice(stage.offset)
        : stream.slice(stage.offset, stage.count);
    case "sliceOuter":
      return stream.slice(0, Taken(outer));
    case "pluck":
      return stream.pluck(...stage.fields).cast<Doc>();
    case "without":
      return stream.without(...stage.fields).cast<Doc>();
    case "group":
      return Grouped(stream, stage, outer);
    case "lookupList":
      return stream
        .lookup(
          handles.owners().orderBy("_id", "desc").cast<Doc>(),
          "refs",
          "_id",
        )
        .cast<Doc>();
    case "lookup":
      return stream
        .lookup(handles.owners().cast<Doc>(), "ownerId", "_id")
        .cast<Doc>();
    case "union":
      return stream.union(
        Applying(prefix, handles.extras().cast<Doc>(), outer, handles),
      );
  }
}

/** The stream of `stages` applied in order to `source`; `outer` is the owner a nested chain reads. */
export function Applying(
  stages: readonly Stage[],
  source: Stream<Doc>,
  outer: Outer,
  handles: Handles,
): Stream<Doc> {
  return stages.reduce(
    (stream, stage, index) =>
      Applied(stream, stage, stages.slice(0, index), outer, handles),
    source,
  );
}

function Finished(stream: Stream<Doc>, terminal: Terminal, outer: Outer) {
  switch (terminal.kind) {
    case "rows":
      return stream;
    case "count":
      return stream.count();
    case "nth":
      return stream.nth(terminal.at);
    case "nthOuter":
      return stream.nth(Taken(outer));
  }
}

/** The stream of a chain over the items table, as a feed or a read runs it. */
export function Streamed(
  stages: readonly Stage[],
  handles: Handles,
): Stream<Doc> {
  return Applying(stages, handles.items().cast<Doc>(), undefined, handles);
}

/** Runs the chain on the server and answers what it read. */
export async function Run(
  handles: Handles,
  stages: readonly Stage[],
  terminal: Terminal,
  nested: boolean,
): Promise<Json> {
  if (!nested) {
    return await Finished(Streamed(stages, handles), terminal, undefined).run();
  }
  return await handles
    .owners()
    .orderBy("_id")
    .map((owner) => {
      const outer = owner.cast<Doc>();
      const rows = Applying(
        stages,
        handles.items().cast<Doc>(),
        outer,
        handles,
      );
      return { id: owner.key("_id"), rows: Finished(rows, terminal, outer) };
    })
    .run();
}
