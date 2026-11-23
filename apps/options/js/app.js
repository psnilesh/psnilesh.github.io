/*
 * Application wiring: reads the form, calls bs.js, writes the DOM.
 *
 * Deliberately contains no pricing mathematics and no Chart.js
 * configuration. Those live in bs.js and chart.js respectively. If a
 * formula needs changing it is in bs.js (and covered by tests); if the
 * chart needs restyling it is in chart.js.
 *
 * State lives in the form elements themselves and is mirrored into the
 * URL hash so a configured position can be bookmarked or shared.
 */

import {
  evaluate,
  impliedVol,
  solveSpotForValue,
  expiryBreakeven,
  atmApproximation,
  expectedMoves,
  eventScenario,
} from './bs.js';
import { createPayoffChart, COLORS } from './chart.js';
import {
  daysUntil,
  isoDateInDays,
  describeDate,
  isWeekend,
  parseIsoDate,
} from './dates.js';

const SHARES_PER_CONTRACT = 100;
const CHART_POINTS = 161;

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const money = (v, dp = 2) =>
  !Number.isFinite(v)
    ? '--'
    : (v < 0 ? '-$' : '$') +
      Math.abs(v).toLocaleString('en-US', {
        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      });

const signedMoney = (v, dp = 2) =>
  !Number.isFinite(v) ? '--' : (v > 0 ? '+' : '') + money(v, dp).replace('$-', '-$');

const pct = (v, dp = 1) =>
  !Number.isFinite(v) ? '--' : (v * 100).toFixed(dp) + '%';

const signedPct = (v, dp = 1) =>
  !Number.isFinite(v) ? '--' : (v > 0 ? '+' : '') + (v * 100).toFixed(dp) + '%';

const num = (v, dp = 3) => (!Number.isFinite(v) ? '--' : v.toFixed(dp));

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function setClassFlag(id, cls, on) {
  const node = $(id);
  if (node) node.classList.toggle(cls, !!on);
}

/* ------------------------------------------------------------------ *
 * Input schema. Each entry maps a form control to a URL-hash key and a
 * parser, so reading state, writing the hash and restoring from a link
 * all stay in sync from one definition.
 * ------------------------------------------------------------------ */

const FIELDS = [
  { id: 'sym', key: 's', kind: 'text', fallback: '' },
  { id: 'side', key: 'd', kind: 'text', fallback: 'long' },
  { id: 'type', key: 't', kind: 'text', fallback: 'call' },
  { id: 'qty', key: 'n', kind: 'number', fallback: 1 },
  { id: 'spot', key: 'S', kind: 'number', fallback: 100 },
  { id: 'strike', key: 'K', kind: 'number', fallback: 100 },
  // Expiry is expressed two ways and kept in sync. The date is the honest
  // identity of the contract; the day count is what the model needs and
  // what is convenient for "what if I held 45 days". Both go into the hash:
  // `D` (date) wins on restore, because a shared link should still mean the
  // same option a week later, while `e` keeps older links working.
  { id: 'expiryDate', key: 'D', kind: 'text', fallback: '' },
  { id: 'dte', key: 'e', kind: 'number', fallback: 30 },
  { id: 'iv', key: 'v', kind: 'number', fallback: 30 },
  { id: 'premium', key: 'p', kind: 'number', fallback: null },
  { id: 'rate', key: 'r', kind: 'number', fallback: 0 },
  { id: 'divyield', key: 'q', kind: 'number', fallback: 0 },
  { id: 'exitDays', key: 'x', kind: 'number', fallback: 1 },
  { id: 'exitIv', key: 'w', kind: 'number', fallback: 30 },
  { id: 'eventIvAfter', key: 'a', kind: 'number', fallback: 15 },
  // 'radio' is read from the checked member of a same-named group, since
  // getElementById on a radio returns the first one regardless of state.
  { id: 'view', key: 'm', kind: 'radio', fallback: 'value' },
];

const radioGroup = (name) =>
  [...document.querySelectorAll(`input[name="${name}"]`)];

function readFields() {
  const out = {};
  for (const f of FIELDS) {
    if (f.kind === 'radio') {
      const checked = radioGroup(f.id).find((n) => n.checked);
      out[f.id] = checked ? checked.value : f.fallback;
      continue;
    }
    const node = $(f.id);
    if (!node) {
      out[f.id] = f.fallback;
      continue;
    }
    if (f.kind === 'number') {
      const raw = node.value.trim();
      out[f.id] = raw === '' ? f.fallback : Number(raw);
    } else {
      out[f.id] = node.value;
    }
  }
  return out;
}

