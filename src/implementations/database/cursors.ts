import type { Sql } from "../../statement";
import { Read, type Row } from "../../connection";
import type { RowValue } from "./result";

/** A compiled read a cursor iterates: the statement, and how its rows decode. */
export interface CursorRequest {
  statement: Sql;
  decode: (rows: Row[]) => RowValue[];
}

/** The rows a cursor has still to yield, by request id. */
const open = new Map<number, Promise<RowValue[]>>();

async function Buffered(compile: () => Promise<CursorRequest>) {
  const request = await compile();
  return request.decode(await Read(request.statement));
}

/**
 * Answers the next element of the cursor `reqId` names, opening it on its first read.
 *
 * The whole result is read through the pool when the cursor opens and handed out one element per
 * read: the read is one statement, so the iteration sees one snapshot. Streaming the rows on a
 * held connection replaces this function and keeps its contract.
 */
export async function ReadCursorRow(
  reqId: number,
  compile: () => Promise<CursorRequest>,
): Promise<IteratorResult<RowValue, void>> {
  let pending = open.get(reqId);
  if (!pending) {
    pending = Buffered(compile);
    open.set(reqId, pending);
  }
  try {
    const rows = await pending;
    if (rows.length === 0) {
      open.delete(reqId);
      return { done: true, value: undefined };
    }
    return { done: false, value: rows.shift() };
  } catch (err) {
    open.delete(reqId);
    throw err;
  }
}

/** Forgets a cursor; total for an id that never opened. */
export async function CloseOneCursor(reqId: number): Promise<void> {
  open.delete(reqId);
}
