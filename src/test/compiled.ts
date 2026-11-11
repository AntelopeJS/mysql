import type { StagedObject } from "@antelopejs/interface-database/common";

import { GetDialect } from "../connection";
import type { Sql } from "../statement";
import { DecodingContext } from "../implementations/database/context";
import { CompileExpression } from "../implementations/database/expression";
import { CompileSubquery } from "../implementations/database/subquery";
import { CompileRelation } from "../implementations/database/pipeline";
import { Render } from "../implementations/database/render";

/** A statement compiled as `RunQuery` compiles a read, against the live registry. */
export function Compiled(query: StagedObject): Sql {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    GetDialect(),
  );
  return Render(CompileRelation(query.build(), context));
}
