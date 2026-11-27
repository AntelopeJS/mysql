import type { StagedObject } from "@antelopejs/interface-database/common";

/**
 * Whether a value is a staged object of any copy of the interface package: an object that records
 * stages and answers `build()`, which a record literal, a date or a list never does.
 */
export function IsStagedObject(value: unknown): value is StagedObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "build" in value &&
    typeof value.build === "function"
  );
}
