/**
 * What a driver error means, in the terms the write paths act on.
 *
 * - `duplicate`: a unique key refused the row; `key` is the index name the server reported.
 * - `tooLong`: a value is wider than its column; `column` names the column.
 * - `deadlock`: the server rolled the transaction back to break a deadlock, which let the other
 *   transaction through, so running it again soon succeeds.
 * - `lockWait`: the transaction waited the server's whole lock wait timeout for a row.
 * - `server`: any other error the server answered; the statement did not apply.
 * - `connection`: the connection failed, so whether the statement applied is unknown.
 */
export type Failure =
  | { readonly kind: "duplicate"; readonly key: string }
  | { readonly kind: "tooLong"; readonly column: string }
  | {
      readonly kind: "deadlock" | "lockWait" | "server" | "connection";
    };

export interface ErrorSyntax {
  classify(error: Error): Failure;
}
