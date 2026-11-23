# Regenerating `aapl-chain.json`

The fixture is a **frozen snapshot of real market data**. Tests run offline
against it, so they are deterministic and do not depend on a third party
staying up. You should rarely need to refresh it: option mathematics does not
change, and a 2026 chain validates `bs.js` just as well as a current one.

Refresh only if you need to cover something the snapshot lacks, such as a
different volatility regime, a dividend-heavy underlying, or an expiry
structure not represented here.

## Source

`marketdata.app`, which serves AAPL option chains **without an API key**.

That keyless access is AAPL-only — every other symbol returns
`{"s":"error","errmsg":"Invalid token header. No credentials provided."}`.
It is a demo allowance and could be withdrawn at any time, which is exactly
why the data is committed rather than fetched at test time.

Two response quirks to know about:

- It returns HTTP **203** (Non-Authoritative Information), not 200, to signal
  cached data. Treat 203 as success.
- Data is **end of day**, not live. The committed snapshot is timestamped
  2026-11-19 21:00 UTC.

## Steps

```bash
mkdir -p /tmp/mdapp-raw && cd /tmp/mdapp-raw

# Pick expirations spanning the term structure: short, medium, long.
curl -s "https://api.marketdata.app/v1/options/expirations/AAPL/"

# strikeLimit centres the strikes on the money; omitting `side` returns
# both calls and puts, which the put-call parity test needs.
for EXP in 2026-11-27 2026-12-18 2027-03-19; do
  curl -s "https://api.marketdata.app/v1/options/chain/AAPL/?expiration=$EXP&strikeLimit=10" \
       -o "chain_$EXP.json"
done
```

The API returns **column arrays**, not an array of objects: `strike[i]`,
`bid[i]`, `iv[i]` and so on all describe contract `i`. Transpose them into
per-contract objects, keep the fields the existing fixture has, and preserve
the `source`, `symbol`, `quoteTimestampUtc`, `underlyingPrice` and
`modelAssumptions` metadata.

## Then re-derive the tolerances — do not reuse the old ones

Every tolerance in `market-data.test.js` was measured from this specific
snapshot and then given about 1.5x headroom. New data means new worst-case
deviations. Measure them, then set the tolerances, and update the
`// Observed worst:` comment beside each one.

Getting this backwards — keeping the old numbers and widening whichever one
goes red — is how a test suite silently stops testing anything.

Values measured from the committed snapshot (60 contracts, r=4%, q=0,
T = dte/365):

| Quantity | Observed worst | Tolerance set |
|---|---|---|
| price vs mid | $0.2393 | 0.35 |
| inside bid-ask | 60/60 contracts | must be all |
| IV round-trip | 0.00407 | 0.006 |
| delta | 0.0032 | 0.005 |
| gamma | 0.00042 | 0.001 |
| vega | 0.0033 | 0.006 |
| theta | 0.0056 | 0.010 |
| intrinsic | 1.6e-14 | 1e-9 |
| parity / combined spread | 0.55x | 0.85x |

## Day count and dividend yield

`T = dte / 365` and `q = 0` were fitted against this data, not assumed:

| Day count | q=0 | q=0.4% | q=1% |
|---|---|---|---|
| dte/365 | **$0.0606** | $0.0659 | $0.1158 |
| dte/360 | $0.0915 | $0.0915 | $0.1298 |
| dte/252 | $1.8140 | $1.8797 | $1.8825 |

(median absolute price error vs the real mid)

`dte/365` wins by a factor of 30 over `dte/252`, which settles the day-count
question for pricing. Interestingly `q = 0` fits marginally better than
AAPL's actual ~0.4% yield, probably because the vendor's American-exercise
treatment offsets it. If you refresh with a higher-yield underlying, refit.

## Verify the new tests actually bite

A test that passes under a loosened tolerance is worse than no test. After
refreshing, confirm the suite still catches deliberate breakage:

```bash
cp apps/options/js/bs.js /tmp/bs.js.backup
# introduce one error, e.g. change `d1 - volSqrtT` to `d1 + volSqrtT`,
# or `thetaYear / 365` to `thetaYear / 252`
npm run test:all   # must FAIL
cp /tmp/bs.js.backup apps/options/js/bs.js
npm run test:all   # must pass
```

On the committed snapshot, five such mutations were each caught — including
adding a flat one cent to every price, which failed 4 tests.
