/*
 * Tests for the pricing module. Run with:  node --test apps/options/test/
 *
 * No framework and no dependencies: Node's built-in test runner only.
 * This directory is NOT passed through to the built site.
 *
 * A sign error in d2 or a transposed term produces plausible-looking
 * numbers rather than a crash, so the reference values below are the only
 * thing standing between a subtle mistake and a page that confidently
 * misprices options. Values marked "Hull" come from John C. Hull,
 * Options, Futures and Other Derivatives, the standard textbook example.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normCdf,
  normPdf,
  evaluate,
  price,
  impliedVol,
  solveSpotForValue,
  expiryBreakeven,
  atmApproximation,
  scaleVol,
  expectedMoves,
  eventScenario,
} from '../js/bs.js';

const close = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`
  );
};

test('normCdf matches known values', () => {
  close(normCdf(0), 0.5, 1e-9, 'N(0)');
  close(normCdf(1), 0.8413447, 1e-6, 'N(1)');
  close(normCdf(-1), 0.1586553, 1e-6, 'N(-1)');
  close(normCdf(1.96), 0.9750021, 1e-6, 'N(1.96)');
  close(normCdf(-1.96), 0.0249979, 1e-6, 'N(-1.96)');
  close(normCdf(3), 0.9986501, 1e-6, 'N(3)');
  close(normCdf(-3), 0.0013499, 1e-6, 'N(-3)');
});

test('normCdf is symmetric and bounded', () => {
  for (const x of [0.1, 0.7, 1.3, 2.5, 4, 8]) {
    close(normCdf(x) + normCdf(-x), 1, 1e-7, `symmetry at ${x}`);
  }
  assert.ok(normCdf(40) <= 1 && normCdf(40) > 0.999999);
  assert.ok(normCdf(-40) >= 0 && normCdf(-40) < 1e-6);
});

test('normPdf matches known values', () => {
  close(normPdf(0), 0.3989423, 1e-7, 'phi(0)');
  close(normPdf(1), 0.2419707, 1e-7, 'phi(1)');
});

test('Hull textbook example: S=42 K=40 r=10% vol=20% T=0.5', () => {
  const args = { S: 42, K: 40, T: 0.5, vol: 0.2, r: 0.1 };
  close(price({ ...args, type: 'call' }), 4.76, 0.005, 'call');
  close(price({ ...args, type: 'put' }), 0.81, 0.005, 'put');
});

test('put-call parity holds: C - P = S*e^-qT - K*e^-rT', () => {
  const cases = [
    { S: 100, K: 100, T: 1 / 12, vol: 0.3, r: 0, q: 0 },
    { S: 87.5, K: 95, T: 0.75, vol: 0.55, r: 0.04, q: 0.02 },
    { S: 250, K: 180, T: 2, vol: 0.18, r: 0.05, q: 0 },
    { S: 12, K: 40, T: 0.1, vol: 0.9, r: 0.03, q: 0.07 },
  ];
  for (const c of cases) {
    const lhs =
      price({ ...c, type: 'call' }) - price({ ...c, type: 'put' });
    const rhs =
      c.S * Math.exp(-c.q * c.T) - c.K * Math.exp(-c.r * c.T);
    close(lhs, rhs, 1e-6, `parity for S=${c.S} K=${c.K}`);
  }
});

test('conversation reference case: $100 stock, 30-day $100 call, 30% IV', () => {
  const r = evaluate({ S: 100, K: 100, T: 1 / 12, vol: 0.3, type: 'call' });
  close(r.price, 3.455, 0.01, 'price');
  close(r.delta, 0.517, 0.002, 'delta');
  close(r.gamma, 0.046, 0.001, 'gamma');
  close(r.vega, 0.115, 0.001, 'vega per point');
  close(r.theta, -0.0567, 0.001, 'theta per day');
});

test('conversation reference case: same call at $103 and 35% IV', () => {
  close(
    price({ S: 103, K: 100, T: 1 / 12, vol: 0.35, type: 'call' }),
    5.766,
    0.01,
    'post-event value'
  );
});

test('conversation reference case: ATM at inflated 70% IV', () => {
  close(
    price({ S: 100, K: 100, T: 1 / 12, vol: 0.7, type: 'call' }),
    8.046,
    0.01,
    'pre-earnings value'
  );
});

test('at-the-money approximation tracks the exact price', () => {
  const exact = price({ S: 100, K: 100, T: 1 / 12, vol: 0.3, type: 'call' });
  close(atmApproximation(100, 0.3, 1 / 12), exact, 0.02, 'ATM shortcut');
});

test('deltas sit in the right range and respond to moneyness', () => {
  const base = { K: 100, T: 1 / 12, vol: 0.3, type: 'call' };
  const deep = evaluate({ ...base, S: 200 }).delta;
  const atm = evaluate({ ...base, S: 100 }).delta;
  const far = evaluate({ ...base, S: 50 }).delta;
  assert.ok(deep > 0.99, `deep ITM call delta should approach 1, got ${deep}`);
  close(atm, 0.5, 0.05, 'ATM call delta');
  assert.ok(far < 0.01, `far OTM call delta should approach 0, got ${far}`);

  const putDelta = evaluate({ ...base, S: 100, type: 'put' }).delta;
  assert.ok(putDelta < 0 && putDelta > -1, 'put delta is negative');
});

test('higher volatility pulls deltas toward 0.5', () => {
  const otm = { S: 100, K: 110, T: 1 / 12, type: 'call' };
  const lowVol = evaluate({ ...otm, vol: 0.35 }).delta;
  const highVol = evaluate({ ...otm, vol: 0.7 }).delta;
  assert.ok(
    highVol > lowVol,
    `OTM delta should rise with vol: ${lowVol} -> ${highVol}`
  );

  const itm = { S: 100, K: 90, T: 1 / 12, type: 'call' };
  const itmLow = evaluate({ ...itm, vol: 0.35 }).delta;
  const itmHigh = evaluate({ ...itm, vol: 0.7 }).delta;
  assert.ok(
    itmHigh < itmLow,
    `ITM delta should fall with vol: ${itmLow} -> ${itmHigh}`
  );
});

test('gamma and vega are positive and peak near the money', () => {
  const base = { K: 100, T: 1 / 12, vol: 0.3, type: 'call' };
  const atm = evaluate({ ...base, S: 100 });
  const wing = evaluate({ ...base, S: 140 });
  assert.ok(atm.gamma > 0 && atm.vega > 0);
  assert.ok(atm.gamma > wing.gamma, 'gamma peaks ATM');
  assert.ok(atm.vega > wing.vega, 'vega peaks ATM');
});

test('long options decay: theta is negative when rates are zero', () => {
  for (const type of ['call', 'put']) {
    const r = evaluate({ S: 100, K: 100, T: 1 / 12, vol: 0.3, type });
    assert.ok(r.theta < 0, `${type} theta should be negative`);
  }
});

test('gamma is the derivative of delta', () => {
  const base = { S: 100, K: 100, T: 1 / 12, vol: 0.3, type: 'call' };
  const h = 0.01;
  const up = evaluate({ ...base, S: base.S + h }).delta;
  const down = evaluate({ ...base, S: base.S - h }).delta;
  const numeric = (up - down) / (2 * h);
  close(evaluate(base).gamma, numeric, 1e-5, 'gamma vs finite difference');
});

test('delta is the derivative of price', () => {
  const base = { S: 100, K: 105, T: 0.25, vol: 0.4, r: 0.03, type: 'call' };
  const h = 0.001;
  const numeric =
    (price({ ...base, S: base.S + h }) - price({ ...base, S: base.S - h })) /
    (2 * h);
  close(evaluate(base).delta, numeric, 1e-5, 'delta vs finite difference');
});

test('vega is the derivative of price with respect to one vol point', () => {
  const base = { S: 100, K: 100, T: 1 / 12, vol: 0.3, type: 'call' };
  const h = 0.0001;
  const numeric =
    (price({ ...base, vol: base.vol + h }) -
      price({ ...base, vol: base.vol - h })) /
    (2 * h) /
    100;
  close(evaluate(base).vega, numeric, 1e-6, 'vega vs finite difference');
});

test('degenerate inputs collapse to intrinsic without NaN', () => {
  const expired = evaluate({ S: 110, K: 100, T: 0, vol: 0.3, type: 'call' });
  close(expired.price, 10, 1e-9, 'expired ITM call');
  assert.ok(expired.degenerate);
  assert.ok(Number.isFinite(expired.delta));

  const worthless = evaluate({ S: 90, K: 100, T: 0, vol: 0.3, type: 'call' });
  close(worthless.price, 0, 1e-9, 'expired OTM call');

  const zeroVol = evaluate({ S: 110, K: 100, T: 0.5, vol: 0, type: 'call' });
  close(zeroVol.price, 10, 1e-9, 'zero vol call is intrinsic');

  const expiredPut = evaluate({ S: 90, K: 100, T: 0, vol: 0.3, type: 'put' });
  close(expiredPut.price, 10, 1e-9, 'expired ITM put');
});

test('price never falls below intrinsic value', () => {
  for (const S of [40, 80, 95, 100, 105, 160]) {
    for (const type of ['call', 'put']) {
      const r = evaluate({ S, K: 100, T: 1 / 12, vol: 0.3, type });
      assert.ok(
        r.price >= r.intrinsic - 1e-9,
        `${type} at S=${S}: price ${r.price} below intrinsic ${r.intrinsic}`
      );
    }
  }
});

test('implied volatility round-trips', () => {
  const cases = [
    { S: 100, K: 100, T: 1 / 12, vol: 0.3, type: 'call' },
    { S: 100, K: 120, T: 0.5, vol: 0.65, type: 'call' },
    { S: 100, K: 80, T: 0.25, vol: 0.22, r: 0.04, type: 'put' },
    { S: 55.5, K: 60, T: 2 / 12, vol: 1.1, type: 'put' },
  ];
  for (const c of cases) {
    const marketPrice = price(c);
    const recovered = impliedVol({ ...c, marketPrice });
    close(recovered, c.vol, 1e-5, `IV round-trip K=${c.K}`);
  }
});

test('implied volatility returns null when the price has no time value', () => {
  // Deep in-the-money put a week from expiry, trading at parity. Vega is
  // effectively zero here, so no volatility can be inferred. Found by
  // cross-checking against the black-scholes npm package: the solver
  // previously returned its lower bracket (~1e-6), which would display as
  // "0% IV" rather than "cannot determine".
  const parity = price({
    S: 80,
    K: 100,
    T: 7 / 365,
    vol: 0.12,
    r: 0.03,
    type: 'put',
  });
  assert.equal(
    impliedVol({ S: 80, K: 100, T: 7 / 365, r: 0.03, type: 'put', marketPrice: parity }),
    null,
    'parity-priced option should report no recoverable IV'
  );

  // The same strike with genuine time value must still solve.
  const withTimeValue = price({
    S: 80,
    K: 100,
    T: 1,
    vol: 0.45,
    r: 0.03,
    type: 'put',
  });
  const recovered = impliedVol({
    S: 80,
    K: 100,
    T: 1,
    r: 0.03,
    type: 'put',
    marketPrice: withTimeValue,
  });
  close(recovered, 0.45, 1e-5, 'IV still recoverable when vega is meaningful');
});

test('implied volatility returns null for impossible prices', () => {
  const args = { S: 100, K: 100, T: 1 / 12, type: 'call' };
  assert.equal(impliedVol({ ...args, marketPrice: 0 }), null, 'zero price');
  assert.equal(
    impliedVol({ ...args, marketPrice: 500 }),
    null,
    'price above any volatility'
  );
  assert.equal(
    impliedVol({ ...args, T: 0, marketPrice: 5 }),
    null,
    'already expired'
  );
});

test('solveSpotForValue round-trips for calls and puts', () => {
  const call = { K: 100, T: 1 / 12, vol: 0.35, type: 'call' };
  const target = 8.046;
  const spot = solveSpotForValue({ ...call, target, spotHint: 100 });
  close(price({ ...call, S: spot }), target, 1e-5, 'call solve');
  close(spot, 106.4, 0.3, 'matches the breakeven worked out by hand');

  const put = { K: 100, T: 1 / 12, vol: 0.35, type: 'put' };
  const putSpot = solveSpotForValue({ ...put, target: 5, spotHint: 100 });
  close(price({ ...put, S: putSpot }), 5, 1e-5, 'put solve');
});

test('solveSpotForValue returns null when a put cannot reach the target', () => {
  const result = solveSpotForValue({
    K: 100,
    T: 1 / 12,
    vol: 0.3,
    type: 'put',
    target: 250, // above the discounted strike, unreachable
    spotHint: 100,
  });
  assert.equal(result, null);
});

test('expiry breakeven is strike plus or minus premium', () => {
  close(expiryBreakeven({ K: 100, premium: 8.09, type: 'call' }), 108.09, 1e-9);
  close(expiryBreakeven({ K: 100, premium: 8.09, type: 'put' }), 91.91, 1e-9);
});

test('selling before expiry breaks even sooner than holding to expiry', () => {
  const premium = 8.046;
  const atExpiry = expiryBreakeven({ K: 100, premium, type: 'call' });
  const early = solveSpotForValue({
    K: 100,
    T: 1 / 12,
    vol: 0.35,
    type: 'call',
    target: premium,
    spotHint: 100,
  });
  assert.ok(
    early < atExpiry,
    `early exit breakeven ${early} should be below expiry breakeven ${atExpiry}`
  );
});

test('volatility scales with the square root of time', () => {
  close(scaleVol(0.3, 1 / 12), 0.0866, 1e-4, 'monthly');
  close(scaleVol(0.3, 0.25), 0.15, 1e-9, 'quarterly is half of annual');
  close(scaleVol(0.3, 1), 0.3, 1e-9, 'annual');
  // Twelve independent monthly moves compose back to the annual figure.
  close(scaleVol(0.3, 1 / 12) * Math.sqrt(12), 0.3, 1e-9, 'recomposition');
});

test('expectedMoves reproduces the divide-by-16 rule', () => {
  const rows = expectedMoves(100, 0.32);
  const day = rows.find((r) => r.periodsPerYear === 252);
  close(day.pct, 0.32 / Math.sqrt(252), 1e-9, 'daily sigma');
  close(day.pct * 100, 2.016, 0.01, '32% IV implies roughly 2% days');

  const quarter = rows.find((r) => r.periodsPerYear === 4);
  close(quarter.pct, 0.16, 1e-9, 'a quarter is half the annual move');

  const year = rows.find((r) => r.periodsPerYear === 1);
  close(year.move, 32, 1e-9, 'annual move on a $100 stock');
  close(year.low, 68, 1e-9);
  close(year.high, 132, 1e-9);
});

test('eventScenario reproduces the worked IV-crush example', () => {
  const s = eventScenario({
    S: 100,
    K: 100,
    T: 1 / 12,
    volBefore: 0.7,
    volAfter: 0.35,
    type: 'call',
  });
  close(s.paid, 8.046, 0.01, 'premium paid at inflated IV');
  // 4.029 is the exact Black-Scholes value. The 0.4*S*vol*sqrt(T) shortcut
  // gives 4.045 here, so do not use the approximation as an expectation.
  close(s.valueIfFlat, 4.029, 0.01, 'value if the stock does not move');
  assert.ok(s.crushLoss < 0, 'crush is a loss when spot is unchanged');
  close(s.breakeven, 106.4, 0.3, 'breakeven after the crush');
  close(s.requiredMovePct, 0.064, 0.005, 'implied move being charged');
});

test('eventScenario respects an explicitly supplied premium', () => {
  const s = eventScenario({
    S: 100,
    K: 100,
    T: 1 / 12,
    volBefore: 0.7,
    volAfter: 0.35,
    type: 'call',
    premium: 10,
  });
  close(s.paid, 10, 1e-9, 'uses what the user actually paid');
  assert.ok(
    s.breakeven > 106.4,
    'overpaying should push the breakeven further out'
  );
});
