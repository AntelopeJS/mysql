/**
 * What a driver error means, in the terms the write paths act on.
 *
 * - `duplicate`: a unique key refused the row; `key` is the index name the server reported.
 * - `tooLong`: a value is wider than its column; `column` names the column.
 * - `retry`: a deadlock or a lock wait the transaction can be run again after.
 * - `server`: any other error the server answered; the statement did not apply.
 * - `connection`: the connection failed, so whether the statement applied is unknown.
 */
export type Failure =
  | { readonly kind: "duplicate"; readonly key: string }
  | { readonly kind: "tooLong"; readonly column: string }
  | { readonly kind: "retry" | "server" | "connection" };

export interface ErrorSyntax {
  classify(error: Error): Failure;
}
