import { Bind } from "../../statement";
import { DIALECTS, type ObservedColumn } from "../../dialect";
import type { TablePlan } from "../../implementations/database/plan";

/** The type the catalog reports for each column a plan stores. */
function CatalogType(column: TablePlan["columns"][number]): string {
  switch (column.role) {
    case "id":
    case "instance":
      return `varchar(${column.chars})`;
    case "extra":
      return "json";
    case "declared":
      return Bind(DIALECTS.mysql.sql.physical(column.type)).sql.toLowerCase();
  }
}

/** The columns a plan stores, as the catalog reports them once its table converged. */
export function CatalogColumns(plan: TablePlan): ObservedColumn[] {
  return plan.columns.map((column) => ({
    name: column.name,
    type: CatalogType(column),
    generated: false,
    comment: "",
  }));
}
