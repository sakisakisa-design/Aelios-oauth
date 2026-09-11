import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatDateLabel } from '../src/utils/time';
import {
  addDaysToDateLabel,
  getDateRangeForLabel,
  getYesterdayDateLabel,
  parseDateLabel
} from '../src/memory/dreamDates';
import { getMondayOfIsoWeek, getSundayOfIsoWeek } from '../src/memory/weeklyRollup';

/**
 * The date helpers only broke on a runtime without ISO-shaped locale data, so a test
 * that runs on the CI runner (full ICU) would have stayed green through the bug. These
 * assert the shape directly instead of trusting the runtime's locale data: whatever the
 * platform renders, the label is YYYY-MM-DD and parses back.
 */

const ZONES = ['Asia/Singapore', 'UTC', 'America/New_York', 'Pacific/Auckland', 'Europe/Berlin'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

test('formatDateLabel always renders YYYY-MM-DD, in every zone', () => {
  const moments = [
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2026, 2, 15, 12, 30, 0),
    Date.UTC(2026, 8, 11, 4, 0, 0),
    Date.UTC(2026, 10, 1, 23, 59, 59),
    Date.UTC(2026, 11, 31, 16, 0, 0)
  ];
  for (const zone of ZONES) {
    for (const moment of moments) {
      const label = formatDateLabel(new Date(moment), zone);
      assert.match(label, ISO, `${zone} @ ${new Date(moment).toISOString()} gave ${label}`);
    }
  }
});

test('formatDateLabel uses the zone calendar date, not UTC', () => {
  // 2026-09-11T00:30 Shanghai is still 2026-09-10 in UTC.
  const justAfterMidnight = new Date(Date.UTC(2026, 8, 10, 16, 30, 0));
  assert.equal(formatDateLabel(justAfterMidnight, 'Asia/Shanghai'), '2026-09-11');
  assert.equal(formatDateLabel(justAfterMidnight, 'UTC'), '2026-09-10');
  // and the opposite side of the date line
  const lateUtc = new Date(Date.UTC(2026, 8, 11, 23, 30, 0));
  assert.equal(formatDateLabel(lateUtc, 'UTC'), '2026-09-11');
  assert.equal(formatDateLabel(lateUtc, 'Pacific/Auckland'), '2026-09-12');
});

test('parseDateLabel reads the ISO shape and the M/D/YYYY a small-icu runtime wrote', () => {
  assert.deepEqual(parseDateLabel('2026-09-11'), { year: 2026, month: 9, day: 11 });
  assert.deepEqual(parseDateLabel('2026-9-1'), { year: 2026, month: 9, day: 1 });
  assert.deepEqual(parseDateLabel('09/11/2026'), { year: 2026, month: 9, day: 11 });
  assert.throws(() => parseDateLabel('garbage'), /Invalid date label/);
  assert.throws(() => parseDateLabel(''), /Invalid date label/);
});

test('addDaysToDateLabel walks the calendar under DST', () => {
  // US spring-forward is 2026-03-08; a fixed 24h step is what this must not be.
  assert.equal(addDaysToDateLabel('2026-03-09', -1, 'America/New_York'), '2026-03-08');
  assert.equal(addDaysToDateLabel('2026-03-08', -1, 'America/New_York'), '2026-03-07');
  assert.equal(addDaysToDateLabel('2026-11-02', -1, 'America/New_York'), '2026-11-01');
  // month and year boundaries
  assert.equal(addDaysToDateLabel('2026-03-01', -1, 'Asia/Singapore'), '2026-02-28');
  assert.equal(addDaysToDateLabel('2026-01-01', -1, 'Asia/Singapore'), '2025-12-31');
  assert.equal(addDaysToDateLabel('2024-03-01', -1, 'UTC'), '2024-02-29');
});

test('getYesterdayDateLabel is calendar yesterday, not now minus 24h', () => {
  // 00:30 the day after a spring-forward: subtracting 24h would answer 03-08, not 03-07.
  const afterSpringForward = new Date('2026-03-08T05:30:00Z'); // 00:30 EST
  assert.equal(formatDateLabel(afterSpringForward, 'America/New_York'), '2026-03-08');
  assert.equal(getYesterdayDateLabel('America/New_York', afterSpringForward), '2026-03-07');

  const localMidnight = new Date(Date.UTC(2026, 8, 10, 16, 30, 0)); // 2026-09-11 00:30 +08
  assert.equal(getYesterdayDateLabel('Asia/Shanghai', localMidnight), '2026-09-10');
});

test('DateRangeForLabel covers exactly the labelled local day', () => {
  const { startIso, endIso } = getDateRangeForLabel('2026-09-11', 'Asia/Singapore');
  assert.equal(startIso, '2026-09-10T16:00:00.000Z');
  assert.equal(endIso, '2026-09-11T16:00:00.000Z');
  assert.equal(Date.parse(endIso) - Date.parse(startIso), 24 * 60 * 60 * 1000);
});

test('ISO week boundaries land on Monday and Sunday', () => {
  const zones = ['Asia/Singapore', 'UTC', 'America/New_York'];
  const cases: Array<[string, string]> = [
    ['2026-09-14', '2026-09-14'], // a Monday is its own week start
    ['2026-09-13', '2026-09-07'], // Sunday belongs to the week that opened 6 days earlier
    ['2026-09-11', '2026-09-07'],
    ['2026-01-01', '2025-12-29'], // ISO year boundary
    ['2026-01-04', '2025-12-29'], // Sunday of that same ISO week
    ['2026-01-05', '2026-01-05']
  ];
  for (const zone of zones) {
    for (const [day, monday] of cases) {
      assert.equal(getMondayOfIsoWeek(day, zone), monday, `${zone} ${day}`);
      assert.equal(getSundayOfIsoWeek(monday, zone), addDaysToDateLabel(monday, 6, zone), `${zone} ${monday}`);
    }
  }
});
