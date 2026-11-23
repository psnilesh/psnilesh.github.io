/*
 * Tests for the UI layer: app.js wiring and chart.js config mapping.
 *
 *   npm test
 *
 * These run by default alongside the pricing unit tests. They are fast,
 * offline and deterministic: real index.html markup in jsdom with a Chart.js
 * stub. See helpers/mount.js.
 *
 * Several cases below are regression tests for bugs found by manually
 * driving the page in a browser. Each is marked REGRESSION with what broke,
 * because those are the ones most likely to be "simplified" away by someone
 * who does not know why the assertion exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mountApp, READOUTS } from './helpers/mount.js';
import { evaluate, expiryBreakeven } from '../js/bs.js';

const BAD = /NaN|undefined|Infinity|null/;

/** Mount, run, always clean up the installed globals. */
async function withApp(options, fn) {
  const app = await mountApp(options);
  try {
    await fn(app);
  } finally {
    app.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * Baseline render
 * ------------------------------------------------------------------ */

test('mounts and fills every readout with no placeholder junk', async () => {
  await withApp({}, (app) => {
    for (const id of READOUTS) {
      const value = app.text(id);
      assert.ok(value != null, `#${id} is missing from the markup`);
      assert.ok(value !== '--', `#${id} was never populated`);
      assert.ok(!BAD.test(value), `#${id} contains junk: "${value}"`);
    }
    assert.equal(app.$('oc-errors').hidden, true, 'no error banner on load');
  });
});

test('default position prices to the same value bs.js gives', async () => {
  await withApp({}, (app) => {
    const expected = evaluate({
      S: 100,
      K: 100,
      T: 30 / 365,
      vol: 0.3,
      r: 0,
      q: 0,
      type: 'call',
    });
    assert.equal(app.text('out-model-price'), '$' + expected.price.toFixed(2));
    assert.equal(app.text('g-delta'), expected.delta.toFixed(3));
    assert.equal(app.text('out-moneyness'), 'at the money');
  });
});

test('editing an input reprices immediately', async () => {
  await withApp({}, (app) => {
    const before = app.num('out-model-price');
    app.set('spot', 110);
    const after = app.num('out-model-price');
    assert.ok(after > before, `call should gain value: ${before} -> ${after}`);

    const expected = evaluate({
      S: 110, K: 100, T: 30 / 365, vol: 0.3, type: 'call',
    }).price;
    assert.equal(app.text('out-model-price'), '$' + expected.toFixed(2));
    assert.equal(app.text('out-moneyness'), 'in the money');
  });
});

test('contract count scales the dollar totals but not the per-share price', async () => {
  await withApp({}, (app) => {
    const perShare = app.num('out-model-price');
    app.set('qty', 7);
    assert.equal(app.num('out-model-price'), perShare, 'per-share unchanged');
    assert.ok(
      Math.abs(app.num('out-model-total') - perShare * 700) < 1,
      'total should be price x 100 x contracts'
    );
  });
});

/* ------------------------------------------------------------------ *
 * Dependent control ranges
 * ------------------------------------------------------------------ */

test('shortening expiry clamps the exit-day slider range and value', async () => {
  // This is syncControlRanges(), the only code that mutates a control the
  // user is also driving, so it is the easiest place to introduce a stuck
  // or out-of-range slider.
  await withApp({}, (app) => {
    app.set('exitDays', 25);
    assert.equal(app.$('exitDays').value, '25');

    app.set('dte', 10);
    assert.equal(app.$('exitDays').max, '10', 'slider max follows expiry');
    assert.equal(app.$('exitDays').value, '10', 'value clamped into range');
    assert.equal(app.text('exitDaysRemainingOut'), '0 days of life left');
  });
});

test('selling at expiry collapses both breakevens and says so', async () => {
  await withApp({}, (app) => {
    app.set('dte', 10);
    app.set('exitDays', 10);
    const expiry = app.text('be-expiry');
    assert.equal(app.text('be-early'), expiry, 'identical at expiry');
    assert.match(app.text('be-gap-note'), /no time value is left/i);
    assert.ok(!BAD.test(app.text('be-early')), 'no NaN at T=0');
  });
});

/* ------------------------------------------------------------------ *
 * Quick-scenario buttons
 * ------------------------------------------------------------------ */

test('"IV unchanged" copies entry IV to the exit slider', async () => {
  await withApp({}, (app) => {
    app.set('iv', 70);
    app.set('exitIv', 20);
    app.click('btn-flat-iv');
    assert.equal(app.$('exitIv').value, '70');
    assert.equal(app.text('exitIvDelta'), 'unchanged');
  });
});

test('"Halve the IV" halves the exit slider', async () => {
  await withApp({}, (app) => {
    app.set('iv', 70);
    app.click('btn-crush-iv');
    assert.equal(app.$('exitIv').value, '35');
  });
});

test('IV change is reported in POINTS, not percent', async () => {
  // REGRESSION: read "-35% vs entry" for a 70 -> 35 move, which invites
  // reading it as a 35% relative decline (that would be 70 -> 45.5).
  await withApp({}, (app) => {
    app.set('iv', 70);
    app.set('exitIv', 35);
    assert.equal(app.text('exitIvDelta'), '-35 pts vs entry');

    app.set('exitIv', 90);
    assert.equal(app.text('exitIvDelta'), '+20 pts vs entry');
  });
});

test('a sub-point IV difference reads as unchanged, not "+0 pts"', async () => {
  // REGRESSION: entry 41.99 with the slider pinned to 42 rendered "+0%".
  await withApp({}, (app) => {
    app.set('iv', 41.99);
    app.set('exitIv', 42);
    assert.equal(app.text('exitIvDelta'), 'unchanged');
  });
});

/* ------------------------------------------------------------------ *
 * Copy link
 * ------------------------------------------------------------------ */

test('Copy link writes the URL and reports into its own status element', async () => {
  // REGRESSION: the confirmation used to be written into the chart-controls
  // hint paragraph, permanently destroying the "drag the IV slider"
  // instruction the moment anyone clicked Copy link.
  await withApp({}, async (app) => {
    const hintBefore = app.$('copy-note').textContent;
    assert.equal(hintBefore, '', 'status starts empty');

    const instruction = [...app.window.document.querySelectorAll('.oc-hint')].find(
      (p) => /drag the iv slider/i.test(p.textContent)
    );
    assert.ok(instruction, 'the IV slider instruction should exist');
    assert.equal(instruction.id, '', 'instruction must not carry an id');
    const instructionText = instruction.textContent;

    app.click('btn-copy-link');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(app.clipboard.written.length, 1, 'wrote to the clipboard');
    assert.match(app.clipboard.written[0], /\/apps\/options\//);
    assert.equal(app.text('copy-note'), 'Link copied.');
    assert.equal(
      instruction.textContent,
      instructionText,
      'the instruction must survive a Copy link click'
    );
  });
});

test('Copy link reports failure without throwing', async () => {
  await withApp({}, async (app) => {
    app.clipboard.shouldFail = true;
    app.click('btn-copy-link');
    await new Promise((r) => setTimeout(r, 0));
    assert.match(app.text('copy-note'), /copy failed/i);
  });
});

/* ------------------------------------------------------------------ *
 * Premium handling
 * ------------------------------------------------------------------ */

test('an empty premium falls back to the model price and says so', async () => {
  await withApp({}, (app) => {
    assert.equal(app.text('out-premium'), app.text('out-model-price'));
    assert.match(app.text('out-premium-note'), /using the model price/i);
  });
});

test('premium above and below model value is described correctly', async () => {
  await withApp({}, (app) => {
    app.set('premium', 5);
    assert.match(app.text('out-premium-note'), /above model value/i);
    app.set('premium', 1);
    assert.match(app.text('out-premium-note'), /below model value/i);
  });
});

test('a premium matching the model reads as matching, not "$0.00 above"', async () => {
  // REGRESSION: after Solve for IV the two agree to many decimals but not
  // bit-for-bit, which rendered "You paid $0.00 above model value."
  await withApp({}, (app) => {
    const model = evaluate({
      S: 100, K: 100, T: 30 / 365, vol: 0.3, type: 'call',
    }).price;
    app.set('premium', model);
    assert.equal(app.text('out-premium-note'), 'Matches the model price.');
  });
});

/* ------------------------------------------------------------------ *
 * Solve for IV
 * ------------------------------------------------------------------ */

test('Solve for IV fills IV and premium, and round-trips', async () => {
  await withApp({}, (app) => {
    app.$('marketPrice').value = '4.80';
    app.click('btn-solve-iv');

    const iv = Number(app.$('iv').value);
    assert.ok(iv > 1 && iv < 200, `implausible IV: ${iv}`);
    assert.equal(app.$('premium').value, '4.80');
    assert.equal(app.text('out-model-price'), '$4.80', 'round-trips to the quote');
    assert.match(app.text('solve-iv-note'), /implies/i);
  });
});

test('Solve for IV refuses a price with no time value', async () => {
  // A deep in-the-money option at parity: vega is ~0 so IV is unrecoverable.
  await withApp({}, (app) => {
    app.set('type', 'put');
    app.set('spot', 80);
    app.set('strike', 100);
    app.set('dte', 7);
    const parity = evaluate({
      S: 80, K: 100, T: 7 / 365, vol: 0.12, type: 'put',
    }).price;
    app.$('marketPrice').value = String(parity.toFixed(4));
    app.click('btn-solve-iv');
    assert.match(app.text('solve-iv-note'), /cannot determine/i);
  });
});

test('Solve for IV asks for a price when the field is empty', async () => {
  await withApp({}, (app) => {
    app.$('marketPrice').value = '';
    app.click('btn-solve-iv');
    assert.match(app.text('solve-iv-note'), /enter the option price/i);
  });
});

/* ------------------------------------------------------------------ *
 * Direction and type
 * ------------------------------------------------------------------ */

test('going short flips every Greek sign and the theta wording', async () => {
  await withApp({}, (app) => {
    const longDelta = app.num('g-delta');
    assert.match(app.text('g-theta-note'), /costs/i);

    app.set('side', 'short');
    assert.equal(app.num('g-delta'), -longDelta, 'delta flips');
    assert.match(app.text('g-theta-note'), /earns/i);
    assert.ok(app.num('g-theta') > 0, 'short theta is positive');
  });
});

test('put breakeven is strike minus premium', async () => {
  await withApp({}, (app) => {
    app.set('type', 'put');
    app.set('premium', 6);
    assert.equal(
      app.text('be-expiry'),
      '$' + expiryBreakeven({ K: 100, premium: 6, type: 'put' }).toFixed(2)
    );
  });
});

/* ------------------------------------------------------------------ *
 * URL state
 * ------------------------------------------------------------------ */

test('inputs are mirrored into the URL hash', async () => {
  await withApp({}, (app) => {
    app.set('spot', 123.5);
    app.set('strike', 130);
    app.set('iv', 55);
    const hash = app.window.location.hash;
    assert.match(hash, /S=123\.5/);
    assert.match(hash, /K=130/);
    assert.match(hash, /v=55/);
  });
});

test('a shared hash hydrates the form on load', async () => {
  await withApp(
    { hash: '#s=NVDA&d=short&t=put&n=3&S=180&K=170&e=45&v=55&p=6.2&x=5&w=38&m=pnl' },
    (app) => {
      assert.equal(app.$('sym').value, 'NVDA');
      assert.equal(app.$('side').value, 'short');
      assert.equal(app.$('type').value, 'put');
      assert.equal(app.$('qty').value, '3');
      assert.equal(app.$('spot').value, '180');
      assert.equal(app.$('strike').value, '170');
      assert.equal(app.$('dte').value, '45');
      assert.equal(app.$('iv').value, '55');
      assert.equal(app.$('premium').value, '6.2');
      assert.equal(app.$('exitDays').value, '5');
      assert.equal(app.$('exitIv').value, '38');
      assert.equal(
        app.window.document.querySelector('input[name="view"]:checked').value,
        'pnl'
      );
    }
  );
});

test('a hashchange re-hydrates the form', async () => {
  // REGRESSION: a hash-only URL change does not reload the document, so
  // pasting a shared position while already on the page left stale values.
  await withApp({}, (app) => {
    assert.equal(app.$('spot').value, '100');
    app.window.location.hash = '#S=250&K=240&e=60&v=45';
    app.window.dispatchEvent(new app.window.Event('hashchange'));
    assert.equal(app.$('spot').value, '250');
    assert.equal(app.$('strike').value, '240');
    assert.equal(app.$('iv').value, '45');
  });
});

/* ------------------------------------------------------------------ *
 * Chart config
 * ------------------------------------------------------------------ */

test('chart receives two curves whose points match bs.js exactly', async () => {
  await withApp({}, (app) => {
    const chart = app.chart();
    assert.ok(chart, 'a chart was constructed');
    assert.equal(chart.data.datasets.length, 2);

    const [exitSeries, expirySeries] = chart.data.datasets;
    assert.equal(exitSeries.data.length, 161);
    assert.equal(expirySeries.data.length, 161);

    const exitT = (30 - 1) / 365; // dte 30, sell on day 1
    for (const point of exitSeries.data) {
      const expected = evaluate({
        S: point.x, K: 100, T: exitT, vol: 0.3, r: 0, q: 0, type: 'call',
      }).price;
      assert.ok(
        Math.abs(point.y - expected) < 1e-12,
        `exit curve mismatch at S=${point.x}: ${point.y} vs ${expected}`
      );
    }
    for (const point of expirySeries.data) {
      const expected = Math.max(point.x - 100, 0);
      assert.ok(
        Math.abs(point.y - expected) < 1e-12,
        `expiry curve mismatch at S=${point.x}`
      );
    }
  });
});

test('chart x range always spans both the strike and the spot', async () => {
  await withApp({}, (app) => {
    for (const [spot, strike] of [[100, 100], [100, 250], [100, 20], [50, 51]]) {
      app.set('spot', spot);
      app.set('strike', strike);
      const points = app.chart().data.datasets[0].data;
      const lo = points[0].x;
      const hi = points[points.length - 1].x;
      assert.ok(
        lo < Math.min(spot, strike) && hi > Math.max(spot, strike),
        `range ${lo}..${hi} should span spot ${spot} and strike ${strike}`
      );
      assert.ok(lo > 0, 'x range must stay positive');
    }
  });
});

test('P/L view subtracts the premium and applies position direction', async () => {
  await withApp({}, (app) => {
    app.set('premium', 4);
    app.pickRadio('view', 'pnl');

    const chart = app.chart();
    assert.match(chart.options.scales.y.title.text, /profit/i);

    const exitT = (30 - 1) / 365;
    for (const point of chart.data.datasets[0].data) {
      const value = evaluate({
        S: point.x, K: 100, T: exitT, vol: 0.3, type: 'call',
      }).price;
      assert.ok(Math.abs(point.y - (value - 4)) < 1e-12, 'long P/L');
    }

    app.set('side', 'short');
    for (const point of app.chart().data.datasets[0].data) {
      const value = evaluate({
        S: point.x, K: 100, T: exitT, vol: 0.3, type: 'call',
      }).price;
      assert.ok(Math.abs(point.y - (4 - value)) < 1e-12, 'short P/L is mirrored');
    }
  });
});

test('reference lines cover spot, strike and breakeven, staggered to avoid overlap', async () => {
  await withApp({}, (app) => {
    const annotations = app.chart().options.plugins.annotation.annotations;
    const entries = Object.values(annotations);

    const labels = entries.map((a) => a.label.content);
    assert.ok(labels.some((l) => /spot/i.test(l)), 'spot line');
    assert.ok(labels.some((l) => /strike/i.test(l)), 'strike line');
    assert.ok(labels.some((l) => /breakeven/i.test(l)), 'breakeven line');
    assert.ok(labels.some((l) => /paid/i.test(l)), 'premium line in value view');

    // REGRESSION: all three vertical labels sat at the same height and
    // smeared together whenever spot, strike and breakeven were close, which
    // is the common case. They are staggered by percentage position now.
    //
    // Two separate invariants, because checking only for distinct values let
    // a mutation that moved a label to 4% slip through:
    //   a) they must be far enough apart to not overlap each other, and
    //   b) none may sit near the bottom of the plot, where the horizontal
    //      "premium paid" line and its own label live.
    const positions = entries
      .filter((a) => a.xMin !== undefined)
      .map((a) => {
        const raw = a.label.position;
        assert.match(
          String(raw),
          /^\d+(\.\d+)?%$/,
          `vertical labels must use a percentage position, got "${raw}"`
        );
        return parseFloat(raw);
      });

    assert.equal(positions.length, 3, 'spot, strike and breakeven');

    for (const p of positions) {
      assert.ok(
        p >= 15,
        `label at ${p}% is too close to the bottom, where the premium line sits`
      );
    }

    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i] - sorted[i - 1] >= 10,
        `labels at ${sorted[i - 1]}% and ${sorted[i]}% are too close together`
      );
    }
  });
});

