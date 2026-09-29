# ChampSet

Monorepo: `frontend/` (Next.js 16) + `backend/` (Fastify + Mastra). Run with `make dev` (Docker).

Frontend on :3500, backend on :3501, Mastra Studio on :4111, Convex dashboard on :6791.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys:
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/settings/keys
   - `EXA_API_KEY` (optional) — only needed when the Exa web engine is selected; from https://dashboard.exa.ai/api-keys
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — from Clerk API Keys
   - `CLERK_SECRET_KEY` — from Clerk API Keys
   - `CLERK_JWT_ISSUER_DOMAIN` — your Frontend API URL (e.g. `https://your-app.clerk.accounts.dev`)
2. Create a free Clerk account at https://clerk.com and create an application.
3. In the Clerk dashboard, go to **JWT Templates** and enable the **Convex** template.
4. Run `make dev` — starts all Docker services, auto-generates the Convex admin key on first run, and pushes Convex functions. No manual key generation needed.

## Architecture

Auth is Clerk. Frontend uses `@clerk/nextjs` with `ClerkProvider` wrapping the app. Convex validates Clerk JWTs via `convex/auth.config.ts`. Protected routes enforced by Clerk proxy (`frontend/proxy.ts`). No self-hosted auth database.

Dataset storage uses Convex (self-hosted at :3210). Schema in `frontend/convex/schema.ts`, functions in `frontend/convex/datasets.ts` and `frontend/convex/datasetRows.ts`. Convex dashboard at :6791.

Frontend uses Convex React hooks (`useQuery`, `useMutation`) with `ConvexProviderWithClerk` for authenticated realtime queries. Use `useConvexAuth()` (not Clerk's `useAuth()`) to check auth state in components. For backend calls, the frontend uses `useAuth().getToken()` from `@clerk/nextjs` to get a Bearer token and passes it to the API client in `frontend/lib/backend.ts`.

Backend is Fastify + Mastra. Fastify serves the HTTP API (Clerk JWT auth on protected routes via `backend/src/clerk-auth.ts`). Mastra (`backend/src/mastra/`) is the workflow orchestration layer — it wraps pipelines into inspectable workflows with a Studio UI. Both run as separate Docker services sharing the same source code.

The schema inference pipeline: frontend calls `POST /infer-schema` → Fastify verifies the Clerk JWT → calls `inferSchema()` in `backend/src/pipeline/schema-inference.ts` → Claude Sonnet 4.6 via OpenRouter → returns a Zod-validated `DatasetSchema` → frontend maps it to editable columns in the wizard.

The populate pipeline: frontend calls `POST /populate` with `{ datasetId, datasetName, description, columns }` → Fastify verifies the Clerk JWT → triggers `populateWorkflow` which: (1) clears existing rows, (2) builds a prompt from the schema, (3) runs the populate agent (Claude Sonnet 4.6) which searches the web via the self-hosted SearXNG backend (or Exa when that engine is selected), then inserts rows into Convex one by one. Rows appear in realtime on the frontend via Convex reactive queries.

Page loading for the SearXNG engine's `fetch_page` is selected by `FETCH_ENGINE` (`backend/src/mastra/tools/web-providers/searxng.ts`): `fallback` (default) tries a plain fetch + Readability first and only uses Camofox when the result is an error, a bot-wall page, or under 200 chars of text; `direct` never uses Camofox; `camofox` renders every page in the Camofox stealth browser via a self-hosted camofox-browser REST server (`web-providers/camofox.ts`). Fallback skips Camofox for dead URLs (404/405/410, DNS failure) and, for 30 min, for hosts that blocked Camofox too; if the server is unreachable it is skipped for 60s and the direct result is returned. Camofox renders are capped at `CAMOFOX_CONCURRENCY` (default 5), each slot using its own camofox userId: the server destroys a user's whole browser session after repeated navigation failures, so do not collapse them into one shared userId. Both loaders share `web-providers/html-extract.ts`. The Exa engine is unaffected.

The `browse_page` tool (`buildBrowseTools()` in `backend/src/mastra/tools/web-tools.ts`) lets the populate, investigate and refresh agents operate a page: fill a search form, set a filter, click through. It calls the `services/jev-browse` Python sidecar, which runs a pinned jev-ultrafast browser agent (TypeSafe's Jev picks each action; a small OpenRouter model writes typed text) in its own headless Chrome and returns the final page's full text plus the steps taken. The tool is registered only when `JEV_BROWSE_URL` is set, and its call-format line (`BROWSE_TOOL_HINT`) is added to agent instructions only then, so with the sidecar off agents are unchanged. The sidecar keeps Browser Harness telemetry off (`BH_TELEMETRY=0`) so task text stays on the host; do not remove that. Sidecar tests (`cd services/jev-browse && uv run pytest`) fake both model calls and drive a real headless Chrome.

Convex functions use `ctx.auth.getUserIdentity()` to get the authenticated user. The `ownerId` field on datasets stores `identity.subject` (Clerk user ID). Do not pass `ownerId` from the client.

## Environment Variables

Root `.env` is the only local env file. Docker Compose, package scripts, and Convex CLI helper targets all read it. Key variables:
- `FETCH_ENGINE` / `CAMOFOX_URL` / `CAMOFOX_CONCURRENCY` — page loader for `fetch_page` (`fallback` default, `direct`, `camofox`). Camofox modes need a camofox-browser server; inside Docker the URL defaults to `http://host.docker.internal:9377` (override with `CAMOFOX_URL_DOCKER`).
- `JEV_BROWSE_URL` / `JEV_BROWSE_TOKEN` — jev-browse sidecar for the `browse_page` tool; empty URL = tool off. Inside Docker set `JEV_BROWSE_URL_DOCKER` (e.g. `http://host.docker.internal:9380`). The sidecar itself needs `TYPESAFE_API_KEY` and uses `OPENROUTER_API_KEY` for typed text.
- `SEARCH_PROVIDER` / `EXA_API_KEY` — select the agent web engine (`searxng` default, or `exa`). SearXNG needs no key; Exa needs `EXA_API_KEY`.
- `OPENROUTER_API_KEY` — used by backend and Mastra for AI model calls
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` — shared by frontend and backend
- `CONVEX_SELF_HOSTED_ADMIN_KEY` — used by backend for system-level Convex writes

The backend container maps `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` → `CLERK_PUBLISHABLE_KEY` (see `docker-compose.dev.yml`).

## Convex Deploys

Convex is self-hosted — it does NOT hot-reload when you edit files in `frontend/convex/`. After changing any Convex function, schema, or auth config, you must run `make convex-push` to deploy the updated code to the running instance. `make dev` does this automatically on startup, but subsequent edits require a manual push.

In CI/prod, run `npx convex deploy` with `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY` set as env vars.

This is an open-source (AGPL) project. Do not commit secrets, API keys, or internal docs.
