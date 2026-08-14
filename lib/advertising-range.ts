export interface AdvertisingDay {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  units?: number;
  acos?: number | null;
}

export interface AdvertisingRangeSource {
  id: string;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  daily: AdvertisingDay[];
}

export interface AdvertisingTotals {
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  sales: number;
  units: number;
  ctr: number | null;
  cvr: number | null;
  acos: number | null;
  roas: number | null;
  cpc: number | null;
  cpa: number | null;
  aov: number | null;
}

export interface MergedAdvertisingRange {
  reporting: { start: string; end: string; days: number };
  daily: AdvertisingDay[];
  totals: AdvertisingTotals;
  coverage: {
    requestedDays: number;
    availableDays: number;
    missingDates: string[];
    overlappingDates: number;
    sourceSnapshots: { id: string; periodStart: string; periodEnd: string; createdAt: string }[];
  };
}

const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (numerator: number, denominator: number) => denominator ? round(numerator / denominator) : null;

function dateSequence(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function validateAdvertisingRange(start: string, end: string): void {
  if (!isoPattern.test(start) || !isoPattern.test(end)) throw new Error("Choose valid From and To dates.");
  if (start > end) throw new Error("The From date must be before or equal to the To date.");
  const days = dateSequence(start, end).length;
  if (days > 366) throw new Error("Flexible advertising ranges are limited to 366 days.");
}

export function advertisingTotals(days: AdvertisingDay[]): AdvertisingTotals {
  const totals = days.reduce((sum, day) => ({
    impressions: sum.impressions + (Number.isFinite(day.impressions) ? day.impressions : 0),
    clicks: sum.clicks + (Number.isFinite(day.clicks) ? day.clicks : 0),
    spend: sum.spend + (Number.isFinite(day.spend) ? day.spend : 0),
    purchases: sum.purchases + (Number.isFinite(day.purchases) ? day.purchases : 0),
    sales: sum.sales + (Number.isFinite(day.sales) ? day.sales : 0),
    units: sum.units + (Number.isFinite(day.units ?? 0) ? day.units ?? 0 : 0),
  }), { impressions: 0, clicks: 0, spend: 0, purchases: 0, sales: 0, units: 0 });
  const clean = {
    impressions: round(totals.impressions, 0),
    clicks: round(totals.clicks, 0),
    spend: round(totals.spend, 2),
    purchases: round(totals.purchases, 0),
    sales: round(totals.sales, 2),
    units: round(totals.units, 0),
  };
  return {
    ...clean,
    ctr: ratio(clean.clicks, clean.impressions),
    cvr: ratio(clean.purchases, clean.clicks),
    acos: ratio(clean.spend, clean.sales),
    roas: ratio(clean.sales, clean.spend),
    cpc: ratio(clean.spend, clean.clicks),
    cpa: ratio(clean.spend, clean.purchases),
    aov: ratio(clean.sales, clean.purchases),
  };
}

export function mergeAdvertisingRange(sources: AdvertisingRangeSource[], start: string, end: string): MergedAdvertisingRange {
  validateAdvertisingRange(start, end);
  const requestedDates = dateSequence(start, end);
  const requestedSet = new Set(requestedDates);
  const selected = [...sources]
    .filter((source) => source.periodStart <= end && source.periodEnd >= start)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const byDate = new Map<string, AdvertisingDay>();
  let overlappingDates = 0;
  for (const source of selected) {
    for (const day of source.daily) {
      if (!requestedSet.has(day.date)) continue;
      if (byDate.has(day.date)) {
        overlappingDates += 1;
        continue;
      }
      byDate.set(day.date, { ...day, acos: day.sales ? round(day.spend / day.sales) : null });
    }
  }
  const daily = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  const missingDates = requestedDates.filter((date) => !byDate.has(date));
  return {
    reporting: { start, end, days: requestedDates.length },
    daily,
    totals: advertisingTotals(daily),
    coverage: {
      requestedDays: requestedDates.length,
      availableDays: daily.length,
      missingDates,
      overlappingDates,
      sourceSnapshots: selected.map(({ id, periodStart, periodEnd, createdAt }) => ({ id, periodStart, periodEnd, createdAt })),
    },
  };
}
