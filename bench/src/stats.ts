/** The value at quantile `q` of `values`, by nearest rank. */
export function Quantile(values: readonly number[], q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

export function Median(values: readonly number[]): number {
  return Quantile(values, 0.5);
}

export function P95(values: readonly number[]): number {
  return Quantile(values, 0.95);
}
