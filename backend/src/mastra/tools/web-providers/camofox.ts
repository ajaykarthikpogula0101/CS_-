// Camofox page loader: renders the page in a stealth Firefox (Camoufox) via a
// self-hosted camofox-browser REST server, then runs the same Readability
// extraction as the direct fetch. Slower (~20s/page) but gets through many
// anti-bot walls and JS-only pages that a plain fetch cannot.
//
// Server API used: POST /tabs -> POST /tabs/:id/evaluate -> DELETE /tabs/:id.
import { randomUUID } from "node:crypto";
import { extractPage, looksBlocked } from "./html-extract.js";
import type { FetchOutput } from "./index.js";

const CAMOFOX_URL = (process.env.CAMOFOX_URL || "http://127.0.0.1:9377").replace(/\/$/, "");
const CAMOFOX_USER_ID = process.env.CAMOFOX_USER_ID || "champset";
const CAMOFOX_TIMEOUT_MS = 45_000;
/** Pages rendered at once. Extra callers queue so the browser isn't overloaded. */
const CAMOFOX_CONCURRENCY = Math.max(1, Number(process.env.CAMOFOX_CONCURRENCY) || 5);
/** After the server is found unreachable, skip it for this long. */
const UNREACHABLE_COOLDOWN_MS = 60_000;

// Each slot is its own camofox user (= its own browser context). The server
// tears down a user's whole session after a few consecutive navigation
// failures, so one shared user would let a single bad site kill every page
// being rendered in parallel.
const freeSlots = Array.from({ length: CAMOFOX_CONCURRENCY }, (_, i) => i);
const waiters: Array<(slot: number) => void> = [];

function acquireSlot(): Promise<number> {
  const slot = freeSlots.pop();
  if (slot !== undefined) return Promise.resolve(slot);
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot(slot: number): void {
  const next = waiters.shift();
  if (next) next(slot);
  else freeSlots.push(slot);
}

let unreachableUntil = 0;

export interface CamofoxResult {
  out: FetchOutput;
  /** The site served an anti-bot / access-denied response even to the browser. */
  blocked?: boolean;
  /** The camofox server itself could not be reached. */
  unreachable?: boolean;
}

// POST /tabs already waited for DOMContentLoaded. Give client-side rendering a
// chance: poll until visible text stops growing (2 stable polls), capped at 4s,
// so SPAs hydrate but heavy pages don't burn the whole budget.
const READY_EXPR = `(async () => {
  const t0 = Date.now();
  const len = () => (document.body ? document.body.innerText.length : 0);
  let last = -1, stable = 0;
  while (Date.now() - t0 < 4000) {
    await new Promise(r => setTimeout(r, 300));
    const n = len();
    stable = (n === last && n > 0) ? stable + 1 : 0;
    last = n;
    if (stable >= 2 && document.readyState !== 'loading') break;
  }
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  return { href: location.href, title: document.title, html: html.slice(0, 3_000_000) };
})()`;

async function call(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${CAMOFOX_URL}${path}`, {
    ...init,
    signal,
    headers: { "Content-Type": "application/json" },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

export async function camofoxFetch(targetUrl: string): Promise<FetchOutput> {
  return (await camofoxLoad(targetUrl)).out;
}

export async function camofoxLoad(targetUrl: string): Promise<CamofoxResult> {
  if (Date.now() < unreachableUntil)
    return { unreachable: true, out: { error: "Browser engine (Camofox) is unreachable. Use data from search snippets instead." } };

  const slot = await acquireSlot();
  try {
    return await renderInSlot(targetUrl, `${CAMOFOX_USER_ID}-${slot}`);
  } finally {
    releaseSlot(slot);
  }
}

async function renderInSlot(targetUrl: string, userId: string): Promise<CamofoxResult> {
  console.log(`[fetch_page:camofox] Fetching: ${targetUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAMOFOX_TIMEOUT_MS);
  let tabId: string | undefined;
  try {
    const created = await call(
      "/tabs",
      { method: "POST", body: JSON.stringify({ userId, sessionKey: randomUUID(), url: targetUrl }) },
      controller.signal,
    );
    if (created.status !== 200) {
      console.error(`[fetch_page:camofox] tab create ${created.status}:`, JSON.stringify(created.body).slice(0, 200));
      return { out: { error: "The browser could not load this page. Try a different URL or use search snippet data." } };
    }
    tabId = created.body.tabId as string;
    const navStatus: number | null = created.body.httpStatus ?? null;

    const evaluate = () =>
      call(`/tabs/${tabId}/evaluate`, { method: "POST", body: JSON.stringify({ userId, expression: READY_EXPR }) }, controller.signal);
    let ev = await evaluate();
    if (ev.status === 409) ev = await evaluate(); // navigation still settling
    if (ev.status !== 200 || !ev.body?.result) {
      console.error(`[fetch_page:camofox] evaluate ${ev.status}:`, JSON.stringify(ev.body).slice(0, 200));
      return { out: { error: "The browser could not read this page. Try a different URL or use search snippet data." } };
    }

    const { href, title, html } = ev.body.result as { href?: string; title?: string; html: string };
    const out = extractPage(html, href || targetUrl);
    if (out.error) return { out };
    const page: FetchOutput = { ...out, title: out.title ?? title };

    // Anti-bot statuses are forgiven when the browser ended up on a real,
    // non-challenge page; any other 4xx/5xx is a genuine failure.
    if (navStatus && navStatus >= 400) {
      const antiBot = [401, 403, 429, 503].includes(navStatus);
      const passed = antiBot && !looksBlocked(page.title, page.text) && (page.text?.length ?? 0) >= 500;
      if (!passed) {
        if (navStatus === 404)
          return { out: { error: "Page not found (404). The URL may be outdated. Try a different one." } };
        if (antiBot)
          return { blocked: true, out: { error: "This site blocks automated access. Use the search snippet data instead." } };
        return { out: { error: `Site returned HTTP ${navStatus}. Try a different URL or use search snippet data.` } };
      }
    }
    if (looksBlocked(page.title, page.text))
      return { blocked: true, out: { error: "This site blocks automated access. Use the search snippet data instead." } };
    return { out: page };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      return { out: { error: "Page fetch timed out. Try a different URL or use search snippet data." } };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetch_page:camofox] Failed:`, msg);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
      return { unreachable: true, out: { error: "Browser engine (Camofox) is unreachable. Use data from search snippets instead." } };
    }
    return { out: { error: `Fetch failed: ${msg}. Use data from search snippets instead.` } };
  } finally {
    clearTimeout(timeout);
    if (tabId)
      fetch(`${CAMOFOX_URL}/tabs/${tabId}?userId=${encodeURIComponent(userId)}`, { method: "DELETE" }).catch(() => {});
  }
}