test('the premium reference line is dropped in P/L view', async () => {
  await withApp({}, (app) => {
    app.pickRadio('view', 'pnl');
    const annotations = app.chart().options.plugins.annotation.annotations;
    const horizontal = Object.values(annotations).filter((a) => a.yMin !== undefined);
    assert.equal(horizontal.length, 0, 'a zero-premium line would be noise');
  });
});

test('chart animation stays off so slider dragging is not laggy', async () => {
  await withApp({}, (app) => {
    assert.equal(app.chart().options.animation, false);
  });
});

/* ------------------------------------------------------------------ *
 * Expected-move table
 * ------------------------------------------------------------------ */

test('expected-move table renders five horizons with correct scaling', async () => {
  await withApp({}, (app) => {
    app.set('spot', 100);
    app.set('iv', 30);
    const rows = [...app.window.document.querySelectorAll('#moves-body tr')];
    assert.equal(rows.length, 5);

    const cells = (i) => [...rows[i].querySelectorAll('td')].map((td) => td.textContent.trim());

    assert.deepEqual(cells(0).slice(0, 3), ['1 trading day', '1/252', '0.063']);
    assert.equal(cells(2)[1], '1/12');
    assert.equal(cells(2)[3], '8.66%', 'a month is annual / sqrt(12)');
    assert.equal(cells(3)[3], '15.00%', 'a quarter is half the annual move');
    assert.equal(cells(4)[3], '30.00%', 'a year is the annual figure itself');
    assert.equal(cells(4)[5], '$70.00 to $130.00');
    assert.match(app.text('moves-note'), /divide by 16/i);
  });
});

