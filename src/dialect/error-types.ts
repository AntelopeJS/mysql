/**
 * What a driver error means, in the terms the write paths act on.
 *
 * - `duplicate`: a unique key refused the row; `key` is the index name the server reported.
 * - `tooLong`: a value is wider than its column; `column` names the column.
 * - `deadlock`: the server rolled the transaction back to break a deadlock, which let the other
 *   transaction through, so running it again soon succeeds.
 * - `lockWait`: the transaction waited the server's whole lock wait timeout for a row.
 * - `binlogFormat`: the server's binary log takes statements (`binlog_format = STATEMENT`), which
 *   InnoDB cannot log a write at READ COMMITTED in; the statement did not apply.
 * - `server`: any other error the server answered; the statement did not apply.
 * - `connection`: the connection failed, so whether the statement applied is unknown.
 */
export type Failure =
  | { readonly kind: "duplicate"; readonly key: string }
  | { readonly kind: "tooLong"; readonly column: string }
  | {
      readonly kind:
        | "deadlock"
        | "lockWait"
        | "binlogFormat"
        | "server"
        | "connection";
    };

export interface ErrorSyntax {
  classify(error: Error): Failure;
  /**
   * Whether the server answered that it could not take up a statement at all, rather than that it
   * would not take it from the account: a cap on prepared statements or on the account's use,
   * memory, a lock it could not take, or an interrupted statement.
   */
  unanswered(error: Error): boolean;
}
