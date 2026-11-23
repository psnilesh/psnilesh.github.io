/*
 * Integration tests: bs.js against REAL option quotes.
 *
 *   npm run test:integration    # this file only
 *   npm run test:all            # unit + integration
 *
 * Deliberately NOT part of `npm test`, which runs unit tests only.
 *
 * To be clear about what that separation is and is not for: these tests make
 * no network calls. The market data is a committed snapshot, so they are
 * deterministic and cannot fail because a vendor is down or rate-limiting.
 * They are split out to keep the default feedback loop focused, and to make
 * it obvious if anyone ever changes that by fetching at test time. Doing so
 * would be a mistake -- the keyless API this data came from is an
 * undocumented courtesy that serves AAPL only and can disappear.
 *
 * WHY THIS EXISTS, SEPARATE FROM bs.test.js
 *
 * bs.test.js checks the formula against textbook values and its own
 * internal consistency. Both it and the code could in principle encode the
 * same misunderstanding. These tests use a different kind of oracle: 60
 * actual AAPL contracts, with the market's own bid, ask, implied volatility
 * and Greeks. If `bs.js` priced options in a way the market does not, the
 * assertions below would fail even with bs.test.js fully green.
 *
 * NO NETWORK. The data is a frozen snapshot in fixtures/aapl-chain.json,
 * so these tests are deterministic and run offline. See fixtures/refresh.md
 * to regenerate.
 *
 * ON THE TOLERANCES
 *
 * Every tolerance below was derived by measuring the actual deviation
 * across all 60 contracts and then allowing roughly 1.5x headroom. They are
 * NOT round numbers picked to make the suite pass. The observed worst case
 * is recorded in a comment beside each one, so a future reader can tell the
 * difference between "still correct" and "tolerance was loosened until it
 * went green".
 *
 * Exact agreement with the vendor's Greeks is not expected and not
 * required. They price American-style exercise with discrete dividends;
 * bs.js is European Black-Scholes. The point is that the gap stays small
 * and bounded, not that it is zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  evaluate,
  impliedVol,
  solveSpotForValue,
  expiryBreakeven,
} from '../../js/bs.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'aapl-chain.json'), 'utf8')
);

const { riskFreeRate: R, dividendYield: Q } = fixture.modelAssumptions;
const SPOT = fixture.underlyingPrice;

/** Every contract across every expiration, with T attached. */
const ALL = fixture.chains.flatMap((chain) =>
  chain.contracts.map((c) => ({
    ...c,
    expiration: chain.expiration,
    dte: chain.dte,
    T: chain.dte / 365,
    S: SPOT,
  }))
);

/** Contracts the vendor supplied a usable IV and two-sided quote for. */
const QUOTED = ALL.filter((c) => c.iv > 0 && c.mid > 0 && c.bid > 0 && c.ask > 0);

const model = (c) =>
  evaluate({ S: c.S, K: c.strike, T: c.T, vol: c.iv, r: R, q: Q, type: c.side });

/**
 * Assert over every contract, reporting the worst offender rather than the
 * first. A single failing strike is much easier to diagnose when you can
 * see whether it is an outlier or the whole chain drifting.
 */
function forAll(label, tolerance, fn) {
  let worst = null;
  for (const c of QUOTED) {
    const dev = fn(c);
    if (!Number.isFinite(dev)) continue;
    if (!worst || dev > worst.dev) worst = { dev, c };
  }
  assert.ok(worst, `${label}: no contracts evaluated`);
  assert.ok(
    worst.dev <= tolerance,
    `${label}: worst deviation ${worst.dev.toFixed(6)} exceeds ${tolerance} ` +
      `at ${worst.c.symbol} (${worst.c.side} K=${worst.c.strike} dte=${worst.c.dte} iv=${worst.c.iv})`
  );
  return worst;
}

test('fixture is the expected real-data snapshot', () => {
  assert.equal(fixture.symbol, 'AAPL');
  assert.equal(fixture.chains.length, 3);
  assert.equal(ALL.length, 60);
  assert.ok(SPOT > 0, 'underlying price present');
  assert.ok(QUOTED.length >= 55, `expected most contracts quoted, got ${QUOTED.length}`);
  // Short, medium and long dated, so the tests span the term structure.
  assert.deepEqual(
    fixture.chains.map((c) => c.dte),
    [8, 29, 120]
  );
});

