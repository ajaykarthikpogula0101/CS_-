// Interactive page loader: sends a URL + goal to the jev-browse sidecar
// (services/jev-browse), which runs a jev-ultrafast browser agent. TypeSafe's
// Jev picks each click / type / select, so the agent can reach data behind
// search forms, filters and "load more" buttons that fetch_page cannot.
//
// Enabled only when JEV_BROWSE_URL is set. Server API: POST /browse.
import { finalizeText } from "./text-util.js";

const JEV_BROWSE_URL = (process.env.JEV_BROWSE_URL || "").replace(/\/$/, "");
const JEV_BROWSE_TOKEN = process.env.JEV_BROWSE_TOKEN;
/** Seconds the sidecar may spend on one goal; the HTTP call waits a little longer. */
const TASK_TIMEOUT_S = 60;
const REQUEST_TIMEOUT_MS = (TASK_TIMEOUT_S + 30) * 1000;
/** After the sidecar is found unreachable, skip it for this long. */
const UNREACHABLE_COOLDOWN_MS = 60_000;

export const JEV_BROWSE_ENABLED = JEV_BROWSE_URL !== "";

export interface BrowseOutput {
  title?: string;
  text?: string;
  /** Final page URL, after any navigation the agent did. */
  url?: string;
  /** What the agent did, e.g. `fill "Company name" = "Acme"`, `click "Search"`. */
  steps?: string[];
  error?: string;
}

interface SidecarResult {
  status: "done" | "blocked" | "stuck" | "timeout" | "step_limit" | "error";
  error?: string | null;
  url?: string | null;
  title?: string | null;
  text?: string;
  steps?: Array<{ action?: string; kind?: string; text?: string | null }>;
  elapsed_ms?: number;
}

let unreachableUntil = 0;

function describeStep(step: { action?: string; kind?: string; text?: string | null }): string {
  const label = JSON.stringify(step.action ?? "");
  return step.kind === "fill" ? `fill ${label} = ${JSON.stringify(step.text ?? "")}` : `${step.kind} ${label}`;
}

// Why the run stopped short, phrased for the agent. The page text is still
// returned: a blocked or timed-out run often already shows the data.
const STOP_NOTES: Record<string, string> = {
  blocked: "The browser agent could not make further progress on this page.",
  stuck: "The page kept changing, so the browser agent's actions could not run.",
  timeout: `The browser agent ran out of time (${TASK_TIMEOUT_S}s).`,
  step_limit: "The browser agent hit its action limit.",
};

export async function browsePage(targetUrl: string, goal: string): Promise<BrowseOutput> {
  if (!JEV_BROWSE_ENABLED) return { error: "Interactive browsing is not configured." };
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://"))
    return { error: `Invalid URL "${targetUrl}". Must start with http:// or https://.` };
  if (Date.now() < unreachableUntil)
    return { error: "Interactive browser is unreachable. Use fetch_page or search snippets instead." };

  console.log(`[browse_page] ${targetUrl} goal=${JSON.stringify(goal.slice(0, 120))}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${JEV_BROWSE_URL}/browse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(JEV_BROWSE_TOKEN ? { Authorization: `Bearer ${JEV_BROWSE_TOKEN}` } : {}),
      },
      body: JSON.stringify({ url: targetUrl, goal, timeout_s: TASK_TIMEOUT_S }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Partial<SidecarResult>;
    if (!res.ok) {
      console.error(`[browse_page] sidecar ${res.status}:`, body.error ?? "");
      return { error: `Interactive browser unavailable (${body.error ?? `HTTP ${res.status}`}). Use fetch_page instead.` };
    }

    const steps = (body.steps ?? []).map(describeStep);
    const text = body.text?.trim() ?? "";
    if (!text)
      return { steps, error: body.error ? `Browser agent failed: ${body.error}` : "The page had no readable text." };

    const page = finalizeText(body.title ?? undefined, text);
    const note = body.status === "error" ? `Browser agent stopped with an error: ${body.error}` : STOP_NOTES[body.status ?? ""];
    return {
      ...page,
      text: note ? `[${note} Text below is the page as it was left.]\n\n${page.text}` : page.text,
      url: body.url ?? targetUrl,
      steps,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      return { error: "Interactive browsing timed out. Use fetch_page or search snippets instead." };
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[browse_page] Failed:`, msg);
    unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
    return { error: "Interactive browser is unreachable. Use fetch_page or search snippets instead." };
  } finally {
    clearTimeout(timeout);
  }
}
