import { expect, test } from "bun:test";
import { barRows } from "../../web/src/lib/chart-rows.ts";

const keys = [{ key: "ok", label: "Ok" }, { key: "error", label: "Failed" }];
const minute = (t: number) => String(Math.floor(t / 60_000));

test("two points in one bucket are one bar, not a crash", () => {
  const rows = barRows([{ t: 120_000, ok: 2, error: 1 }, { t: 120_000, ok: 3 }, { t: 180_000, ok: 1 }], keys, minute);
  const at = (x: string, series: string) => rows.filter((row) => row.x === x && row.series === series);
  expect(at("2", "Ok")).toEqual([{ x: "2", series: "Ok", value: 5 }]);
  expect(at("2", "Failed")).toEqual([{ x: "2", series: "Failed", value: 1 }]);
  expect(at("3", "Ok")).toEqual([{ x: "3", series: "Ok", value: 1 }]);
  expect(new Set(rows.map((row) => `${row.x}/${row.series}`)).size).toBe(rows.length);
});

test("buckets under a minute ask for seconds in their label, wherever they fall", () => {
  const seen: boolean[] = [];
  barRows([{ t: 0, ok: 1 }, { t: 300_000, ok: 1 }, { t: 310_000, ok: 1 }], keys, (t, seconds) => {
    seen.push(seconds);
    return String(t);
  });
  expect(seen.every(Boolean)).toBe(true);
});

test("a key a point does not have adds nothing", () => {
  expect(barRows([{ t: 0, ok: 1 }], keys, minute)).toEqual([{ x: "0", series: "Ok", value: 1 }]);
});
