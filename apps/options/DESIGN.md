# Options calculator — design notes

Served at `/apps/options/`. A single-page options pricing and teaching tool:
it prices one call or put, shows the Greeks with plain-English consequences,
and answers the question a broker will not — where does the stock have to be
for you to break even if you **sell** the option rather than exercise it,
after implied volatility reverts to normal.

This document is the handoff for anyone (human or agent) picking the app up.
It records what was decided and *why*, so the reasoning does not have to be
rediscovered from the code.

---

## 1. Scope

**In scope.** One leg: a single call or put, bought or sold, with a contract
count. Manual input of every parameter. Pricing, Greeks, a payoff chart with
exit-date and exit-IV controls, two breakeven figures side by side, a
volatility-crush scenario, and an expected-move table.

**Deliberately out of scope.**

| Not built | Why |
|---|---|
| Multi-leg spreads, straddles, condors | The owner trades single legs. Adding legs turns the model from one object into a list and roughly doubles the UI. Revisit when spreads are actually traded. |
| Live market quotes | A static GitHub Pages site cannot hold a secret, so an embedded API key is a published key. See `js/quotes.js` for the three honest paths forward. |
| American-style early exercise | Black-Scholes prices European options. The gap matters mainly for deep ITM puts and pre-dividend calls, and is disclosed on the page. |
| Volatility smile / per-strike surface | The user enters the IV for the specific strike being considered, which sidesteps it. |
| Position tracking, portfolios, P&L history | This is a pre-trade decision tool, not a book. |

---

## 2. Decision log

Each of these was a real fork, with the reasoning that settled it.

**Modular folder, not one big file.** An earlier draft was a single
self-contained HTML file. Rejected because it mixed pricing mathematics,
rendering and markup in 600+ lines, and crucially made the mathematics
untestable. The split exists so `bs.js` can be exercised by `node --test`
without a DOM.

**Chart.js from npm, not a hand-rolled SVG chart.** An earlier draft
hand-rolled about 200 lines of SVG, including axis tick selection and hover
interpolation. Replaced on the principle of not reinventing a solved problem:
Chart.js has roughly 18M weekly downloads and has already handled the edge
cases that hand-rolled axis code gets wrong.

**Own Black-Scholes module, despite the above.** The same "use a library"
principle was checked against the available npm options-math packages and
pointed the other way. `black-scholes` (~1,300 weekly downloads), `greeks`
(~390) and `implied-volatility` (~390) are single-author v1.0.0 packages with
a tiny fraction of Chart.js's exposure, and none of them provide the
solve-for-spot breakeven this page is built around. `bs.js` is verified
against the John C. Hull textbook reference values plus put-call parity, which
is stronger evidence than the download counts offered. **If you swap it for a
package, port `test/bs.test.js` first and make it pass.**

**Self-hosted vendor bundles, not a CDN.** `.eleventy.js` copies the Chart.js
and annotation UMD builds from `node_modules` into `apps/options/vendor/`.
This pins the version in `package.json`, removes a runtime dependency on a
third party's uptime, and avoids introducing a bundler to a site that has
never had one.

**UMD globals, not ES module imports, for the vendor code.** The UMD builds
load as classic `<script>` tags and expose `window.Chart` and
`window['chartjs-plugin-annotation']`. Using the ESM builds instead would
require either an import map or a bundler. Chart.js must load first; the
plugin reads `Chart.helpers` at definition time.

**Nested `package.json` with `"type": "module"`.** `apps/options/package.json`
scopes ES module semantics to this folder. The repo root must stay CommonJS
because `.eleventy.js` uses `module.exports`. Without the nested file,
`node --test` reads `js/bs.js` as CommonJS and the `export` keyword throws.

**`pageCss` front-matter hook.** `_includes/head.njk` gained a conditional
`<link>` driven by a `pageCss` front-matter key. This lets apps under `/apps/`
ship their own stylesheet without being folded into the site's Sass build, and
is reusable by any future app.

**State in the URL hash.** Every input is mirrored into the hash via
`history.replaceState`, so a configured position is bookmarkable and
shareable. `replaceState` rather than assigning `location.hash`, because
dragging a slider would otherwise push hundreds of entries onto the back
button. A `hashchange` listener re-hydrates the form, since a hash-only change
does not reload the document — without it, pasting a shared link while already
on the page silently showed stale values. That was a real bug found in
browser testing.

---

## 3. File map

