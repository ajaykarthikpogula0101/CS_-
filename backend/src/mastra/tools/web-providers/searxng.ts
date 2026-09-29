// "Proprietary" web provider: self-hosted SearXNG metasearch + Mozilla
// Readability page extraction. No third-party data API, no per-call vendor.
// This is ChampSet's owned engine (the A side of the A/B toggle).
//
// Page loading is selected by FETCH_ENGINE:
//   - "fallback" (default) direct first; Camofox only when direct fails, is
//                blocked, or returns too little text (JS-only pages)
//   - "direct"   plain HTTP fetch + Readability only
//   - "camofox"  every page rendered in the Camofox stealth browser
import { USER_AGENT, FETCH_TIMEOUT_MS } from "./text-util.js";
import { extractPage, isUsable } from "./html-extract.js";
import { camofoxFetch, camofoxLoad } from "./camofox.js";
import type { WebProvider, SearchOutput, FetchOutput } from "./index.js";

const SEARXNG_URL = (process.env.SEARXNG_URL || "http://searxng:8080").replace(/\/$/, "");

export type FetchEngine = "direct" | "camofox" | "fallback";
export const FETCH_ENGINE: FetchEngine =
  process.env.FETCH_ENGINE === "camofox" || process.env.FETCH_ENGINE === "direct"
    ? process.env.FETCH_ENGINE
    : "fallback";

// No successful direct fetch took over 15s in the 300-URL benchmark, and a
// slow direct attempt only delays the Camofox fallback.
const DIRECT_FETCH_TIMEOUT_MS = 15_000;

// Dead URLs a browser can't fix: never worth a ~20s Camofox render.
const DEAD_STATUSES = new Set([404, 405, 410]);

// Hosts that blocked even Camofox are skipped for a while, so an agent that
// keeps hitting the same walled site pays the render cost once, not per page.
const CAMOFOX_BLOCKED_TTL_MS = 30 * 60_000;
const camofoxBlockedHosts = new Map<string, number>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function camofoxKnownBlocked(host: string): boolean {
  const until = camofoxBlockedHosts.get(host);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  camofoxBlockedHosts.delete(host);
  return false;
}

/** Roughly how many results one SearXNG page yields. */
const RESULTS_PER_PAGE = 10;
/** Results to return per search — was 10 (a single page). */
const TARGET_RESULTS = 50;
/** Page cap so one query can't hammer the instance. */
const MAX_PAGES = 5;

async function searchWeb(query: string): Promise<SearchOutput> {
  if (!query?.trim()) return { error: "query is required and cannot be empty." };

  console.log(`[search_web:searxng] Searching SearXNG: "${query}"`);

  const collected: Array<{ title: string; snippet: string; url: string }> = [];
  const seen = new Set<string>();
  const pagesNeeded = Math.min(
    Math.ceil(TARGET_RESULTS / RESULTS_PER_PAGE),
    MAX_PAGES,
  );

  for (let pageno = 1; pageno <= pagesNeeded; pageno++) {
    const page = await searchWebPage(query, pageno);
    // Propagate a hard backend error only if we have nothing at all yet;
    // otherwise keep what we collected from earlier pages.
    if ("error" in page) {
      if (collected.length === 0) return page;
      break;
    }
    if (page.results.length === 0) {
      if (pageno === 1 && collected.length === 0) {
        return {
          results: [],
          error:
            "No results found for this query. Try a broader search or use synthetic data.",
        };
      }
      break; // exhausted
    }
    for (const r of page.results) {
      if (seen.has(r.url)) continue; // pages overlap across engines
      seen.add(r.url);
      collected.push(r);
    }
    if (collected.length >= TARGET_RESULTS) break;
  }

  console.log(`[search_web:searxng] Got ${collected.length} results across pages`);
  return { results: collected.slice(0, TARGET_RESULTS) };
}

async function searchWebPage(
  query: string,
  pageno: number,
): Promise<
  | { results: Array<{ title: string; snippet: string; url: string }> }
  | { error: string }
> {
  // * `pageno` was never sent, so every search saw only page 1 (~10 URLs)
  // * regardless of how many entities the orchestrator still needed.
  const url =
    `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json` +
    `&pageno=${pageno}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text();
      console.error(`[search_web:searxng] error ${res.status}:`, body.slice(0, 200));
      if (res.status === 429)
        return { error: "Search rate limit hit. Wait a moment, or skip web search and use synthetic data." };
      if (res.status === 403)
        return { error: "SearXNG rejected the request (JSON format may be disabled in settings.yml). Use synthetic data." };
      return { error: `Search backend returned HTTP ${res.status}. Try a different query or use synthetic data.` };
    }

    const data = await res.json();
    const results = (data.results ?? [])
      .map((r: Record<string, unknown>) => ({
        title: (r.title as string) ?? "",
        snippet: ((r.content as string) ?? "").trim(),
        url: (r.url as string) ?? "",
      }))
      .filter((r: { url: string }) => r.url);

    // An empty page just means "no more" to the paginating caller, which
    // decides whether that is an error (page 1) or exhaustion (page N).
    return { results };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError")
      return { error: "Search timed out. Skip web search and use synthetic data." };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[search_web:searxng] Failed:`, msg);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed"))
      return { error: "Search backend (SearXNG) is unreachable. Skip web search and use synthetic data." };
    return { error: `Search failed: ${msg}. Skip web search and use synthetic data.` };
  }
}

async function fetchPage(targetUrl: string): Promise<FetchOutput> {
  if (!targetUrl?.trim()) return { error: "url is required and cannot be empty." };
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
    return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };

  if (FETCH_ENGINE === "camofox") return camofoxFetch(targetUrl);

  const { out, status, dnsFailure } = await directFetch(targetUrl);
  if (FETCH_ENGINE === "direct" || isUsable(out)) return out;
  if (dnsFailure || (status !== undefined && DEAD_STATUSES.has(status))) return out;

  const host = hostOf(targetUrl);
  if (camofoxKnownBlocked(host)) return out;

  console.log(`[fetch_page:fallback] Direct fetch unusable, retrying with Camofox: ${targetUrl}`);
  const rendered = await camofoxLoad(targetUrl);
  if (rendered.blocked) camofoxBlockedHosts.set(host, Date.now() + CAMOFOX_BLOCKED_TTL_MS);
  // If the browser failed too, the direct result (text or its error) is the better answer.
  return rendered.out.error ? out : rendered.out;
}

async function directFetch(
  targetUrl: string,
): Promise<{ out: FetchOutput; status?: number; dnsFailure?: boolean }> {
  console.log(`[fetch_page:searxng] Fetching: ${targetUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DIRECT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const status = res.status;

    if (!res.ok) {
      if (status === 404)
        return { status, out: { error: "Page not found (404). The URL may be outdated. Try a different one." } };
      if (status === 403 || status === 401)
        return { status, out: { error: "This site blocks automated access. Use the search snippet data instead." } };
      if (status === 429)
        return { status, out: { error: "Fetch rate limit hit. Use data from search snippets instead." } };
      return { status, out: { error: `Site returned HTTP ${status}. Try a different URL or use search snippet data.` } };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    return { status, out: extractPage(raw, targetUrl, contentType) };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError")
      return { out: { error: "Page fetch timed out. Try a different URL or use search snippet data." } };
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    console.error(`[fetch_page:searxng] Failed:`, msg, code ?? "");
    return {
      dnsFailure: code === "ENOTFOUND",
      out: { error: `Fetch failed: ${msg}. Use data from search snippets instead.` },
    };
  }
}

export const searxngProvider: WebProvider = { name: "searxng", searchWeb, fetchPage };
