// "Proprietary" web provider: self-hosted SearXNG metasearch + Mozilla
// Readability page extraction. No third-party data API, no per-call vendor.
// This is ChampSet's owned engine (the A side of the A/B toggle).
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { finalizeText, USER_AGENT, FETCH_TIMEOUT_MS } from "./text-util.js";
import type { WebProvider, SearchOutput, FetchOutput } from "./index.js";

const SEARXNG_URL = (process.env.SEARXNG_URL || "http://searxng:8080").replace(/\/$/, "");
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

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

  console.log(`[fetch_page:searxng] Fetching: ${targetUrl}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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

    if (!res.ok) {
      if (res.status === 404)
        return { error: "Page not found (404). The URL may be outdated. Try a different one." };
      if (res.status === 403 || res.status === 401)
        return { error: "This site blocks automated access. Use the search snippet data instead." };
      if (res.status === 429)
        return { error: "Fetch rate limit hit. Use data from search snippets instead." };
      return { error: `Site returned HTTP ${res.status}. Try a different URL or use search snippet data.` };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();

    if (!contentType.includes("html")) {
      return finalizeText(undefined, raw);
    }

    const dom = new JSDOM(raw, { url: targetUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article?.content) {
      const markdown = turndown.turndown(article.content);
      return finalizeText(article.title ?? undefined, markdown);
    }

    const bodyText = dom.window.document.body?.textContent?.trim() ?? "";
    if (bodyText) return finalizeText(dom.window.document.title || undefined, bodyText);

    return { error: "Page loaded but had no extractable text content. Try a different URL." };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError")
      return { error: "Page fetch timed out. Try a different URL or use search snippet data." };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetch_page:searxng] Failed:`, msg);
    return { error: `Fetch failed: ${msg}. Use data from search snippets instead.` };
  }
}

export const searxngProvider: WebProvider = { name: "searxng", searchWeb, fetchPage };