function writeHash(fields) {
  const params = new URLSearchParams();
  for (const f of FIELDS) {
    const v = fields[f.id];
    if (v == null || v === '' || Number.isNaN(v)) continue;
    params.set(f.key, String(v));
  }
  // replaceState rather than assigning location.hash, so dragging a
  // slider does not push hundreds of entries onto the back button.
  history.replaceState(null, '', '#' + params.toString());
}

function restoreFromHash() {
  if (!location.hash || location.hash.length < 2) return;
  const params = new URLSearchParams(location.hash.slice(1));
  for (const f of FIELDS) {
    if (!params.has(f.key)) continue;
    const value = params.get(f.key);
    if (f.kind === 'radio') {
      const match = radioGroup(f.id).find((n) => n.value === value);
      if (match) match.checked = true;
      continue;
    }
    const node = $(f.id);
    if (node) node.value = value;
  }
}

/* ------------------------------------------------------------------ *
 * Expiry: date and day-count kept in sync
 * ------------------------------------------------------------------ */

// Which control the user touched last, so reconciliation knows which value
// is authoritative. Tracked rather than inferred inside refresh(), so the
// result does not depend on the order listeners happen to fire in.
let expirySource = 'days';

export function setExpirySource(source) {
  expirySource = source;
}

/**
 * Make the date field and the day-count field agree, writing whichever one
 * the user did not just edit. Called before the model reads either.
 *
 * Returns the day count the model should use.
 */
function reconcileExpiry() {
  const dateEl = $('expiryDate');
  const daysEl = $('dte');
  if (!dateEl || !daysEl) return Number(daysEl?.value) || 0;

  if (expirySource === 'date' && parseIsoDate(dateEl.value) != null) {
    const days = daysUntil(dateEl.value);
    // A past date is clamped to zero for the model (an expired option is
    // worth intrinsic value) but left visible in the field so the user can
    // see what they picked and correct it.
    daysEl.value = String(Math.max(0, days));
    return days;
  }

  const days = Number(daysEl.value);
  if (Number.isFinite(days)) {
    dateEl.value = isoDateInDays(Math.max(0, days));
    return days;
  }
  return 0;
}

function renderExpiryNote(rawDays) {
  const iso = ($('expiryDate') || {}).value || '';
  if (!iso) {
    setText('expiry-note', '');
    return;
  }
  if (rawDays < 0) {
    setText(
      'expiry-note',
      `${describeDate(iso)} is in the past. Priced as expired.`
    );
    return;
  }
  const parts = [describeDate(iso)];
  if (isWeekend(iso)) {
    parts.push('— weekend, check the date');
  }
  setText('expiry-note', parts.join(' '));
}

/* ------------------------------------------------------------------ *
 * Core computation
 * ------------------------------------------------------------------ */

