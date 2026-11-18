type Point = Record<string, unknown> & { t: number };
type Key = { key: string; label: string };

/**
 * The rows of a stacked bar chart. A stack refuses two values at one position and throws, which would take the
 * whole screen down, and live data can land twice in one bucket or label. Those are one bar, so they add up.
 */
export function barRows(data: Point[], keys: Key[], label: (t: number, seconds: boolean) => string) {
  const seconds = data.some((point, i) => i > 0 && Math.abs(point.t - data[i - 1]!.t) < 60_000);
  const rows = new Map<string, { x: string; series: string; value: number }>();
  for (const point of data) {
    const x = label(point.t, seconds);
    for (const key of keys) {
      if (point[key.key] === undefined) continue;
      const id = `${x}\u0000${key.label}`;
      const row = rows.get(id) ?? { x, series: key.label, value: 0 };
      row.value += Number(point[key.key]) || 0;
      rows.set(id, row);
    }
  }
  return [...rows.values()];
}
