/*
 * Static checks that the stylesheet actually covers the markup.
 *
 * WHY THIS EXISTS
 *
 * The shared field rule in options.css lists input types explicitly:
 *
 *   .oc input[type='text'],
 *   .oc input[type='number'],
 *   .oc input[type='date'],
 *   .oc select { ... }
 *
 * A type that is missing from that list matches nothing and silently falls
 * back to browser defaults. No error, no console warning, nothing a
 * behavioural test would notice — the control just looks wrong. That is
 * exactly how the expiry date field shipped with the wrong font and height
 * when type="date" was added to the HTML but not to the CSS.
 *
 * These tests compare the two files directly, so adding an input of a new
 * type without styling it fails the build instead of looking broken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const css = readFileSync(join(here, '..', 'css', 'options.css'), 'utf8');

/** Input types actually used in the markup. */
function usedInputTypes() {
  const types = new Set();
  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    const match = /type=["']([^"']+)["']/.exec(tag);
    // An <input> with no type attribute is a text input.
    types.add(match ? match[1] : 'text');
  }
  return types;
}

/** Input types named in any `input[type='...']` selector in the CSS. */
function styledInputTypes() {
  const types = new Set();
  for (const match of css.matchAll(/input\[type=['"]([^'"]+)['"]\]/g)) {
    types.add(match[1]);
  }
  return types;
}

/**
 * Types intentionally styled through a class rather than a type selector.
 * Each needs a reason, and the class is asserted to exist below.
 */
const STYLED_BY_CLASS = new Map([
  [
    'radio',
    { selector: '.oc-segmented input', why: 'visually hidden; the label is the control' },
  ],
]);

test('every input type in the markup is styled', () => {
  const used = usedInputTypes();
  const styled = styledInputTypes();

  assert.ok(used.size > 0, 'expected to find inputs in index.html');

  const unstyled = [...used].filter(
    (type) => !styled.has(type) && !STYLED_BY_CLASS.has(type)
  );
  assert.deepEqual(
    unstyled,
    [],
    `these input types have no CSS rule and will fall back to browser ` +
      `defaults: ${unstyled.join(', ')}`
  );
});

test('types styled via a class really have that class rule', () => {
  for (const [type, { selector, why }] of STYLED_BY_CLASS) {
    assert.ok(
      css.includes(selector),
      `${type} is exempt because "${why}", but ${selector} is not in the CSS`
    );
  }
});

test('text, number and date share one box rule so they look identical', () => {
  // These three sit side by side in the Position card and must be
  // indistinguishable. Find the rule carrying the shared box metrics and
  // check all three are in its selector list.
  const blocks = css.split('}');
  const shared = blocks.find(
    (block) =>
      block.includes('font-family: var(--oc-mono)') &&
      block.includes('height:') &&
      block.includes('border-radius:')
  );
  assert.ok(shared, 'could not find the shared field rule');

  for (const type of ['text', 'number', 'date']) {
    assert.ok(
      shared.includes(`input[type='${type}']`),
      `input[type='${type}'] is missing from the shared field rule, so it ` +
        `will not match its neighbours`
    );
  }
  assert.ok(shared.includes('select'), 'select shares the same box');
});

test('date inputs are excluded from appearance:none, keeping the picker', () => {
  // appearance:none can suppress ::-webkit-calendar-picker-indicator,
  // leaving no visible way to open the date picker. The rule that strips
  // native chrome must therefore not name the date type.
  const blocks = css.split('}');
  const appearanceRules = blocks.filter(
    (block) => /appearance:\s*none/.test(block) && block.includes('input[type=')
  );
  assert.ok(appearanceRules.length > 0, 'expected an appearance:none rule');

  for (const rule of appearanceRules) {
    assert.ok(
      !rule.includes("input[type='date']"),
      'date inputs must not have appearance:none, or the picker button vanishes'
    );
  }
});

test('the date field has explicit rules for its native sub-parts', () => {
  // Without these the digits render in the browser default font while
  // neighbouring fields use the monospace stack.
  assert.match(
    css,
    /::-webkit-datetime-edit[\s\S]*?font-family:\s*var\(--oc-mono\)/,
    'date digits should use the monospace stack'
  );
  assert.match(
    css,
    /::-webkit-calendar-picker-indicator/,
    'the calendar icon should be toned down to match the select chevron'
  );
});

test('no stale references to removed controls remain', () => {
  // The Solve for IV button and its quoted-price field were removed when
  // price became a first-class input. Dead selectors are confusing.
  for (const gone of ['btn-solve-iv', 'marketPrice', 'solve-iv-note']) {
    assert.ok(!css.includes(gone), `CSS still references removed control ${gone}`);
    assert.ok(!html.includes(gone), `HTML still references removed control ${gone}`);
  }
});

test('every element id the CSS targets by id still exists in the markup', () => {
  for (const match of css.matchAll(/#([a-zA-Z][\w-]*)/g)) {
    const id = match[1];
    // Skip hex colours, which also start with #.
    if (/^[0-9a-fA-F]{3,8}$/.test(id)) continue;
    assert.ok(
      html.includes(`id="${id}"`),
      `CSS targets #${id} but no such element exists`
    );
  }
});
