// Small statistics helpers. Every metric is reported as median ± spread over
// three runs, and the spread is printed as min..max so a noisy box is visible in
// the number instead of hidden behind a mean.

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile: no interpolation, so it is a real sample. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summary(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return { n: 0, median: NaN, min: NaN, max: NaN, spread: NaN };
  const med = median(clean);
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  return {
    n: clean.length,
    median: med,
    min,
    max,
    spread: max - min,
    // Relative spread: the honest "how stable is this number" figure.
    spreadPct: med === 0 ? 0 : ((max - min) / med) * 100,
    values: clean,
  };
}

export function fmt(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

/** "12.3 ms ± 1.1 (11.9..13.4)" */
export function fmtSummary(sum, unit, digits = 1) {
  if (!sum || sum.n === 0) return "—";
  return `${fmt(sum.median, digits)} ${unit} ± ${fmt(sum.spread, digits)} (${fmt(sum.min, digits)}..${fmt(sum.max, digits)})`;
}
