/** Whether a value is a string. */
export function IsString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether a value is a number. */
export function IsNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Whether a value is an object other than `null` that is not an array. */
export function IsDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
