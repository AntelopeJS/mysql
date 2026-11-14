/** A check that a value read back from JSON has the type `T`. */
export type Guard<T> = (value: unknown) => value is T;

export function IsString(value: unknown): value is string {
  return typeof value === "string";
}

export function IsNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function IsBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function IsPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that is a key of `table`: a table typed `Record<T, …>` names every member of `T`. */
export function Member<T extends string>(
  table: Readonly<Record<T, string | true>>,
): Guard<T> {
  return (value: unknown): value is T =>
    typeof value === "string" && Object.hasOwn(table, value);
}

/** An absent field, or one `guard` accepts. */
export function Optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value: unknown): value is T | undefined =>
    value === undefined || guard(value);
}

/** An array whose every element `guard` accepts. */
export function ArrayOf<T>(guard: Guard<T>): Guard<readonly T[]> {
  return (value: unknown): value is readonly T[] =>
    Array.isArray(value) && value.every((element) => guard(element));
}

/** An object whose every own value `guard` accepts. */
export function RecordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value: unknown): value is Record<string, T> =>
    IsPlainObject(value) &&
    Object.values(value).every((element) => guard(element));
}

/** An object whose every field, read as an own property, passes its guard. */
export function Fields<T extends object>(fields: {
  readonly [K in keyof T]-?: Guard<T[K]>;
}): Guard<T> {
  const entries: readonly (readonly [string, Guard<unknown>])[] =
    Object.entries(fields);
  return (value: unknown): value is T =>
    IsPlainObject(value) &&
    entries.every(([key, guard]) =>
      guard(Object.getOwnPropertyDescriptor(value, key)?.value),
    );
}
