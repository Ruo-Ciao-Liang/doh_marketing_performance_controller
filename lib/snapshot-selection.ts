export function snapshotRequestPath(snapshotId?: string, marketplaceId = "amazon_de"): string {
  const normalizedId = snapshotId?.trim();
  const base = normalizedId ? `/api/snapshots?id=${encodeURIComponent(normalizedId)}` : "/api/snapshots";
  if (marketplaceId === "amazon_de") return base;
  return `${base}${normalizedId ? "&" : "?"}marketplaceId=${encodeURIComponent(marketplaceId)}`;
}

export function advertisingRangeRequestPath(range: ReportingDateRange, marketplaceId = "amazon_de"): string {
  const params = new URLSearchParams({ advertisingStart: range.start, advertisingEnd: range.end });
  if (marketplaceId !== "amazon_de") params.set("marketplaceId", marketplaceId);
  return `/api/snapshots?${params.toString()}`;
}

export type DateRangePreset =
  | "today"
  | "yesterday"
  | "last-7"
  | "last-full-7"
  | "last-14"
  | "current-week"
  | "current-month"
  | "last-30"
  | "last-full-30"
  | "previous-month"
  | "last-90"
  | "last-180"
  | "last-365";

export interface ReportingDateRange {
  start: string;
  end: string;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(value: string, days: number): string {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function startOfMonth(value: string): string {
  const date = utcDate(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function startOfWeek(value: string): string {
  const date = utcDate(value);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -mondayOffset);
}

export function presetDateRange(preset: DateRangePreset, latestAvailableDate: string): ReportingDateRange {
  if (preset === "today") return { start: latestAvailableDate, end: latestAvailableDate };
  if (preset === "yesterday") {
    const day = addDays(latestAvailableDate, -1);
    return { start: day, end: day };
  }
  if (preset === "last-full-7") {
    const end = addDays(startOfWeek(latestAvailableDate), -1);
    return { start: addDays(end, -6), end };
  }
  if (preset === "current-week") return { start: startOfWeek(latestAvailableDate), end: latestAvailableDate };
  if (preset === "current-month") return { start: startOfMonth(latestAvailableDate), end: latestAvailableDate };
  if (preset === "last-full-30") {
    const end = addDays(latestAvailableDate, -1);
    return { start: addDays(end, -29), end };
  }
  if (preset === "previous-month") {
    const end = addDays(startOfMonth(latestAvailableDate), -1);
    return { start: startOfMonth(end), end };
  }
  const days = Number(preset.replace("last-", ""));
  return { start: addDays(latestAvailableDate, -(days - 1)), end: latestAvailableDate };
}

export function matchingSnapshot<T extends { periodStart: string; periodEnd: string }>(
  history: T[],
  range: ReportingDateRange,
): T | null {
  return history.find((snapshot) => snapshot.periodStart === range.start && snapshot.periodEnd === range.end) ?? null;
}
