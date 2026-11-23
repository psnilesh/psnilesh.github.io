/*
 * Tests for the expiry date helpers.
 *
 * The interesting risk in this module is timezone off-by-one, so beyond the
 * ordinary cases there is a block that re-runs the core invariants in a
 * child process under extreme timezones (UTC+14 through UTC-12). Setting
 * process.env.TZ after startup does not reliably affect Date, which is why
 * those cases spawn rather than mutate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  todayUtc,
  parseIsoDate,
  toIsoDate,
  daysUntil,
  isoDateInDays,
  describeDate,
  isWeekend,
} from '../js/dates.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATES_MODULE = join(here, '..', 'js', 'dates.js');

test('parseIsoDate accepts well-formed dates', () => {
  assert.equal(parseIsoDate('2026-12-18'), Date.UTC(2026, 11, 18));
  assert.equal(parseIsoDate('2027-01-01'), Date.UTC(2027, 0, 1));
  assert.equal(parseIsoDate(' 2026-12-18 '), Date.UTC(2026, 11, 18));
  // A real leap day.
  assert.equal(parseIsoDate('2028-02-29'), Date.UTC(2028, 1, 29));
});

test('parseIsoDate rejects malformed and impossible dates', () => {
  for (const bad of [
    '',
    'tomorrow',
    '18/12/2026',
    '2026-12-18T00:00:00Z',
    '2026-1-8',
    '2026-13-01',
    '2026-00-10',
    '2026-12-00',
    '2026-12-32',
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseIsoDate(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseIsoDate rejects dates that would silently roll over', () => {
  // Date.parse('2026-02-31') happily becomes 3 March. That would quietly
  // misprice an option, so it must be rejected instead.
  assert.equal(parseIsoDate('2026-02-31'), null, 'no 31st of February');
  assert.equal(parseIsoDate('2027-02-29'), null, '2027 is not a leap year');
  assert.equal(parseIsoDate('2026-04-31'), null, 'April has 30 days');
});

test('toIsoDate round-trips with parseIsoDate', () => {
  for (const iso of ['2026-11-23', '2026-12-18', '2027-03-19', '2028-02-29']) {
    assert.equal(toIsoDate(parseIsoDate(iso)), iso);
  }
  assert.equal(toIsoDate(NaN), '');
});

test('daysUntil counts whole calendar days', () => {
  const now = new Date(2026, 10, 23, 14, 30); // 23 Nov 2026, local afternoon
  assert.equal(daysUntil('2026-11-23', now), 0, 'today is zero');
  assert.equal(daysUntil('2026-11-24', now), 1);
  assert.equal(daysUntil('2026-12-23', now), 30);
  assert.equal(daysUntil('2027-11-23', now), 365);
  assert.equal(daysUntil('2026-11-20', now), -3, 'past is negative');
  assert.equal(daysUntil('nonsense', now), null);
});

test('daysUntil is unaffected by the time of day', () => {
  // An option expiring on a given date does not get closer as the afternoon
  // wears on. Every hour of the same local day must give the same answer.
  const answers = new Set();
  for (const hour of [0, 1, 6, 11, 12, 13, 18, 22, 23]) {
    answers.add(daysUntil('2026-12-18', new Date(2026, 10, 23, hour, 59, 59)));
  }
  assert.equal(answers.size, 1, `expected one answer, got ${[...answers]}`);
  assert.equal([...answers][0], 25);
});

test('isoDateInDays is the inverse of daysUntil', () => {
  const now = new Date(2026, 10, 23, 9, 0);
  for (const days of [0, 1, 7, 29, 30, 45, 120, 365, 3650]) {
    const iso = isoDateInDays(days, now);
    assert.equal(daysUntil(iso, now), days, `round-trip failed at ${days} days`);
  }
  assert.equal(isoDateInDays(NaN, now), '');
});

test('isoDateInDays crosses month and year boundaries correctly', () => {
  assert.equal(isoDateInDays(1, new Date(2026, 11, 31, 10, 0)), '2027-01-01');
  assert.equal(isoDateInDays(1, new Date(2028, 1, 28, 10, 0)), '2028-02-29');
  assert.equal(isoDateInDays(1, new Date(2027, 1, 28, 10, 0)), '2027-03-01');
});

test('todayUtc normalises the local date to UTC midnight', () => {
  const ms = todayUtc(new Date(2026, 10, 23, 23, 59, 59));
  assert.equal(ms, Date.UTC(2026, 10, 23));
  assert.equal(ms % 86400000, 0, 'must land exactly on midnight');
});

test('describeDate formats from UTC parts, not local', () => {
  // 18 Dec 2026 is a Friday, the standard monthly expiry. Asserted by parts
  // rather than exact string, because locale punctuation varies with the
  // ICU version Node was built against.
  const label = describeDate('2026-12-18');
  for (const part of ['Fri', '18', 'Dec', '2026']) {
    assert.ok(label.includes(part), `"${label}" should contain "${part}"`);
  }
  assert.equal(describeDate('garbage'), '');
});

test('isWeekend flags Saturday and Sunday', () => {
  assert.equal(isWeekend('2026-12-18'), false, 'Friday');
  assert.equal(isWeekend('2026-12-19'), true, 'Saturday');
  assert.equal(isWeekend('2026-12-20'), true, 'Sunday');
  assert.equal(isWeekend('2026-12-21'), false, 'Monday');
  assert.equal(isWeekend('garbage'), false);
});

/* ------------------------------------------------------------------ *
 * Timezone safety, in child processes with TZ actually set
 * ------------------------------------------------------------------ */

