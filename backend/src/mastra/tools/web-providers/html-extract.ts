// HTML -> clean markdown extraction shared by every page loader (direct
// fetch and Camofox), so the agent sees identical text whichever engine
// loaded the page.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { finalizeText } from "./text-util.js";
import type { FetchOutput } from "./index.js";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export function extractPage(raw: string, url: string, contentType = "text/html"): FetchOutput {
  if (!contentType.includes("html")) return finalizeText(undefined, raw);

  const dom = new JSDOM(raw, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (article?.content) {
    const markdown = turndown.turndown(article.content);
    return finalizeText(article.title ?? undefined, markdown);
  }

  const bodyText = dom.window.document.body?.textContent?.trim() ?? "";
  if (bodyText) return finalizeText(dom.window.document.title || undefined, bodyText);

  return { error: "Page loaded but had no extractable text content. Try a different URL." };
}

// Interstitial / challenge detection, so a "200 OK" Cloudflare or bot-wall
// page is not treated as a successful fetch.
const BLOCK_PATTERNS = [
  /just a moment/i, /verify you are human/i, /checking your browser/i, /enable javascript and cookies/i,
  /access denied/i, /request blocked/i, /are you a robot/i, /unusual traffic/i, /captcha/i,
  /perimeterx|px-captcha/i, /attention required.*cloudflare/i, /pardon our interruption/i,
  /bot detection/i, /please verify/i, /human verification/i, /datadome/i, /incapsula|imperva/i,
];

export function looksBlocked(title: string | undefined, text: string | undefined): boolean {
  const head = `${title ?? ""}\n${(text ?? "").slice(0, 1500)}`;
  return BLOCK_PATTERNS.some((re) => re.test(head)) && (text ?? "").length < 4000;
}

/** Text shorter than this is treated as a failed load (JS shell, stub page). */
export const MIN_USEFUL_CHARS = 200;

export function isUsable(out: FetchOutput): boolean {
  if (out.error || !out.text) return false;
  if (looksBlocked(out.title, out.text)) return false;
  return out.text.replace(/\s+/g, " ").trim().length >= MIN_USEFUL_CHARS;
}