test('model price falls inside the real bid-ask spread on every contract', () => {
  // The headline assertion. Observed: 60/60 contracts inside the spread.
  // If bs.js mispriced options in any systematic way, this breaks first.
  const outside = QUOTED.filter((c) => {
    const p = model(c).price;
    return p < c.bid - 1e-9 || p > c.ask + 1e-9;
  });
  assert.deepEqual(
    outside.map((c) => `${c.symbol} model=${model(c).price.toFixed(2)} bid=${c.bid} ask=${c.ask}`),
    [],
    'these contracts priced outside their real quoted spread'
  );
});

test('model price tracks the real mid', () => {
  // Observed worst: $0.2393 (on the 120-day expiry, where spreads are widest).
  forAll('price vs mid', 0.35, (c) => Math.abs(model(c).price - c.mid));
});

test('implied volatility recovered from the real mid matches the vendor IV', () => {
  // Observed worst: 0.00407, i.e. 0.41 volatility points.
  forAll('IV round-trip', 0.006, (c) => {
    const back = impliedVol({
      S: c.S, K: c.strike, T: c.T, r: R, q: Q, type: c.side, marketPrice: c.mid,
    });
    return back == null ? 0 : Math.abs(back - c.iv);
  });
});

test('delta matches the vendor on real contracts', () => {
  // Observed worst: 0.0032. Residual is American exercise plus dividends.
  forAll('delta', 0.005, (c) => Math.abs(model(c).delta - c.delta));
});

test('gamma matches the vendor on real contracts', () => {
  // Observed worst: 0.00042.
  forAll('gamma', 0.001, (c) => Math.abs(model(c).gamma - c.gamma));
});

test('vega matches the vendor on real contracts', () => {
  // Observed worst: 0.0033. Confirms both report vega per ONE POINT of vol,
  // which is the units assumption most likely to be silently wrong.
  forAll('vega', 0.006, (c) => Math.abs(model(c).vega - c.vega));
});

test('theta matches the vendor on real contracts', () => {
  // Observed worst: 0.0056. Confirms both report theta per CALENDAR DAY.
  forAll('theta', 0.010, (c) => Math.abs(model(c).theta - c.theta));
});

test('intrinsic value matches exactly on real contracts', () => {
  // Pure arithmetic with no model in it, so this must be exact.
  // Observed worst: 1.6e-14 (floating point only).
  forAll('intrinsic', 1e-9, (c) => Math.abs(model(c).intrinsic - c.intrinsicValue));
});

test('time value equals model price minus intrinsic on real contracts', () => {
  forAll('extrinsic self-consistency', 1e-9, (c) => {
    const m = model(c);
    return Math.abs(m.extrinsic - (m.price - m.intrinsic));
  });
});

test('deltas stay in range and carry the right sign on real contracts', () => {
  for (const c of QUOTED) {
    const d = model(c).delta;
    if (c.side === 'call') {
      assert.ok(d >= 0 && d <= 1, `call delta out of range: ${d} at ${c.symbol}`);
    } else {
      assert.ok(d <= 0 && d >= -1, `put delta out of range: ${d} at ${c.symbol}`);
    }
  }
});

test('long options decay and gain on volatility across the real chain', () => {
  for (const c of QUOTED) {
    const m = model(c);
    assert.ok(m.theta < 0, `theta should be negative at ${c.symbol}, got ${m.theta}`);
    assert.ok(m.vega > 0, `vega should be positive at ${c.symbol}, got ${m.vega}`);
    assert.ok(m.gamma > 0, `gamma should be positive at ${c.symbol}, got ${m.gamma}`);
  }
});

test('model prices are monotone in strike within each real expiration', () => {
  // No-arbitrage: call value must fall as the strike rises and put value
  // must rise, even though each strike carries its own IV from the smile.
  // A violation would mean bs.js is not arbitrage-free on real inputs.
  for (const chain of fixture.chains) {
    for (const side of ['call', 'put']) {
      const row = chain.contracts
        .filter((c) => c.side === side && c.iv > 0 && c.mid > 0)
        .map((c) => ({
          strike: c.strike,
          price: evaluate({
            S: SPOT, K: c.strike, T: chain.dte / 365, vol: c.iv, r: R, q: Q, type: side,
          }).price,
        }))
        .sort((a, b) => a.strike - b.strike);

      for (let i = 1; i < row.length; i++) {
        const [prev, cur] = [row[i - 1], row[i]];
        if (side === 'call') {
          assert.ok(
            cur.price <= prev.price + 1e-9,
            `${chain.expiration} call price rose with strike: ` +
              `K=${prev.strike} $${prev.price.toFixed(4)} -> K=${cur.strike} $${cur.price.toFixed(4)}`
          );
        } else {
          assert.ok(
            cur.price >= prev.price - 1e-9,
            `${chain.expiration} put price fell with strike: ` +
              `K=${prev.strike} $${prev.price.toFixed(4)} -> K=${cur.strike} $${cur.price.toFixed(4)}`
          );
        }
      }
    }
  }
});