const TIMEZONES = [
  'UTC',
  'Pacific/Kiritimati', // UTC+14, the furthest ahead
  'Etc/GMT+12', // UTC-12, the furthest behind
  'America/Los_Angeles', // negative offset with DST
  'Asia/Kolkata', // half-hour offset
  'Australia/Lord_Howe', // half-hour offset with DST
];

function runUnderTz(tz, script) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  }).trim();
}

test('daysUntil/isoDateInDays round-trip holds in every timezone', () => {
  const script = `
    import { daysUntil, isoDateInDays } from ${JSON.stringify(DATES_MODULE)};
    const failures = [];
    for (const days of [0, 1, 2, 7, 29, 30, 45, 120, 365]) {
      const iso = isoDateInDays(days);
      const back = daysUntil(iso);
      if (back !== days) failures.push(days + ' -> ' + iso + ' -> ' + back);
    }
    console.log(failures.length ? 'FAIL ' + failures.join('; ') : 'OK');
  `;
  for (const tz of TIMEZONES) {
    assert.equal(runUnderTz(tz, script), 'OK', `round-trip broke under TZ=${tz}`);
  }
});

test("today's date reads as zero days to expiry in every timezone", () => {
  // The off-by-one this guards: an option expiring today showing as -1 or 1
  // day out, which flips it between "expired" and "still alive".
  const script = `
    import { daysUntil, isoDateInDays } from ${JSON.stringify(DATES_MODULE)};
    console.log(daysUntil(isoDateInDays(0)) === 0 ? 'OK' : 'FAIL ' + daysUntil(isoDateInDays(0)));
  `;
  for (const tz of TIMEZONES) {
    assert.equal(runUnderTz(tz, script), 'OK', `today was not zero under TZ=${tz}`);
  }
});

test('a fixed expiry date gives a consistent day count across timezones', () => {
  // Different zones can legitimately be on different calendar days, so the
  // answers may differ by at most one. What must not happen is a wild spread.
  const script = `
    import { daysUntil } from ${JSON.stringify(DATES_MODULE)};
    console.log(String(daysUntil('2027-06-18')));
  `;
  const answers = TIMEZONES.map((tz) => Number(runUnderTz(tz, script)));
  const spread = Math.max(...answers) - Math.min(...answers);
  assert.ok(
    spread <= 1,
    `day counts varied by ${spread} across timezones: ${answers.join(', ')}`
  );
});
