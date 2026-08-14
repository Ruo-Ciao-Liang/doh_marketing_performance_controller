export interface ComparablePeriod {
  id: string;
  periodEnd: string;
  periodDays: number;
}

const daysBetween = (left: string, right: Date) =>
  Math.abs(new Date(`${left}T12:00:00Z`).getTime() - right.getTime()) / 86_400_000;

export function comparisonTargetDate(current: ComparablePeriod, period: "mom" | "yoy"): Date {
  const target = new Date(`${current.periodEnd}T12:00:00Z`);
  if (period === "mom") target.setUTCMonth(target.getUTCMonth() - 1);
  else target.setUTCFullYear(target.getUTCFullYear() - 1);
  return target;
}

export function comparableSnapshot<T extends ComparablePeriod>(
  history: T[],
  current: T,
  period: "mom" | "yoy",
): T | null {
  const target = comparisonTargetDate(current, period);
  const toleranceDays = period === "mom" ? 18 : 35;
  return history
    .filter((item) => item.id !== current.id && Math.abs(item.periodDays - current.periodDays) <= 3)
    .map((item) => ({ item, distance: daysBetween(item.periodEnd, target) }))
    .filter((candidate) => candidate.distance <= toleranceDays)
    .sort((left, right) => left.distance - right.distance)[0]?.item ?? null;
}

export function percentageChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  return current == null || previous == null || previous === 0 ? null : (current - previous) / Math.abs(previous);
}
