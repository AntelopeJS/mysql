import type { CatalogColumn } from "../../dialect/external";

/** A catalog column of the given type, NOT NULL and with nothing else set, as a spec states it. */
export function Column(
  name: string,
  native: string,
  extra: Partial<CatalogColumn> = {},
): CatalogColumn {
  const dataType = native.replace(/[ (].*$/, "");
  return {
    name,
    native,
    dataType,
    notNull: true,
    hasDefault: false,
    defaultExpression: null,
    generated: false,
    autoIncrement: false,
    comment: null,
    enumLabels: null,
    ...extra,
  };
}
