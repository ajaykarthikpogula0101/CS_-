// Mastra tool factory for the agent web layer.
//
// `search_web` and `fetch_page` keep identical ids, schemas, and descriptions
// regardless of which engine is active, so the agents are completely unaware
// of the SearXNG-vs-Exa toggle. The active provider is chosen per run (see
// agents/populate.ts, investigate.ts, refresh.ts) and bound here.
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  getWebProvider,
  resolveProviderName,
  type WebProvider,
} from "./web-providers/index.js";
import { browsePage, JEV_BROWSE_ENABLED } from "./web-providers/jev-browse.js";

const searchResultSchema = z.object({
  title: z.string(),
  snippet: z.string(),
  url: z.string(),
});

/**
 * Build the `search_web` + `fetch_page` tools bound to a specific web
 * provider. A fresh pair is built per agent so each run can use a different
 * engine without any shared mutable state.
 */
export function buildWebTools(provider: WebProvider) {
  const search_web = createTool({
    id: "search_web",
    description:
      'Search the web for information. Returns a list of results with titles, snippets, and URLs. Call with: {"query": "your search terms"}',
    inputSchema: z.object({
      query: z.string().describe("The search query string"),
    }),
    outputSchema: z.object({
      results: z.array(searchResultSchema).optional(),
      error: z.string().optional(),
    }),
    execute: async ({ query }) => provider.searchWeb(query),
  });

  const fetch_page = createTool({
    id: "fetch_page",
    description:
      'Fetch a web page and extract its content as clean markdown text. Call with: {"url": "https://example.com/page"}',
    inputSchema: z.object({
      url: z.string().describe("The full URL to fetch, starting with https://"),
    }),
    outputSchema: z.object({
      title: z.string().optional(),
      text: z.string().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ url }) => provider.fetchPage(url),
  });

  return { search_web, fetch_page };
}

/**
 * The `browse_page` tool, or an empty object when the jev-browse sidecar is
 * not configured (JEV_BROWSE_URL unset). Spread it into an agent's tools so
 * agents only see the tool when it can work.
 */
export function buildBrowseTools(): { browse_page?: ReturnType<typeof createBrowseTool> } {
  return JEV_BROWSE_ENABLED ? { browse_page: createBrowseTool() } : {};
}

function createBrowseTool() {
  return createTool({
    id: "browse_page",
    description:
      "Operate an interactive page in a real browser to reach data fetch_page cannot see: fill a search form, set a filter, click \"load more\" or a result. Slower than fetch_page (about 5-30s); use it only when the data sits behind a form or click. Returns the final page text and the steps taken. " +
      'Call with: {"url": "https://example.com/search", "goal": "Search for Acme Ltd and open its company record"}',
    inputSchema: z.object({
      url: z.string().describe("The page to start on, starting with https://"),
      goal: z
        .string()
        .describe("What to do on the page, in plain words, including any values to type"),
    }),
    outputSchema: z.object({
      title: z.string().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      steps: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    execute: async ({ url, goal }) => browsePage(url, goal),
  });
}

/** Tool-list and call-format lines for agent instructions; empty when browsing is off. */
export const BROWSE_TOOL_HINT = JEV_BROWSE_ENABLED
  ? `  browse_page: {"url": "https://example.com/search", "goal": "Search for Acme Ltd and open its record"}  (only when the data is behind a search form, filter or click; slower than fetch_page; counts as one tool call; copy its returned steps into how_found)\n`
  : "";

// Back-compat default singletons bound to the env-default provider. Used by
// Mastra Studio and any importer that doesn't run inside an authed workflow.
const defaults = buildWebTools(getWebProvider(resolveProviderName()));
export const searchWebTool = defaults.search_web;
export const fetchPageTool = defaults.fetch_page;
