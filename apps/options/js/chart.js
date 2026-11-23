/*
 * Thin wrapper over Chart.js for the payoff chart.
 *
 * Chart.js (4.x) and chartjs-plugin-annotation (3.x) are installed from
 * npm and self-hosted: see the addPassthroughCopy entries in
 * /.eleventy.js, which copy the UMD bundles into ./vendor/ at build time.
 * They are loaded as plain <script> tags in index.html, so they arrive as
 * the globals `Chart` and `chartjs-plugin-annotation`. That avoids both a
 * bundler and a runtime CDN dependency.
 *
 * Everything specific to this page lives here; app.js only hands over
 * numbers. Keeping the Chart.js config in one file means the library
 * could be swapped without touching application logic.
 */

let registered = false;

/** Palette drawn from the site's Sass variables so the chart matches. */
export const COLORS = {
  exit: '#3182ce', // $blue: value on the chosen exit date
  expiry: '#d97706', // amber: value at expiry (the hockey stick)
  premium: '#718096', // $default-shade: what you paid
  strike: '#1a202c', // $default-tint
  spot: '#059669', // green: where the stock is now
  breakeven: '#dc2626', // red: where you stop losing money
};

function ensureRegistered() {
  if (registered) return;
  const Chart = window.Chart;
  if (!Chart) {
    throw new Error(
      'Chart.js did not load. Expected vendor/chart.umd.js to define window.Chart.'
    );
  }
  const annotation = window['chartjs-plugin-annotation'];
  if (annotation) Chart.register(annotation);

  // Match the site's sans-serif stack rather than Chart.js defaults.
  Chart.defaults.font.family =
    "'Helvetica Neue', 'Segoe UI', Helvetica, Arial, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.color = '#718096';
  registered = true;
}

const money = (v) =>
  (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);

/**
 * Create the payoff chart on a <canvas>.
 *
 * Returns { update(spec), destroy() }.
 *
 * spec = {
 *   series: [{ id, label, points: [{x, y}], color, dashed }],
 *   vLines: [{ value, label, color, dashed }],
 *   hLines: [{ value, label, color, dashed }],
 *   xLabel, yLabel,
 * }
 */
export function createPayoffChart(canvas) {
  ensureRegistered();
  const Chart = window.Chart;

  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,

      // Animation off is not a style preference. The exit-date and IV
      // sliders rebuild this chart on every input event, and tweening
      // between states makes dragging feel laggy and misleading.
      animation: false,

      // Points are supplied pre-sorted as {x, y}, so Chart.js can skip
      // its parsing and sorting passes.
      parsing: false,
      normalized: true,

      interaction: { mode: 'index', intersect: false, axis: 'x' },

      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Stock price', font: { size: 13 } },
          grid: { color: 'rgba(113, 128, 150, 0.15)' },
          ticks: { callback: (v) => '$' + Number(v).toFixed(0) },
        },
        y: {
          type: 'linear',
          title: { display: true, text: 'Option value', font: { size: 13 } },
          grid: { color: 'rgba(113, 128, 150, 0.15)' },
          ticks: { callback: (v) => money(Number(v)) },
        },
      },

      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 28 },
        },
        tooltip: {
          displayColors: true,
          callbacks: {
            title: (items) =>
              items.length ? 'Stock at $' + Number(items[0].parsed.x).toFixed(2) : '',
            label: (item) =>
              `${item.dataset.label}: ${money(Number(item.parsed.y))}`,
          },
        },
        annotation: { annotations: {} },
      },
    },
  });

  function update(spec) {
    chart.data.datasets = (spec.series || []).map((s) => ({
      label: s.label,
      data: s.points,
      borderColor: s.color,
      backgroundColor: s.color,
      borderWidth: s.width || 2,
      borderDash: s.dashed ? [6, 4] : [],
      pointRadius: 0,
      pointHitRadius: 0,
      tension: 0,
      fill: false,
    }));

    const annotations = {};

    for (const [i, v] of (spec.vLines || []).entries()) {
      if (!Number.isFinite(v.value)) continue;
      annotations['v' + i] = {
        type: 'line',
        xMin: v.value,
        xMax: v.value,
        borderColor: v.color,
        borderWidth: 1.5,
        borderDash: v.dashed === false ? [] : [4, 4],
        label: {
          display: true,
          content: v.label,
          // 'start' | 'center' | 'end' | a percentage string such as '18%'.
          // Callers use percentages to stagger labels that would otherwise
          // overlap when strike, spot and breakeven sit close together.
          position: v.position || 'start',
          backgroundColor: 'rgba(255,255,255,0.88)',
          color: v.color,
          font: { size: 11 },
          padding: 3,
        },
      };
    }

    for (const [i, h] of (spec.hLines || []).entries()) {
      if (!Number.isFinite(h.value)) continue;
      annotations['h' + i] = {
        type: 'line',
        yMin: h.value,
        yMax: h.value,
        borderColor: h.color,
        borderWidth: 1.5,
        borderDash: h.dashed === false ? [] : [4, 4],
        label: {
          display: true,
          content: h.label,
          position: h.position || 'end',
          backgroundColor: 'rgba(255,255,255,0.85)',
          color: h.color,
          font: { size: 11 },
          padding: 3,
        },
      };
    }

    chart.options.plugins.annotation.annotations = annotations;
    if (spec.xLabel) chart.options.scales.x.title.text = spec.xLabel;
    if (spec.yLabel) chart.options.scales.y.title.text = spec.yLabel;

    chart.update('none');
  }

  return { update, destroy: () => chart.destroy(), chart };
}