```
apps/options/
  index.html        Eleventy template. Markup and the explainer prose only.
                    Front matter sets layout, permalink and pageCss.
  css/options.css   All styles, scoped under .oc. Plain CSS, not Sass.
  js/
    bs.js           Pricing, Greeks, solvers. PURE. No DOM, no globals, no I/O.
    chart.js        Chart.js configuration and the payoff-chart wrapper.
    quotes.js       Quote provider seam. Manual-only today.
    app.js          Wiring: reads the form, calls bs.js, writes the DOM.
  test/
    bs.test.js            Unit tests: formula vs textbook values and itself.
    ui.test.js            app.js + chart.js wiring, in jsdom.
    helpers/
      mount.js            Mounts real index.html in jsdom with a Chart.js stub.
    integration/
      market-data.test.js Formula vs 60 REAL AAPL quotes. Offline.
    fixtures/
      aapl-chain.json     Frozen real-market snapshot. Do not hand-edit.
      refresh.md          How to regenerate it, and how to re-derive tolerances.
                    None of test/ is copied into the built site.
  package.json      Scopes "type": "module" to this folder.
  DESIGN.md         This file. Excluded from the build via .eleventyignore.
  vendor/           Build output only; not in the repo. See .eleventy.js.
```

**Dependency direction is strictly one way:**

```
app.js  ->  bs.js      (numbers)
app.js  ->  chart.js   (rendering)
app.js  ->  quotes.js  (input)
```

`bs.js` imports nothing. `chart.js` knows no option mathematics — `app.js`
hands it finished `{x, y}` points. Keep it that way: the separation is what
makes the mathematics testable and the chart library swappable.

---

## 4. Conventions

Getting these wrong is the most likely source of a subtle, plausible-looking
error.

| Quantity | Convention |
|---|---|
| `T` in `bs.js` | Years, as **calendar days / 365** |
| `vol`, `r`, `q` | Decimals (`0.30`), **not** percentages |
| Form inputs for IV / rates | Percentages; `app.js` divides by 100 |
| `vega`, `rho` | Per **one point** (1%) of input — divided by 100 inside `evaluate()` |
| `theta` | Per **calendar day** — divided by 365 inside `evaluate()` |
| `delta`, `gamma` | Raw, per $1 of underlying |
| Greek signs | `bs.js` always returns the **long** position. `app.js` multiplies by `sideSign` for display. |
| Prices | Per share. `app.js` multiplies by `contracts * 100` for totals. |

### The deliberate day-count inconsistency

Pricing uses calendar days over 365. The expected-move table uses **trading**
periods: 252 days, 52 weeks, 12 months, 4 quarters. Both are standard in their
own context, and the 252 figure is what produces the familiar "divide annual
IV by 16" rule, since `sqrt(252) = 15.87`.

The visible consequence: a "1 month" row shows `1/12` of a year (30.4 days)
while a 30-day option prices at `30/365`. A 30-day at-the-money call at 30% IV
is therefore \$3.43 here, where a worked example using `T = 1/12` gives \$3.45.
Both are right for their own day count. **Do not "fix" one to match the other**
without deciding which convention the whole page should adopt.

---

## 5. Module contracts

### `bs.js`

```js
evaluate({ S, K, T, vol, r=0, q=0, type='call' })
  -> { price, delta, gamma, vega, theta, rho, d1, d2,
       intrinsic, extrinsic, degenerate }
```

Single pass: `d1`/`d2` and the normal functions are evaluated once. Degenerate
inputs (`T <= 0` or `vol <= 0`) return discounted intrinsic value with
`degenerate: true` rather than `NaN`, because the UI lets a user slide expiry
to zero and that must not break mid-render.

```js
impliedVol({ S, K, T, r, q, type, marketPrice })  -> number | null
solveSpotForValue({ K, T, vol, r, q, type, target, spotHint }) -> number | null
```

Both use **bisection, not Newton-Raphson**. Newton converges faster but stalls
when vega approaches zero, which is exactly the deep-OTM and near-expiry
territory this page invites users to explore. 160 bisection steps cost
microseconds and never diverge. Both return `null` when the target is not
bracketed — a put's value is capped at the discounted strike, so a target
above that genuinely has no solution. **Callers must handle `null`.**

Also exported: `price`, `atmApproximation`, `expiryBreakeven`, `scaleVol`,
`expectedMoves`, `eventScenario`, `normCdf`, `normPdf`.

`normCdf` is the Zelen & Severo rational approximation (Abramowitz & Stegun
26.2.17), absolute error below 7.5e-8, evaluated on `|x|` and reflected so the
summed tail is always the small one.

