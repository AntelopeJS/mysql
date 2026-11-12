import { Schema } from "@antelopejs/interface-database/schema";

const INSTANCE = "one";

/** The one row every value-stage case is evaluated against. */
export interface Fixture {
  _id: string;
  name: string;
  bornAt: Date;
  nums: number[];
  tags: string[];
  meta: { a: number; b: { x: number }; empty: null };
}

export const FIXTURE: Fixture = {
  _id: "row",
  name: "ada",
  bornAt: new Date("2023-01-15T13:45:30.250Z"),
  nums: [3, 1, 2],
  tags: ["b", "a", "c"],
  meta: { a: 1, b: { x: 1 }, empty: null },
};

/** A schema of its own per test file, with the fixture row inserted before and the instance dropped after. */
export function ValueStageTable(schemaId: string) {
  const schema = new Schema<{ rows: Fixture }>(schemaId, {
    rows: {
      fields: {
        name: "string",
        bornAt: "date",
        nums: "number[]",
        tags: "string[]",
        meta: "object",
      },
      indexes: {},
    },
  });
  const rows = () => schema.instance(INSTANCE).table("rows");
  return {
    async setup() {
      await schema.createInstance(INSTANCE).run();
      await rows().insert(FIXTURE).run();
    },
    async teardown() {
      await schema.destroyInstance(INSTANCE).run();
    },
    rows,
  };
}

/** The one value a query over the fixture's single row yields. */
export async function First<Value>(
  stream: PromiseLike<Value[]>,
): Promise<Value | undefined> {
  const [value] = await stream;
  return value;
}
