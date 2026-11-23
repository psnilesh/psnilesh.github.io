/*
 * Date helpers for expiry handling. Pure functions, no DOM, no I/O.
 *
 * EVERY CALCULATION IS IN UTC, DELIBERATELY.
 *
 * The bug this avoids: `new Date('2026-12-18')` parses as UTC midnight,
 * while `new Date()` is a local instant. Subtracting one from the other and
 * dividing by 86400000 gives an answer that is off by a day for anyone west
 * of UTC for most of the day, and off by a day in the other direction east
 * of it. An option's expiry is a calendar date, not an instant, so both
 * sides are normalised to UTC midnight before any arithmetic.
 *
 * `today` is injectable throughout so tests are not time-dependent.
 */

const MS_PER_DAY = 86400000;

/**
 * Today as a UTC-midnight timestamp, derived from the LOCAL calendar date.
 *
 * Local date is correct here: if it is the 18th where the user is sitting,
 * their option expiring on the 18th expires today, regardless of what UTC
 * thinks. Taking the local Y/M/D and rebuilding it at UTC midnight gives a
 * stable value to subtract from a parsed ISO date.
 */
export function todayUtc(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Parse a YYYY-MM-DD string to a UTC-midnight timestamp, or null.
 *
 * Built with Date.UTC rather than Date.parse so an invalid date such as
 * 2026-02-31 is rejected instead of silently rolling into March.
 */
export function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Reject rolled-over dates (2026-02-31 would otherwise become 2026-03-03).
  //
  // Checking month and day alone is provably sufficient: a year can only
  // roll via a December overflow, which necessarily changes the month too.
  // Verified by sweeping every syntactically-valid y/m/d from 2024 to 2030 —
  // zero cases where a year check would catch something these two miss.
  // The year check was here and is deliberately gone: mutation testing
  // showed removing it broke nothing, which is the definition of dead code.
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/** Format a UTC-midnight timestamp as YYYY-MM-DD for an <input type="date">. */
export function toIsoDate(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `today` to the given ISO date.
 * Negative when the date is in the past, null when unparseable.
 */
export function daysUntil(isoDate, now = new Date()) {
  const target = parseIsoDate(isoDate);
  if (target == null) return null;
  // Both operands are exact UTC midnights, so this division is always
  // integral and Math.round is a no-op rather than a rounding decision.
  // It stays as a guard: if todayUtc() ever stopped normalising to
  // midnight, floor() would silently shift every count by a day. The
  // "todayUtc normalises to UTC midnight" test protects that invariant.
  return Math.round((target - todayUtc(now)) / MS_PER_DAY);
}

/** The ISO date `days` calendar days from today. */
export function isoDateInDays(days, now = new Date()) {
  if (!Number.isFinite(days)) return '';
  return toIsoDate(todayUtc(now) + Math.round(days) * MS_PER_DAY);
}

/**
 * Human-readable expiry label, e.g. "Fri 18 Dec 2026".
 *
 * Formatted from UTC parts so it matches the date the user picked rather
 * than shifting by a day in a negative-offset timezone.
 */
export function describeDate(isoDate) {
  const ms = parseIsoDate(isoDate);
  if (ms == null) return '';
  return new Date(ms).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * True when the date is a Saturday or Sunday.
 *
 * Worth surfacing: US equity options expire on a weekday (standard monthlies
 * on the third Friday), so a weekend pick is almost always a typo.
 */
export function isWeekend(isoDate) {
  const ms = parseIsoDate(isoDate);
  if (ms == null) return false;
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}
