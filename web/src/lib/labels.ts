export const PRIORITY = { high: ["High", "err"], medium: ["Medium", "warn"], low: ["Low", "t3"] } as const;
export const alertValue = (a: { value: number | null; rule: { unit?: string } }) => (a.value === null ? "" : `${a.value >= 100 ? Math.round(a.value) : Math.round(a.value * 100) / 100}${a.rule.unit ? ` ${a.rule.unit}` : ""}`);