### `chart.js`

```js
createPayoffChart(canvas) -> { update(spec), destroy(), chart }

spec = {
  series: [{ id, label, points: [{x, y}], color, dashed, width }],
  vLines: [{ value, label, color, position }],
  hLines: [{ value, label, color, position }],
  xLabel, yLabel,
}
```

`position` accepts `'start'`, `'center'`, `'end'` or a percentage string such
as `'18%'`. Percentages are used to stagger the spot / strike / breakeven
labels, which otherwise overlap into an unreadable smear whenever those three
prices sit close together. A fixed pixel `yAdjust` was tried first and pushed
labels outside the plot area when the y-range changed.

Chart animation is **off**. Not a style preference: the sliders rebuild the
chart on every input event, and tweening makes dragging feel laggy and
misrepresents intermediate states.

### `quotes.js`

```js
register({ id, label, supportsChain, async quote(symbol) })
quote(providerId, symbol) -> { spot, asOf, chain? } | null
```

`quote()` must resolve to `null` for the ordinary "no data" case rather than
throwing, so the UI falls back to the form silently. See the header comment in
the file for the three viable routes to live data and why none is implemented.

---

## 6. Working on it

```bash
npm test                 # pricing + UI, 62 tests, the default loop
npm run test:integration # real-market tests, 17 tests, offline
npm run test:all         # both
npm run build            # Sass + Eleventy into _site/
npm run serve            # local dev server with watch
```

Integration tests are split out of `npm test` on purpose, so the default
feedback loop stays narrow. They are **not** excluded because they are
flaky: they read a committed fixture and make no network calls, verified
both by static inspection (their only imports are `node:test`,
`node:assert`, `node:fs`, `node:url`, `node:path` and `bs.js`) and by
running them with proxies pointed at a dead port. If anyone ever makes them
fetch live data, that is a regression — the keyless API the snapshot came
from serves AAPL only and is an undocumented courtesy.

Run `npm run test:all` before pushing.

ES modules do not load over `file://`, so the page must be served over HTTP
even for a quick local look. `npm run serve`, or
`python3 -m http.server --bind 127.0.0.1` inside `_site/`.

**Run `npm test` after any change to `bs.js`.** The tests cover the Hull
textbook reference case, put-call parity across four parameter sets, finite-
difference checks that delta/gamma/vega really are the derivatives they claim
to be, the delta-versus-volatility behaviour, degenerate inputs, solver
round-trips, and the worked IV-crush example. A sign error in `d2` produces
plausible numbers rather than a crash; these values are the only thing that
catches it.

One trap already hit: do not use `atmApproximation()` output as an expected
value in a test. The `0.4 * S * vol * sqrt(T)` shortcut and the exact formula
differ by a couple of cents (\$4.045 vs \$4.029 in one case), which is enough
to fail a tight assertion.

---

## 7. Verification performed

- `npm test`: 46/46 passing, including Hull (\$42/\$40/10%/20%/0.5 → call
  \$4.76, put \$0.81) and put-call parity.
- **Real-market integration tests** (`market-data.test.js`) against 60 actual
  AAPL contracts across 8, 29 and 120 DTE, with the market's own bid, ask,
  IV and Greeks. The strongest single result: **every one of the 60 model
  prices falls inside the real quoted bid-ask spread.** Worst deviations —
  price vs mid \$0.24, IV round-trip 0.0041, delta 0.0032, gamma 0.00042,
  vega 0.0033, theta 0.0056, intrinsic 1.6e-14. These also confirm the units
  assumptions most likely to be silently wrong: the vendor agrees that vega
  is per one volatility point and theta is per calendar day.

  Tolerances were measured from the data and given ~1.5x headroom, with the
  observed worst case recorded in a comment beside each. `fixtures/refresh.md`
  explains how to re-derive them, and warns against the failure mode of
  widening whichever assertion goes red.

- **UI tests** (`ui.test.js`, 33 cases) mount the real `index.html` in jsdom
  with a Chart.js stub and drive `app.js` through actual DOM events. They
  cover repricing, dependent slider ranges, the quick-scenario buttons, Copy
  link, Solve for IV, short-position sign flips, URL round-trips, the
  chart's point values against `bs.js`, the P/L transform, reference-line
  placement, and a 10-case sweep of awkward positions asserting no readout
  ever renders NaN. Several are explicitly labelled REGRESSION, naming the
  bug they lock down.

