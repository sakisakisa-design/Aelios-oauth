import { formatDateLabel } from "../utils/time";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function getTargetDigestDateLabel(timeZone: string, now = new Date()): string {
  return formatDateLabel(new Date(now.getTime() - ONE_DAY_MS), timeZone);
}

export function getDateLabelsLookback(dateLabel: string, count: number, timeZone: string): string[] {
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    labels.push(addDaysToDateLabel(dateLabel, -i, timeZone));
  }
  return labels;
}

/**
 * Accepts both `YYYY-MM-DD` and the `M/D/YYYY` a locale-formatted label can produce
 * on a runtime without ISO-shaped locale data, so a stale label is read rather than
 * throwing. Labels written since the `formatDateLabel` change are always ISO.
 */
export function parseDateLabel(dateLabel: string): { year: number; month: number; day: number } {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateLabel);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dateLabel);
  if (us) return { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) };
  throw new Error(`Invalid date label: ${dateLabel}`);
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  const hour = Number(values.get("hour")) % 24;
  const minute = Number(values.get("minute"));
  const second = Number(values.get("second"));
  const zonedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return zonedAsUtc - date.getTime();
}

function zonedWallTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}): Date {
  const wallClockUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second);
  let utc = wallClockUtc;

  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utc), input.timeZone);
    const next = wallClockUtc - offset;
    if (Math.abs(next - utc) < 1000) break;
    utc = next;
  }

  return new Date(utc);
}

export function addDaysToDateLabel(dateLabel: string, days: number, timeZone: string): string {
  const { year, month, day } = parseDateLabel(dateLabel);
  const localNoonUtc = zonedWallTimeToUtc({
    year,
    month,
    day,
    hour: 12,
    minute: 0,
    second: 0,
    timeZone
  });
  return formatDateLabel(new Date(localNoonUtc.getTime() + days * ONE_DAY_MS), timeZone);
}

export function getDateRangeForLabel(dateLabel: string, timeZone: string): { startIso: string; endIso: string } {
  const start = parseDateLabel(dateLabel);
  const end = parseDateLabel(addDaysToDateLabel(dateLabel, 1, timeZone));

  return {
    startIso: zonedWallTimeToUtc({ ...start, hour: 0, minute: 0, second: 0, timeZone }).toISOString(),
    endIso: zonedWallTimeToUtc({ ...end, hour: 0, minute: 0, second: 0, timeZone }).toISOString()
  };
}

export interface DreamCursorState {
  done: boolean;
  after: string | null;
  afterId: string | null;
}

export function parseDreamCursor(value: string | null): { done: boolean; createdAt: string | null; id: string | null } {
  if (!value) return { done: false, createdAt: null, id: null };
  const done = value.startsWith("done:");
  const raw = done ? value.slice("done:".length) : value;
  const hash = raw.indexOf("#");
  if (hash < 0) return { done, createdAt: raw || null, id: null };
  return { done, createdAt: raw.slice(0, hash) || null, id: raw.slice(hash + 1) || null };
}

export function formatDreamCursor(input: { done: boolean; createdAt: string; id?: string | null }): string {
  const body = input.id ? `${input.createdAt}#${input.id}` : input.createdAt;
  return input.done ? `done:${body}` : body;
}

export function readDailyCursor(value: string | null, startIso: string, endIso: string): DreamCursorState {
  if (!value) return { done: false, after: null, afterId: null };
  const parsed = parseDreamCursor(value);
  if (parsed.done) return { done: true, after: null, afterId: null };
  if (parsed.createdAt && parsed.createdAt >= startIso && parsed.createdAt < endIso) {
    return { done: false, after: parsed.createdAt, afterId: parsed.id };
  }
  return { done: false, after: null, afterId: null };
}

