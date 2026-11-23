/*
 * Black-Scholes pricing, Greeks and solvers.
 *
 * Pure functions only. Nothing here touches the DOM, reads globals or
 * performs I/O, so it can be unit tested under plain `node --test`.
 * See ../test/bs.test.js and ../DESIGN.md.
 *
 * Conventions used throughout this file:
 *   S    spot price of the underlying
 *   K    strike
 *   T    time to expiry in YEARS (calendar days / 365)
 *   vol  implied volatility as a decimal, annualised (0.30 means 30%)
 *   r    continuously compounded risk-free rate, decimal
 *   q    continuous dividend yield, decimal
 *
 * Vega, theta and rho are returned in the units traders actually quote:
 * vega and rho per ONE POINT of input (1% vol, 1% rate), theta per
 * CALENDAR DAY. The raw per-unit-per-year values are divided down inside
 * evaluate() so callers never have to remember the scaling.
 */

const INV_SQRT_2PI = 0.3989422804014327; // 1 / sqrt(2*pi)

/** Standard normal probability density. The bell curve itself. */
export function normPdf(x) {
  if (!Number.isFinite(x)) return 0;
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Standard normal cumulative distribution: the area under the bell curve
 * to the left of x.
 *
 * Zelen & Severo rational approximation (Abramowitz & Stegun 26.2.17),
 * absolute error below 7.5e-8, which is far tighter than any option
 * quote needs. Evaluated on |x| and reflected so the tail being summed
 * is always the small one, which keeps the relative error low deep in
 * the wings where naive implementations lose precision.
 */
export function normCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const poly =
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upperTail = normPdf(ax) * poly; // approximately 1 - N(ax)
  return x >= 0 ? 1 - upperTail : upperTail;
}

/**
 * Price one European option and all of its first and second order Greeks
 * in a single pass, so d1/d2 and the normal functions are evaluated once.
 *
 * Returns { price, delta, gamma, vega, theta, rho, d1, d2, intrinsic,
 *           extrinsic, degenerate }.
 *
 * Degenerate inputs (T <= 0 or vol <= 0) collapse the model to discounted
 * intrinsic value rather than producing NaN, because the UI lets a user
 * slide expiry to zero and that must not blow up mid-render.
 */
export function evaluate({ S, K, T, vol, r = 0, q = 0, type = 'call' }) {
  const isCall = type !== 'put';

  if (!(S > 0) || !(K > 0)) return degenerate(0, isCall);

  const tt = Math.max(T, 0);
  const dfR = Math.exp(-r * tt);
  const dfQ = Math.exp(-q * tt);
  const fwd = S * dfQ; // present value of receiving the share at expiry
  const pvK = K * dfR; // present value of paying the strike at expiry
  const floor = isCall ? Math.max(fwd - pvK, 0) : Math.max(pvK - fwd, 0);

  if (!(tt > 0) || !(vol > 0)) {
    const inTheMoney = isCall ? fwd > pvK : fwd < pvK;
    return {
      price: floor,
      delta: inTheMoney ? (isCall ? dfQ : -dfQ) : 0,
      gamma: 0,
      vega: 0,
      theta: 0,
      rho: 0,
      d1: NaN,
      d2: NaN,
      intrinsic: isCall ? Math.max(S - K, 0) : Math.max(K - S, 0),
      extrinsic: 0,
      degenerate: true,
    };
  }

  const sqrtT = Math.sqrt(tt);
  const volSqrtT = vol * sqrtT;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * vol * vol) * tt) / volSqrtT;
  const d2 = d1 - volSqrtT;

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nmd1 = 1 - nd1; // N(-d1)
  const nmd2 = 1 - nd2; // N(-d2)
  const pdf1 = normPdf(d1);

  const price = isCall ? fwd * nd1 - pvK * nd2 : pvK * nmd2 - fwd * nmd1;

  const delta = isCall ? dfQ * nd1 : -dfQ * nmd1;
  const gamma = (dfQ * pdf1) / (S * volSqrtT);

  // Per one point of volatility, i.e. a move from 30% to 31%.
  const vega = (fwd * pdf1 * sqrtT) / 100;

  // Per calendar day. The first term is the decay of optionality and is
  // always negative for a long position; the rate and dividend terms can
  // push theta positive for a deep in-the-money put or a high-yield name.
  const thetaYear = isCall
    ? -(fwd * pdf1 * vol) / (2 * sqrtT) - r * pvK * nd2 + q * fwd * nd1
    : -(fwd * pdf1 * vol) / (2 * sqrtT) + r * pvK * nmd2 - q * fwd * nmd1;
  const theta = thetaYear / 365;

  // Per one point of interest rate.
  const rho = (isCall ? tt * pvK * nd2 : -tt * pvK * nmd2) / 100;

  const intrinsic = isCall ? Math.max(S - K, 0) : Math.max(K - S, 0);

  return {
    price,
    delta,
    gamma,
    vega,
    theta,
    rho,
    d1,
    d2,
    intrinsic,
    extrinsic: price - intrinsic,
    degenerate: false,
  };
}

