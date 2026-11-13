import type { EngineId } from "./engine";
import { INDEXES, PATHS } from "./dataset";
import type { CaseRecord } from "./record";

/** The call a case makes, as the tables name it. */
export function Call(query: CaseRecord): string {
  const path = PATHS[query.field];
  const read =
    query.form === "decorators"
      ? `unlockrequest(…, "title", fr)`
      : query.field === "title"
        ? `key("title").key("fr")`
        : `key("_internal")…key("fr")`;
  if (query.kind === "filter") {
    return `filter(${read}.eq(v))`;
  }
  if (query.kind === "orderBy") {
    return query.form === "path"
      ? `orderBy("${query.indexed ? INDEXES[query.field] : path}")`
      : `map({ sortKey: ${read} }).orderBy("sortKey")`;
  }
  return query.form === "path"
    ? `lookup(books, …, "${path}")`
    : `joinInner(books, ${read}.eq(review.key))`;
}

/** Milliseconds, to three significant figures. */
export function Ms(value: number): string {
  if (!Number.isFinite(value)) {
    return "–";
  }
  return value < 10
    ? value.toFixed(2)
    : value < 100
      ? value.toFixed(1)
      : value.toFixed(0);
}

/** A ratio, to two decimals below 10. */
export function Ratio(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(value < 10 ? 2 : 0)}×` : "–";
}

/** How the tables title each server. */
export const ENGINE_TITLES: Record<EngineId, string> = {
  "postgres-18": "pg 18",
  "mysql-8.4": "8.4",
  "mysql-9.7": "9.7",
  "mariadb-11.8": "MariaDB 11.8",
  "mariadb-12.3": "MariaDB 12.3",
};