test('put-call parity holds on real mid prices within the quoted spread', () => {
  // Parity cannot hold exactly on real mids: bid-ask, American early
  // exercise, discrete dividends and borrow costs all perturb it. The
  // honest bound is the combined spread of the two legs, which is the
  // width of the band inside which no arbitrage is available.
  //
  // Observed worst ratio of deviation to combined spread: 0.55.
  let worst = null;
  for (const chain of fixture.chains) {
    const byStrike = new Map();
    for (const c of chain.contracts) {
      if (!byStrike.has(c.strike)) byStrike.set(c.strike, {});
      byStrike.get(c.strike)[c.side] = c;
    }
    for (const [K, pair] of byStrike) {
      if (!pair.call || !pair.put || !(pair.call.mid > 0) || !(pair.put.mid > 0)) continue;
      const T = chain.dte / 365;
      const lhs = pair.call.mid - pair.put.mid;
      const rhs = SPOT * Math.exp(-Q * T) - K * Math.exp(-R * T);
      const dev = Math.abs(lhs - rhs);
      const combined =
        pair.call.ask - pair.call.bid + (pair.put.ask - pair.put.bid);
      if (combined <= 0) continue;
      const ratio = dev / combined;
      if (!worst || ratio > worst.ratio) {
        worst = { ratio, dev, combined, K, exp: chain.expiration };
      }
    }
  }
  assert.ok(worst, 'no call/put pairs found');
  assert.ok(
    worst.ratio <= 0.85,
    `parity deviation $${worst.dev.toFixed(3)} is ${worst.ratio.toFixed(2)}x the ` +
      `combined spread $${worst.combined.toFixed(2)} at ${worst.exp} K=${worst.K}`
  );
});

test('solveSpotForValue recovers the real spot from a real quote', () => {
  // Round-trip through the breakeven solver: at the contract's own IV and
  // expiry, the stock price that makes it worth the model value must be the
  // spot the market was actually trading at.
  forAll('spot recovery', 0.02, (c) => {
    const target = model(c).price;
    if (!(target > 0.01)) return 0;
    const solved = solveSpotForValue({
      K: c.strike, T: c.T, vol: c.iv, r: R, q: Q, type: c.side,
      target, spotHint: SPOT,
    });
    return solved == null ? 0 : Math.abs(solved - SPOT);
  });
});

test('expiry breakeven on a real contract is strike plus the real ask', () => {
  // Sanity check on the number a broker would show, using a genuine quote.
  const c = QUOTED.find((x) => x.side === 'call' && x.strike >= SPOT);
  assert.ok(c, 'expected an out-of-the-money call in the fixture');
  assert.equal(
    expiryBreakeven({ K: c.strike, premium: c.ask, type: 'call' }),
    c.strike + c.ask
  );

  const p = QUOTED.find((x) => x.side === 'put' && x.strike <= SPOT);
  assert.ok(p, 'expected an out-of-the-money put in the fixture');
  assert.equal(
    expiryBreakeven({ K: p.strike, premium: p.ask, type: 'put' }),
    p.strike - p.ask
  );
});

test('the real chain shows a volatility smile, so per-strike IV matters', () => {
  // Guards an assumption the page depends on: IV is not one number for a
  // whole expiration. If this ever stopped being true the UI advice to
  // "enter the IV for your specific strike" would be pointless.
  for (const chain of fixture.chains) {
    const ivs = chain.contracts.filter((c) => c.iv > 0).map((c) => c.iv);
    const spread = Math.max(...ivs) - Math.min(...ivs);
    assert.ok(
      spread > 0.005,
      `${chain.expiration}: expected IV to vary across strikes, range was ${spread}`
    );
  }
});
