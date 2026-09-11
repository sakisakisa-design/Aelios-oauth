export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * YYYY-MM-DD in a time zone, assembled from date parts.
 *
 * `Intl.DateTimeFormat(locale).format()` only renders an ISO-shaped string when the
 * runtime ships full ICU data for that locale. Node builds with small-icu (and any
 * runtime missing `en-CA`) fall back to `en`, which renders `M/D/YYYY`. Every date
 * *label* in this repo is compared and parsed as `YYYY-MM-DD`, so labels are built
 * from `formatToParts` instead of trusting the locale's rendering.
 */
export function formatDateLabel(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}