function degenerate(price, isCall) {
  return {
    price,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    rho: 0,
    d1: NaN,
    d2: NaN,
    intrinsic: 0,
    extrinsic: 0,
    degenerate: true,
  };
}

/** Convenience wrapper when only the number is wanted. */
export function price(params) {
  return evaluate(params).price;
}

/**
 * Closed-form approximation for an at-the-money option:
 *
 *     C ~= 0.4 * S * vol * sqrt(T)
 *
 * The 0.4 is the height of the standard normal at its centre (0.3989).
 * Exposed because the page teaches this shortcut and showing it beside
 * the exact figure makes the size of the approximation error concrete.
 * Accurate to a few cents for short-dated near-the-money options and
 * meaningless once the strike is far from spot.
 */
export function atmApproximation(S, vol, T) {
  return INV_SQRT_2PI * S * vol * Math.sqrt(Math.max(T, 0));
}

/**
 * Generic bisection for a function that is monotone over [lo, hi].
 * Returns null when the target is not bracketed, rather than returning a
 * confidently wrong endpoint.
 */
function bisect(f, lo, hi, target, { iterations = 160, tolerance = 1e-9 } = {}) {
  let flo = f(lo) - target;
  let fhi = f(hi) - target;
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  if (flo > 0 === fhi > 0) return null; // same sign, no root in range

  let a = lo;
  let b = hi;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (a + b);
    const fmid = f(mid) - target;
    if (Math.abs(fmid) < tolerance || b - a < tolerance) return mid;
    if (fmid > 0 === flo > 0) {
      a = mid;
      flo = fmid;
    } else {
      b = mid;
    }
  }
  return 0.5 * (a + b);
}

/**
 * Back out implied volatility from a traded price.
 *
 * This is the inverse of the pricing formula and the reason the word
 * "implied" exists: nobody publishes a volatility, it is solved for from
 * the price the market is charging.
 *
 * Bisection rather than Newton-Raphson. Newton converges faster but
 * stalls when vega approaches zero, which is exactly the deep
 * out-of-the-money and near-expiry territory this page encourages users
 * to poke at. 160 bisection steps cost microseconds and never diverge.
 *
 * Returns null when the price is outside the no-arbitrage range, which
 * usually means a typo or a stale quote rather than a free lunch.
 */
export function impliedVol({
  S,
  K,
  T,
  r = 0,
  q = 0,
  type = 'call',
  marketPrice,
}) {
  if (!(marketPrice > 0) || !(T > 0) || !(S > 0) || !(K > 0)) return null;

  // The no-arbitrage floor: what the option is worth at zero volatility,
  // i.e. discounted intrinsic value.
  const floor = evaluate({ S, K, T, vol: 0, r, q, type }).price;

  // A price at or barely above that floor carries no time value, so vega is
  // effectively zero and volatility has no influence on it. Implied
  // volatility is genuinely not recoverable from such a quote.
  //
  // This case is not theoretical: a deep in-the-money option close to expiry
  // trades at parity. Bisection would happily converge on its lower bracket
  // and hand back something like 0.000001, which the UI would render as
  // "0% IV" -- a confidently wrong answer that could make a user think a
  // wildly expensive option was free of volatility premium. Returning null
  // forces the caller to say "cannot determine" instead.
  const epsilon = Math.max(1e-4, S * 1e-6);
  if (marketPrice <= floor + epsilon) return null;

  const f = (v) => evaluate({ S, K, T, vol: v, r, q, type }).price;
  const vol = bisect(f, 1e-6, 5, marketPrice, { tolerance: 1e-8 });

  // Guard the lower bracket as well: no traded option implies 0.01% vol, so
  // a solution pinned there means the solver found no real root.
  if (vol == null || vol < 1e-4) return null;
  return vol;
}

/**
 * Solve for the spot price at which the option is worth `target`, holding
 * time and volatility fixed.
 *
 * This is the breakeven calculation a broker will not do for you: it
 * answers "where does the stock have to be, on this date, at this
 * volatility, for me to get my premium back if I SELL rather than
 * exercise". Call value rises monotonically in S and put value falls, so
 * bisection is reliable.
 *
 * A put has a ceiling (its value cannot exceed the discounted strike), so
 * a target above that ceiling has no solution and null is returned.
 */
