/*
 * Quote provider seam.
 *
 * The page ships with manual entry only: you type spot, strike, expiry
 * and implied volatility. This module exists so that a live quote source
 * can be added later without touching bs.js, chart.js or the render
 * logic in app.js. app.js never fetches anything itself; it asks this
 * module, and this module currently always answers "no data, use the
 * form".
 *
 * WHY THERE IS NO LIVE PROVIDER YET
 *
 * This site is served from GitHub Pages as static files. A static site
 * cannot hold a secret: anything shipped to the browser is readable by
 * anyone who opens the network tab, so an API key embedded here is a
 * published API key. Adding live quotes therefore means one of:
 *
 *   1. A provider that needs no key and sends permissive CORS headers.
 *      Rare, and the free ones tend to disappear or start rate-limiting.
 *   2. A small proxy you host (Lambda, Cloudflare Worker) that holds the
 *      key server-side and restricts origins. Costs money and uptime but
 *      is the only honest way to use a keyed provider from a static page.
 *   3. Paste-in support: accept a copied option chain row from a broker
 *      and parse it. No network, no key, no CORS. Cheapest real option.
 *
 * TO ADD A PROVIDER
 *
 *   import { register } from './quotes.js';
 *   register({
 *     id: 'my-source',
 *     label: 'My source',
 *     supportsChain: true,
 *     async quote(symbol) {
 *       // Must return null (not throw) when it simply has no data,
 *       // so the UI falls back to manual entry silently.
 *       return { spot, asOf, chain: [{ strike, expiry, type, bid, ask, iv }] };
 *     },
 *   });
 *
 * Contract for quote(): resolve to null when unavailable, or to an object
 * with at least { spot }. Throw only for genuine errors worth surfacing.
 */

/** The default provider. Reads nothing; the form is the source of truth. */
export const manualProvider = {
  id: 'manual',
  label: 'Manual entry',
  supportsChain: false,
  async quote() {
    return null;
  },
};

const registry = new Map([[manualProvider.id, manualProvider]]);

export function register(provider) {
  if (!provider || !provider.id || typeof provider.quote !== 'function') {
    throw new Error('A quote provider needs an id and a quote() function.');
  }
  registry.set(provider.id, provider);
  return provider;
}

export function list() {
  return [...registry.values()];
}

export function get(id) {
  return registry.get(id) || manualProvider;
}

/**
 * Resolve a quote, never throwing for the ordinary "no data" case.
 * app.js can call this unconditionally and treat null as "use the form".
 */
export async function quote(providerId, symbol) {
  const provider = get(providerId);
  try {
    return await provider.quote(symbol);
  } catch (err) {
    console.warn(`Quote provider "${provider.id}" failed:`, err);
    return null;
  }
}