- **Mutation-tested**, because assertions that never bite are worse than no
  tests. Pricing: a sign flip in `d2` (16 tests fail), theta per trading day
  instead of calendar day (2), vega not divided to per-point (3), gamma
  missing its volatility term (3), a flat one-cent price offset (4). UI:
  re-introducing the `copy-note` id collision, reverting the IV-points
  wording, dropping the exit-slider clamp, forgetting to subtract the
  premium in P/L view, ignoring short direction in the Greeks, and removing
  the `hashchange` listener — each caught.

  One mutation initially survived and is worth remembering: moving a chart
  label to 4% passed, because the assertion only checked that label
  positions were *distinct*. Distinctness was not the property that
  mattered; clearance was. The test now asserts each label sits at least 15%
  up the plot (clear of the premium line) and at least 10 points from its
  neighbours. When a mutation survives, the usual cause is an assertion
  testing a proxy rather than the real invariant.
- **Independent cross-check** against the `black-scholes` and `greeks` npm
  packages over 1,764 parameter combinations (7 spots × 7 expiries × 6
  volatilities × 3 rates × call/put). Worst absolute deviations: price
  2.3e-5, delta 7.5e-8, gamma 6.7e-16, vega 4.7e-16, theta 1.8e-9, rho
  1.5e-7. Implied-vol round-trip through the reference pricer: worst error
  6.4e-6. All of these are several orders of magnitude below the cent that
  options actually quote in. Two independent implementations agreeing is
  stronger evidence than this repo's own tests, which could share a bug with
  the code under test.

  The cross-check script is not kept in the repo (it requires two packages
  that are otherwise unused). To reproduce: create a scratch directory with
  `{"type":"module"}`, `npm install black-scholes greeks`, import `bs.js` by
  absolute path, and compare `evaluate()` against `blackScholes()`,
  `getDelta()`, `getGamma()`, `getVega()`, `getTheta()`, `getRho()`. Those
  packages use the same units as `bs.js` (vega and rho per point, theta per
  day) and do not support dividend yield, so compare with `q = 0`.

  **Bug this found:** `impliedVol()` returned its lower bracket (~1e-6)
  instead of `null` for an option trading at parity, where vega is
  effectively zero and volatility is genuinely unrecoverable. The UI would
  have rendered that as "0% IV" — a confidently wrong answer. Now guarded by
  a no-arbitrage floor check; see the comment in `impliedVol()` and the test
  `implied volatility returns null when the price has no time value`. Relative
  error was a misleading metric during this exercise: it flagged sub-penny
  deep-OTM values where both implementations differ only by normal-CDF
  approximation noise. Use absolute error.
- Browser-driven check of the built page: zero console errors or warnings.
- The conversation's worked earnings example reproduced end to end — \$100
  stock, 30-day \$100 call at 70% IV, sold next day at 35% IV → premium
  \$7.99, breakeven \$106.34, required move +6.3%, crush −51%.
- Put-call consistency in the UI: put breakeven \$92.01 = 100 − 7.99.
- Short position flips every Greek sign and the theta copy switches from
  "Costs" to "Earns".
- All 13 fields round-trip through the URL hash and re-hydrate on load.
- Build output contains no test files and no `DESIGN.md`.

---

## 8. Known rough edges

1. **Two separate "IV later" inputs.** The exit-IV slider drives the chart and
   the sell-early breakeven; the event panel has its own "IV after the event
   settles" field. They overlap conceptually and share the same exit date.
   This is intentional so the event panel can be read independently, but it is
   the first thing a new user is likely to find confusing. Consider merging.
2. **Palette duplicated.** Hex values live in both `css/options.css` (as
   custom properties) and the `COLORS` map in `js/chart.js`, because Chart.js
   needs them as JS values and this file is not part of the Sass build.
   Changing the theme means editing both. Could be resolved by reading the
   custom properties via `getComputedStyle` at startup.
3. **No dark mode.** The site has none either, so the app matches. The CSS is
   already built on custom properties scoped to `.oc`, so a
   `prefers-color-scheme` block would be a contained change.
4. **Pre-existing npm audit findings.** Three advisories
   (`linkify-it` → `markdown-it` → `@11ty/eleventy`) predate this app and are
   unrelated to it. Clearing them requires an Eleventy 3 major upgrade, which
   is a separate decision.
5. **`eventScenario` ignores IV between entry and exit.** It jumps straight
   from `volBefore` to `volAfter` at the exit date. There is no term structure
   and no gradual decay of the event premium.