export function solveSpotForValue({
  K,
  T,
  vol,
  r = 0,
  q = 0,
  type = 'call',
  target,
  spotHint = null,
}) {
  if (!(target >= 0) || !(K > 0)) return null;
  const isCall = type !== 'put';
  const f = (s) => evaluate({ S: s, K, T, vol, r, q, type }).price;

  const low = 1e-6;
  if (isCall) {
    // Call value is unbounded above, so grow the upper bracket until the
    // target is enclosed. Anchored on the strike and any known spot so a
    // far out-of-the-money position still brackets in a few doublings.
    let high = Math.max(K, spotHint || 0) * 2 + 10;
    for (let i = 0; i < 60 && f(high) < target; i++) high *= 2;
    return bisect(f, low, high, target, { tolerance: 1e-7 });
  }
  // Put value is highest as spot approaches zero and decays to zero as
  // spot rises, so the bracket is fixed at both ends.
  const ceiling = f(low);
  if (target > ceiling) return null;
  let high = Math.max(K, spotHint || 0) * 4 + 10;
  for (let i = 0; i < 60 && f(high) > target; i++) high *= 2;
  return bisect(f, low, high, target, { tolerance: 1e-7 });
}

/**
 * Breakeven at expiry: strike plus premium for a call, strike minus
 * premium for a put.
 *
 * This is the number brokers display, and it is pure arithmetic with no
 * model in it, because at expiry every Greek has decayed to nothing and
 * the option is worth exactly its intrinsic value. It is also the wrong
 * number for anyone who intends to sell before expiry, which is why the
 * page shows it beside solveSpotForValue().
 */
export function expiryBreakeven({ K, premium, type = 'call' }) {
  return type !== 'put' ? K + premium : K - premium;
}

/**
 * Volatility scaled from annual to an arbitrary horizon.
 *
 * Volatility grows with the SQUARE ROOT of time, not with time, because
 * successive returns are modelled as independent: variances add, standard
 * deviations do not. A twelfth of a year therefore carries 1/sqrt(12) of
 * the annual movement, roughly 29%, not 1/12 of it.
 */
export function scaleVol(annualVol, yearFraction) {
  return annualVol * Math.sqrt(Math.max(yearFraction, 0));
}

/**
 * One standard deviation of expected movement over a set of standard
 * horizons, for the teaching table.
 *
 * Each horizon is expressed as a count of periods per year, so the period
 * count and the period length always multiply to one year and the scaling
 * stays internally consistent. The day row uses 252 TRADING days, which is
 * the market convention and the origin of the "divide annual IV by 16"
 * rule of thumb, since sqrt(252) = 15.87.
 *
 * Note this differs from the day count used for T in pricing, which is
 * calendar days over 365. Both conventions are standard in their own
 * context; see DESIGN.md for why the inconsistency is deliberate.
 */
export function expectedMoves(S, annualVol) {
  const horizons = [
    { label: '1 trading day', periodsPerYear: 252 },
    { label: '1 week', periodsPerYear: 52 },
    { label: '1 month', periodsPerYear: 12 },
    { label: '1 quarter', periodsPerYear: 4 },
    { label: '1 year', periodsPerYear: 1 },
  ];
  return horizons.map((h) => {
    const fraction = 1 / h.periodsPerYear;
    const root = Math.sqrt(fraction);
    const sigma = annualVol * root;
    return {
      ...h,
      fraction,
      root,
      pct: sigma,
      move: S * sigma,
      low: S * (1 - sigma),
      high: S * (1 + sigma),
    };
  });
}

/**
 * The full event / volatility-crush scenario.
 *
 * Models the trade a beginner most often loses money on: buying a call or
 * put into a scheduled event (earnings, an FDA decision, a ruling) when
 * implied volatility has been bid up, then watching the option lose value
 * after the news despite being right about direction, because implied
 * volatility reverts to normal.
 *
 * `requiredMove` is the headline output. It is approximately the move the
 * market is charging for, so a user can compare it against their own view
 * instead of only picking a direction.
 */
export function eventScenario({
  S,
  K,
  T,
  volBefore,
  volAfter,
  r = 0,
  q = 0,
  type = 'call',
  premium = null,
  exitT = null,
}) {
  const paid =
    premium != null
      ? premium
      : evaluate({ S, K, T, vol: volBefore, r, q, type }).price;
  const tExit = exitT != null ? exitT : T;

  const flat = evaluate({ S, K, T: tExit, vol: volAfter, r, q, type }).price;
  const breakeven = solveSpotForValue({
    K,
    T: tExit,
    vol: volAfter,
    r,
    q,
    type,
    target: paid,
    spotHint: S,
  });

  return {
    paid,
    valueIfFlat: flat,
    crushLoss: flat - paid,
    crushLossPct: paid > 0 ? (flat - paid) / paid : 0,
    breakeven,
    requiredMove: breakeven == null ? null : breakeven - S,
    requiredMovePct: breakeven == null || !(S > 0) ? null : breakeven / S - 1,
  };
}