/* ------------------------------------------------------------------ *
 * Validation and robustness
 * ------------------------------------------------------------------ */

test('invalid input shows the error banner instead of rendering junk', async () => {
  await withApp({}, (app) => {
    app.set('spot', 0);
    assert.equal(app.$('oc-errors').hidden, false);
    assert.match(app.text('oc-errors'), /stock price/i);

    app.set('spot', 100);
    assert.equal(app.$('oc-errors').hidden, true, 'banner clears on repair');
  });
});

test('awkward positions never render NaN, undefined or a broken chart', async () => {
  await withApp({}, (app) => {
    const cases = [
      ['expired', () => app.set('dte', 0)],
      ['deep OTM', () => { app.set('dte', 30); app.set('strike', 500); }],
      ['deep ITM', () => app.set('strike', 5)],
      ['extreme IV', () => { app.set('strike', 100); app.set('iv', 300); }],
      ['tiny IV', () => app.set('iv', 0.1)],
      ['unreachable breakeven', () => { app.set('iv', 30); app.set('type', 'put'); app.set('premium', 9999); }],
      ['penny stock', () => { app.set('premium', ''); app.set('type', 'call'); app.set('spot', 0.5); app.set('strike', 0.5); }],
      ['huge size', () => { app.set('spot', 100); app.set('strike', 100); app.set('qty', 5000); }],
      ['long dated', () => { app.set('qty', 1); app.set('dte', 3650); }],
      ['rate and yield', () => { app.set('dte', 30); app.set('rate', 5); app.set('divyield', 3); }],
    ];

    for (const [label, apply] of cases) {
      apply();
      for (const id of READOUTS) {
        const value = app.text(id);
        assert.ok(!BAD.test(value), `${label}: #${id} = "${value}"`);
      }
      for (const dataset of app.chart().data.datasets) {
        for (const point of dataset.data) {
          assert.ok(
            Number.isFinite(point.x) && Number.isFinite(point.y),
            `${label}: non-finite chart point ${JSON.stringify(point)}`
          );
        }
      }
      assert.equal(app.$('oc-errors').hidden, true, `${label}: unexpected error banner`);
    }
  });
});

test('an unreachable breakeven is reported, not faked', async () => {
  await withApp({}, (app) => {
    app.set('type', 'put');
    app.set('premium', 9999);
    assert.equal(app.text('be-early'), 'unreachable');
    assert.match(app.text('ev-breakeven'), /unreachable/i);
  });
});
