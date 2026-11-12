import assert from "node:assert";
import type { QueryStage } from "@antelopejs/interface-database/common";

import type { Bound } from "../../statement";
import type { Compiled } from "../../implementations/database/sql";
import { NewContext } from "./pipeline-fixture";

const PROJECTION_START = "SELECT ";
const PROJECTION_END = " AS `value` FROM ";

/** The expression a compiled `map` projects, without the select list around it. */
export function Projected(bound: Bound): string {
  const end = bound.sql.lastIndexOf(PROJECTION_END);
  assert(end > PROJECTION_START.length, `${bound.sql} is not a projection`);
  return bound.sql.slice(PROJECTION_START.length, end);
}

/** How often a fragment occurs in a text. */
export function Occurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

/** Anything that has recorded stages, whatever type it stands for. */
export interface Recorded {
  build(): QueryStage[];
}

/** The last stage a value records, which is the one its method added. */
export function LastStage(value: Recorded): QueryStage {
  const stage = value.build().at(-1);
  assert(stage, "the value recorded no stage");
  return stage;
}

/** A recorded expression compiled alone, with no row to address, so only its type and text remain. */
export function CompiledAlone(value: Recorded): Compiled {
  return NewContext().expression(value.build());
}
