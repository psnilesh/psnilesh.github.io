/*
 * Test harness for the UI layer.
 *
 * Mounts the REAL index.html markup in jsdom, installs a Chart.js stub, and
 * imports app.js so its wiring runs against a genuine DOM.
 *
 * Two decisions worth knowing about:
 *
 * 1. The markup is read from apps/options/index.html with its front matter
 *    stripped, NOT from the built _site output. That keeps `npm test`
 *    independent of `npm run build`, and means a test fails if someone
 *    renames an element id in the source the app reads.
 *
 * 2. Chart.js is stubbed rather than loaded. The real library needs a canvas
 *    implementation jsdom does not provide, and rendering is not what these
 *    tests are about. The stub captures the config it is handed, which is
 *    better than rendering for assertions: tests can inspect exactly which
 *    datasets, points and annotations chart.js produced.
 *
 * app.js reads bare globals (document, window, history, location,
 * navigator), so those are installed on globalThis before importing it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(here, '..', '..', 'index.html');

/** Eleventy front matter is not HTML; strip it before parsing. */
function markup() {
  const raw = readFileSync(INDEX_HTML, 'utf8');
  const stripped = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  if (stripped.includes('permalink:')) {
    throw new Error('front matter was not stripped from index.html');
  }
  return stripped;
}

/**
 * Minimal stand-in for Chart.js. Records every config handed to it so tests
 * can assert on datasets and annotations without a rendering surface.
 */
function installChartStub(window) {
  const instances = [];

  class FakeChart {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.config = config;
      this.data = config.data;
      this.options = config.options;
      this.updateCount = 0;
      instances.push(this);
    }
    update() {
      this.updateCount++;
    }
    destroy() {}
    static register(...plugins) {
      FakeChart.registered.push(...plugins);
    }
    static getChart(canvas) {
      return instances.find((i) => i.canvas === canvas) || null;
    }
  }
  FakeChart.registered = [];
  FakeChart.defaults = { font: {}, color: '' };

  window.Chart = FakeChart;
  window['chartjs-plugin-annotation'] = { id: 'annotation' };
  return instances;
}

let bust = 0;

/**
 * Mount the app. Returns handles for driving and inspecting it.
 *
 * `hash` seeds the URL so restoreFromHash() can be exercised on load.
 */
export async function mountApp({ hash = '' } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><main>${markup()}</main></body></html>`,
    {
      url: 'http://localhost/apps/options/' + hash,
      pretendToBeVisual: true,
    }
  );

  const { window } = dom;
  const chartInstances = installChartStub(window);

  // Clipboard is not implemented in jsdom; app.js awaits it for Copy link.
  const clipboard = { written: [], shouldFail: false };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (clipboard.shouldFail) throw new Error('denied');
        clipboard.written.push(text);
      },
    },
  });

  const globals = {
    window,
    document: window.document,
    history: window.history,
    location: window.location,
    navigator: window.navigator,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
  };
  const saved = new Map();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  // Cache-busting query so each mount gets a fresh app.js module instance;
  // module state would otherwise leak between tests.
  await import(`../../js/app.js?mount=${++bust}`);

  // app.js defers to DOMContentLoaded when the document is still loading.
  // Dispatching unconditionally is safe: if main() already ran, no listener
  // is registered and this is a no-op.
  window.document.dispatchEvent(
    new window.Event('DOMContentLoaded', { bubbles: true })
  );

  const $ = (id) => window.document.getElementById(id);
  const text = (id) => {
    const el = $(id);
    return el ? el.textContent.trim() : null;
  };
  const num = (id) => {
    const t = text(id);
    if (t == null) return NaN;
    return Number(t.replace(/[$,%\s]/g, '').replace('+', ''));
  };

  /** Set a field and fire the input event app.js listens for. */
  const set = (id, value) => {
    const el = $(id);
    if (!el) throw new Error(`no element #${id}`);
    el.value = String(value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };

  const click = (id) => {
    const el = $(id);
    if (!el) throw new Error(`no element #${id}`);
    el.dispatchEvent(
      new window.Event('click', { bubbles: true, cancelable: true })
    );
  };

  const pickRadio = (name, value) => {
    const el = [...window.document.querySelectorAll(`input[name="${name}"]`)].find(
      (n) => n.value === value
    );
    if (!el) throw new Error(`no radio ${name}=${value}`);
    el.checked = true;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  const chart = () => chartInstances[chartInstances.length - 1] || null;

  const cleanup = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  };

  return {
    dom,
    window,
    $,
    text,
    num,
    set,
    click,
    pickRadio,
    chart,
    chartInstances,
    clipboard,
    cleanup,
  };
}

/**
 * Readouts that must always carry a value. Used both for the "nothing is
 * blank" check and the NaN sweep.
 */
export const READOUTS = [
  'price-note',
  'out-model-price',
  'out-model-total',
  'out-intrinsic',
  'out-extrinsic',
  'out-approx',
  'out-moneyness',
  'out-premium',
  'out-premium-total',
  'out-premium-note',
  'g-delta',
  'g-gamma',
  'g-theta',
  'g-vega',
  'g-rho',
  'g-delta-note',
  'g-gamma-note',
  'g-theta-note',
  'g-vega-note',
  'g-rho-note',
  'be-expiry',
  'be-expiry-move',
  'be-early',
  'be-early-move',
  'be-gap',
  'be-gap-note',
  'ev-paid',
  'ev-flat',
  'ev-crush',
  'ev-crush-pct',
  'ev-breakeven',
  'ev-required',
  'ev-note',
  'moves-note',
  'exitDaysOut',
  'exitDaysRemainingOut',
  'exitIvOut',
  'exitIvDelta',
];

/**
 * Readouts that legitimately show a dash when there is nothing to report,
 * so they are swept for junk but not required to be populated.
 */
export const OPTIONAL_READOUTS = ['out-unrealised'];