function buildModel(fields) {
  const type = fields.type === 'put' ? 'put' : 'call';
  const isLong = fields.side !== 'short';
  const sideSign = isLong ? 1 : -1;

  const S = fields.spot;
  const K = fields.strike;
  const dte = Math.max(0, fields.dte);
  const vol = fields.iv / 100;
  const r = fields.rate / 100;
  const q = fields.divyield / 100;
  const contracts = Math.max(1, Math.round(fields.qty || 1));

  const errors = [];
  if (!(S > 0)) errors.push('Stock price must be greater than zero.');
  if (!(K > 0)) errors.push('Strike must be greater than zero.');
  if (!(vol > 0)) errors.push('Implied volatility must be greater than zero.');
  if (!Number.isFinite(dte)) errors.push('Days to expiry must be a number.');
  if (errors.length) return { errors };

  const T = dte / 365;

  // Exit scenario: how many days from now you expect to sell, and the IV
  // you expect to receive then.
  const exitDaysHeld = Math.min(Math.max(0, fields.exitDays || 0), dte);
  const exitT = (dte - exitDaysHeld) / 365;
  const exitVol = Math.max(fields.exitIv / 100, 0);

  const now = evaluate({ S, K, T, vol, r, q, type });

  // Premium: what you actually paid. Defaults to the model price so the
  // page is usable before you have a real fill.
  const premium =
    fields.premium != null && Number.isFinite(fields.premium) && fields.premium >= 0
      ? fields.premium
      : now.price;

  const atExit = evaluate({ S, K, T: exitT, vol: exitVol, r, q, type });

  const breakevenExpiry = expiryBreakeven({ K, premium, type });
  const breakevenEarly = solveSpotForValue({
    K,
    T: exitT,
    vol: exitVol,
    r,
    q,
    type,
    target: premium,
    spotHint: S,
  });

  const event = eventScenario({
    S,
    K,
    T,
    volBefore: vol,
    volAfter: Math.max(fields.eventIvAfter / 100, 0),
    r,
    q,
    type,
    premium,
    exitT,
  });

  return {
    errors: [],
    type,
    isLong,
    sideSign,
    S,
    K,
    T,
    dte,
    vol,
    r,
    q,
    contracts,
    multiplier: contracts * SHARES_PER_CONTRACT,
    exitDaysHeld,
    exitDaysRemaining: dte - exitDaysHeld,
    exitT,
    exitVol,
    now,
    atExit,
    premium,
    premiumIsModel: !(
      fields.premium != null &&
      Number.isFinite(fields.premium) &&
      fields.premium >= 0
    ),
    breakevenExpiry,
    breakevenEarly,
    event,
    moves: expectedMoves(S, vol),
    approx: atmApproximation(S, vol, T),
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderValuation(m) {
  setText('out-model-price', money(m.now.price));
  setText('out-model-total', money(m.now.price * m.multiplier));
  setText('out-intrinsic', money(m.now.intrinsic));
  setText('out-extrinsic', money(m.now.extrinsic));
  setText('out-approx', money(m.approx));

  const moneyness =
    m.type === 'call'
      ? m.S > m.K
        ? 'in the money'
        : m.S < m.K
          ? 'out of the money'
          : 'at the money'
      : m.S < m.K
        ? 'in the money'
        : m.S > m.K
          ? 'out of the money'
          : 'at the money';
  setText('out-moneyness', moneyness);

  const gap = Math.abs(m.S - m.K) / m.S;
  setText(
    'out-approx-note',
    gap > 0.05
      ? 'Shortcut only applies near the money, so ignore it here.'
      : 'The 0.4 x S x IV x sqrt(T) shortcut, for comparison.'
  );

  setText('out-premium', money(m.premium));
  setText('out-premium-total', money(m.premium * m.multiplier));
  // Compared with a half-cent epsilon rather than exact equality. After
  // "Solve for IV" the premium and the model price agree to many decimals
  // but not bit-for-bit, which used to render as "You paid $0.00 above
  // model value."
  const premiumGap = m.premium - m.now.price;
  setText(
    'out-premium-note',
    m.premiumIsModel
      ? 'Using the model price because you have not entered a fill.'
      : Math.abs(premiumGap) < 0.005
        ? 'Matches the model price.'
        : premiumGap > 0
          ? `You paid ${money(premiumGap)} above model value.`
          : `You paid ${money(-premiumGap)} below model value.`
  );
}

function renderGreeks(m) {
  const g = m.now;
  const sign = m.sideSign;

  const delta = g.delta * sign;
  const gamma = g.gamma * sign;
  const theta = g.theta * sign;
  const vega = g.vega * sign;
  const rho = g.rho * sign;

  setText('g-delta', num(delta, 3));
  setText(
    'g-delta-note',
    `Stock up $1 moves this position ${signedMoney(delta * m.multiplier)}. ` +
      `Roughly a ${pct(Math.abs(g.delta), 0)} chance of finishing in the money.`
  );

  setText('g-gamma', num(gamma, 4));
  setText(
    'g-gamma-note',
    `Delta itself changes by ${num(Math.abs(gamma), 4)} per $1 move, so gains ` +
      `accelerate ${m.isLong ? 'in your favour' : 'against you'}.`
  );

  setText('g-theta', money(theta));
  setText(
    'g-theta-note',
    `${theta < 0 ? 'Costs' : 'Earns'} ${money(Math.abs(theta * m.multiplier))} ` +
      `per day with the stock unchanged.`
  );

  setText('g-vega', money(vega));
  setText(
    'g-vega-note',
    `Each 1 point of IV is worth ${money(Math.abs(vega * m.multiplier))} to ` +
      `you${vega < 0 ? ' when it falls' : ' when it rises'}.`
  );

  setText('g-rho', money(rho));
  setText('g-rho-note', 'Interest rate sensitivity. Rarely matters short-dated.');
}

function renderBreakevens(m) {
  setText('be-expiry', money(m.breakevenExpiry));
  setText(
    'be-expiry-move',
    signedPct(m.breakevenExpiry / m.S - 1) + ' from here'
  );

  if (m.breakevenEarly == null) {
    setText('be-early', 'unreachable');
    setText('be-early-move', 'No stock price recovers this premium on that date.');
    setText('be-gap', '--');
    setText('be-gap-note', '');
    return;
  }

  setText('be-early', money(m.breakevenEarly));
  setText('be-early-move', signedPct(m.breakevenEarly / m.S - 1) + ' from here');

  const gap = Math.abs(m.breakevenExpiry - m.breakevenEarly);
  setText('be-gap', money(gap));
  setText(
    'be-gap-note',
    m.exitDaysRemaining <= 0
      ? 'At expiry the two are identical: no time value is left to sell.'
      : `With ${m.exitDaysRemaining} days still to run, selling early recovers ` +
        `${money(gap)} of time value that holding to expiry gives up. Your broker ` +
        `shows only the ${money(m.breakevenExpiry)} figure.`
  );
}

function renderEvent(m) {
  const e = m.event;
  setText('ev-paid', money(e.paid));
  setText('ev-flat', money(e.valueIfFlat));
  setText('ev-crush', signedMoney(e.crushLoss));
  setText('ev-crush-pct', signedPct(e.crushLossPct, 0));
  setClassFlag('ev-crush', 'oc-bad', e.crushLoss < 0);
  setClassFlag('ev-crush', 'oc-good', e.crushLoss > 0);

  if (e.breakeven == null) {
    setText('ev-breakeven', 'unreachable');
    setText('ev-required', '--');
    setText(
      'ev-note',
      'At that volatility no stock price gets your premium back on the chosen date.'
    );
    return;
  }

  setText('ev-breakeven', money(e.breakeven));
  setText('ev-required', signedPct(e.requiredMovePct));
  setText(
    'ev-note',
    `The market is effectively charging you for a ${pct(
      Math.abs(e.requiredMovePct)
    )} move. You profit only on the excess beyond that, which is why being ` +
      `right about direction is not enough.`
  );
}

function renderMoves(m) {
  const body = $('moves-body');
  if (!body) return;
  body.textContent = '';
  for (const row of m.moves) {
    const tr = document.createElement('tr');
    const cells = [
      row.label,
      `1/${row.periodsPerYear}`,
      row.root.toFixed(3),
      pct(row.pct, 2),
      money(row.move),
      `${money(row.low)} to ${money(row.high)}`,
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement('td');
      td.textContent = text;
      if (i >= 1) td.className = 'oc-numeric';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  const daily = m.vol / Math.sqrt(252);
  setText(
    'moves-note',
    `Dividing ${pct(m.vol, 0)} by sqrt(252) = 15.87 (the "divide by 16" rule) ` +
      `gives ${pct(daily, 2)} for a typical day.`
  );
}

/* ------------------------------------------------------------------ *
 * Chart
 * ------------------------------------------------------------------ */

function chartRange(m) {
  // Three standard deviations of movement over the holding period, floored
  // at +/-30% so a low-volatility name still shows a useful window.
  const sigma = m.vol * Math.sqrt(Math.max(m.exitT, 1 / 365));
  let half = Math.max(3 * sigma * m.S, 0.3 * m.S);
  let lo = m.S - half;
  let hi = m.S + half;

  // Always include the strike and both breakevens, or the chart can hide
  // the single most important point on it.
  for (const x of [m.K, m.breakevenExpiry, m.breakevenEarly]) {
    if (!Number.isFinite(x)) continue;
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  const pad = (hi - lo) * 0.06;
  return { lo: Math.max(0.01, lo - pad), hi: hi + pad };
}

function renderChart(chart, m, view) {
  const { lo, hi } = chartRange(m);
  const step = (hi - lo) / (CHART_POINTS - 1);

  const exitPoints = [];
  const expiryPoints = [];

  for (let i = 0; i < CHART_POINTS; i++) {
    const x = lo + i * step;
    const exitValue = evaluate({
      S: x,
      K: m.K,
      T: m.exitT,
      vol: m.exitVol,
      r: m.r,
      q: m.q,
      type: m.type,
    }).price;
    const expiryValue =
      m.type === 'call' ? Math.max(x - m.K, 0) : Math.max(m.K - x, 0);

    if (view === 'pnl') {
      exitPoints.push({ x, y: (exitValue - m.premium) * m.sideSign });
      expiryPoints.push({ x, y: (expiryValue - m.premium) * m.sideSign });
    } else {
      exitPoints.push({ x, y: exitValue });
      expiryPoints.push({ x, y: expiryValue });
    }
  }

  const exitLabel =
    m.exitDaysRemaining > 0
      ? `Sell in ${m.exitDaysHeld}d (${m.exitDaysRemaining}d left, IV ${(m.exitVol * 100).toFixed(0)}%)`
      : 'At expiry';

  const series = [
    {
      id: 'exit',
      label: exitLabel,
      points: exitPoints,
      color: COLORS.exit,
      width: 2.5,
    },
    {
      id: 'expiry',
      label: 'Held to expiry',
      points: expiryPoints,
      color: COLORS.expiry,
      dashed: true,
    },
  ];

  // Spot, strike and breakeven are often only a dollar or two apart, so
  // their labels are spread to different heights along their own lines.
  // chartjs-plugin-annotation v3 accepts a percentage for label.position,
  // measured from the start of the line, which keeps them inside the plot
  // area regardless of the y range (unlike a fixed pixel yAdjust).
  const vLines = [
    {
      value: m.S,
      label: `Spot ${money(m.S, 0)}`,
      color: COLORS.spot,
      // Kept well clear of the bottom of the plot, where the horizontal
      // "premium paid" line and its own label sit.
      position: '48%',
    },
    {
      value: m.K,
      label: `Strike ${money(m.K, 0)}`,
      color: COLORS.strike,
      position: '18%',
    },
  ];
  if (Number.isFinite(m.breakevenEarly)) {
    vLines.push({
      value: m.breakevenEarly,
      label: `Breakeven ${money(m.breakevenEarly, 2)}`,
      color: COLORS.breakeven,
      position: '32%',
    });
  }

  const hLines =
    view === 'pnl'
      ? []
      : [
          {
            value: m.premium,
            label: `Paid ${money(m.premium)}`,
            color: COLORS.premium,
          },
        ];

  chart.update({
    series,
    vLines,
    hLines,
    xLabel: 'Stock price',
    yLabel: view === 'pnl' ? 'Profit / loss per share' : 'Option value per share',
  });
}

/* ------------------------------------------------------------------ *
 * Slider labels and dependent control ranges
 * ------------------------------------------------------------------ */

function syncControlRanges(fields) {
  const dte = Math.max(0, Math.round(fields.dte || 0));
  const exitSlider = $('exitDays');
  if (exitSlider) {
    exitSlider.max = String(dte);
    if (Number(exitSlider.value) > dte) exitSlider.value = String(dte);
  }
}

function renderControlLabels(m) {
  setText(
    'exitDaysOut',
    m.exitDaysHeld === 0
      ? 'today'
      : `${m.exitDaysHeld} day${m.exitDaysHeld === 1 ? '' : 's'} from now`
  );
  setText(
    'exitDaysRemainingOut',
    `${m.exitDaysRemaining} day${m.exitDaysRemaining === 1 ? '' : 's'} of life left`
  );
  setText('exitIvOut', `${(m.exitVol * 100).toFixed(0)}%`);
  // Expressed in POINTS, not percent. Going from 70% IV to 35% is a 35
  // point drop; calling it "-35%" invites reading it as a 35% relative
  // decline, which would be 70% -> 45.5%. The epsilon keeps a rounding
  // artefact (entry 41.99 vs a slider pinned to 42) from reading "+0 pts".
  const ivPointDiff = (m.exitVol - m.vol) * 100;
  setText(
    'exitIvDelta',
    Math.abs(ivPointDiff) < 0.5
      ? 'unchanged'
      : `${ivPointDiff > 0 ? '+' : '-'}${Math.abs(ivPointDiff).toFixed(0)} pts vs entry`
  );
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

function main() {
  const canvas = $('payoff-chart');
  if (!canvas) return;

  let chart;
  try {
    chart = createPayoffChart(canvas);
  } catch (err) {
    const banner = $('oc-errors');
    if (banner) {
      banner.textContent =
        'The chart library failed to load, so the graph is unavailable. ' +
        'All numbers below still work.';
      banner.hidden = false;
    }
    console.error(err);
  }

  function refresh() {
    // Expiry first: it rewrites one of the two expiry fields, so it has to
    // settle before anything reads them.
    const rawDays = reconcileExpiry();
    renderExpiryNote(rawDays);

    const fields = readFields();
    syncControlRanges(fields);

    const m = buildModel(readFields());
    const banner = $('oc-errors');

    if (m.errors && m.errors.length) {
      if (banner) {
        banner.textContent = m.errors.join(' ');
        banner.hidden = false;
      }
      return;
    }
    if (banner) banner.hidden = true;

    renderValuation(m);
    renderGreeks(m);
    renderBreakevens(m);
    renderEvent(m);
    renderMoves(m);
    renderControlLabels(m);
    if (chart) renderChart(chart, m, fields.view);

    writeHash(readFields());
  }

  // Record which expiry control was touched, so reconcileExpiry() knows
  // which of the two to treat as authoritative. Registered before the
  // generic field binding below, but order does not matter: these only set
  // a flag that refresh() reads.
  const dateEl = $('expiryDate');
  if (dateEl) {
    for (const event of ['input', 'change']) {
      dateEl.addEventListener(event, () => setExpirySource('date'));
    }
  }
  const daysEl = $('dte');
  if (daysEl) {
    for (const event of ['input', 'change']) {
      daysEl.addEventListener(event, () => setExpirySource('days'));
    }
  }

  // Bind every declared field.
  for (const f of FIELDS) {
    const nodes = f.kind === 'radio' ? radioGroup(f.id) : [$(f.id)];
    for (const node of nodes) {
      if (!node) continue;
      node.addEventListener('input', refresh);
      node.addEventListener('change', refresh);
    }
  }

  // "Solve IV from a market price" helper: the inverse direction, for
  // when a broker shows a price but not an implied volatility.
  const solveBtn = $('btn-solve-iv');
  if (solveBtn) {
    solveBtn.addEventListener('click', () => {
      const fields = readFields();
      const marketPrice = Number(($('marketPrice') || {}).value);
      const note = $('solve-iv-note');
      if (!(marketPrice > 0)) {
        if (note) note.textContent = 'Enter the option price you were quoted first.';
        return;
      }
      const v = impliedVol({
        S: fields.spot,
        K: fields.strike,
        T: Math.max(fields.dte, 0) / 365,
        r: fields.rate / 100,
        q: fields.divyield / 100,
        type: fields.type === 'put' ? 'put' : 'call',
        marketPrice,
      });
      if (v == null) {
        if (note) {
          note.textContent =
            'Cannot determine IV from that price. Either no volatility ' +
            'reproduces it (check the strike, expiry, and call vs put), or the ' +
            'option is trading at parity with no time value left, in which ' +
            'case volatility has no effect on its price.';
        }
        return;
      }
      $('iv').value = (v * 100).toFixed(2);
      $('exitIv').value = (v * 100).toFixed(0);
      $('premium').value = marketPrice.toFixed(2);
      if (note) {
        note.textContent = `That price implies ${pct(v, 2)} volatility. Filled in above.`;
      }
      refresh();
    });
  }

  // Match the exit IV to entry IV, i.e. assume no volatility change.
  const flatBtn = $('btn-flat-iv');
  if (flatBtn) {
    flatBtn.addEventListener('click', () => {
      $('exitIv').value = $('iv').value;
      refresh();
    });
  }

  // Halve the exit IV: the quick way to see a post-earnings crush.
  const crushBtn = $('btn-crush-iv');
  if (crushBtn) {
    crushBtn.addEventListener('click', () => {
      $('exitIv').value = String(Math.round(Number($('iv').value) / 2));
      refresh();
    });
  }

  const copyBtn = $('btn-copy-link');
  if (copyBtn) {
    let copyTimer = null;
    copyBtn.addEventListener('click', async () => {
      const note = $('copy-note');
      let message;
      try {
        await navigator.clipboard.writeText(location.href);
        message = 'Link copied.';
      } catch {
        message = 'Copy failed; the address bar holds the position.';
      }
      if (!note) return;
      note.textContent = message;
      // Clear the confirmation rather than leaving it on screen forever.
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        note.textContent = '';
      }, 4000);
    });
  }

  // A hash-only URL change does not reload the document, so pasting a
  // shared position into the address bar while already on the page, or
  // following an in-page link to one, would otherwise leave the form
  // showing stale values. writeHash() uses replaceState, which does not
  // fire hashchange, so this cannot loop.
  // A link carrying an explicit expiry date must win over any day count in
  // the same link, since the date is what identifies the contract.
  const adoptHashExpiry = () => {
    const iso = ($('expiryDate') || {}).value;
    setExpirySource(iso && parseIsoDate(iso) != null ? 'date' : 'days');
  };

  window.addEventListener('hashchange', () => {
    restoreFromHash();
    adoptHashExpiry();
    refresh();
  });

  restoreFromHash();
  adoptHashExpiry();
  refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
