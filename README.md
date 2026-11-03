# OAT — AI Agent Infrastructure Backend

A TypeScript/Fastify backend that coordinates calls to external AI and data providers. It runs declarative workflows, verifies their outputs against explicit criteria, and records everything for audit and observability.

It is **not** an agent runtime. No model decides control flow. Every step and dependency is fixed in a stored workflow definition, and the actual work is delegated to external providers.

## Run it on your computer

The `getoat` command runs the API and Console together on your own machine, using your own provider keys. It listens on `127.0.0.1` only, and your keys and data stay in `~/.getoat` (or `GETOAT_HOME`).

```bash
npm install && npm run build
node dist/cli/index.js          # first run asks for your API keys, then opens the Console
node dist/cli/index.js --mock   # try it with labelled sample output, no keys needed
```

The package is not on npm yet. Once it is, the command will be `npx getoat`.

| Command | Purpose |
|---|---|
| `getoat` | Start OAT and open the Console (`--port`, `--no-open`, `--mock`) |
| `getoat setup` | Add or change provider API keys |
| `getoat token` | Print your local access token |

## Quick start

```bash
npm install
cp .env.example .env
npm run token:create -- alice admin   # put the printed "alice:admin:<hash>" into AUTH_TOKENS
npm run migrate                       # optional; the server also migrates on start
npm run dev                           # http://127.0.0.1:3000/api/v1/health
```

To try workflows without any provider keys, set `ENABLE_MOCK_PROVIDERS=true` (development only). Mock output is prefixed `[MOCK]`, and every record produced from it is labelled `isMock: true`.

| Script | Purpose |
|---|---|
| `npm run dev` | Watch mode (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled server |
| `npm test` | Unit + integration tests (all external calls mocked) |
| `npm run typecheck` / `npm run lint` | Type check / ESLint |
| `npm run migrate` | Apply DB migrations |
| `npm run token:create -- <user> [admin\|user]` | Generate an API token + its `AUTH_TOKENS` entry |

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; developed on Node 24).

## Architecture

```
src/
  api/            API gateway: Fastify app, envelope, error handling, auth hooks, routes (/api/v1)
  auth/           Bearer-token auth (hashed tokens), roles → permissions, ownership scoping
  config/         Strict env validation (zod) + .env loader
  providers/      Provider Manager, capability contracts, adapters (anthropic, gemini, jina, tavily, exa, github, mock)
  orchestration/  Workflow definition schema, static validation (DAG/refs), templates, coordinator
  verification/   JSON Schema + acceptance-criteria engine with evidence
  observability/  HTTP metrics (provider metrics are persisted)
  storage/        SQLite (node:sqlite), migrations, repositories
  lib/            Errors, secret redaction, SSRF guard, safe JSON paths
```

**Request path:** gateway (request ID → CORS/helmet → rate limit → auth → permission → zod validation) → route → repositories / coordinator → ProviderManager → adapter → external API.

**Provider Manager.** Every capability has one input/output contract (`providers/capabilities.ts`). The manager:

- validates the input
- runs the SSRF preflight for URL inputs
- picks providers using the configured routing (healthy ones first)
- applies a per-attempt timeout
- retries timeouts, 429s, 5xx and network errors with exponential backoff and jitter, honouring `Retry-After`
- validates the adapter's output against the contract
- restricts a capability to the providers named in `PROVIDER_ROUTING` (for example `llm.generate=gemini`). The routing is strict: if no routed provider is configured, the capability is unavailable and the API names the missing setting, with no silent switch to another provider or the mock.
- falls back to the next provider only when the capability is marked `fallbackCompatible`: `web.search`, `web.extract` and `text.rerank`. `text.embed` is excluded because vectors from different providers aren't interchangeable, and `llm.generate` and `github.repo` are excluded too.
- normalizes errors to codes such as `timeout`, `rate_limited`, `auth_failed`, `malformed_response`, `refused`, `blocked_url` and others
- tracks passive health and persists every call's latency, attempts, usage and estimated cost

**Orchestration.** A workflow is a DAG of up to 50 steps. Each step is one capability call whose `input` can reference `{{input.*}}` or `{{steps.<dep>.output.*}}`. Validation rejects cycles, unknown dependencies and references to non-dependencies. The coordinator:

- runs independent steps in parallel (`maxParallelism`)
- skips dependents of failed steps
- supports `continueOnError`, cancellation, execution timeouts and a global concurrency cap
- persists state, duration, attempts, fallbacks and errors for each step

On restart, executions that were in flight are marked `interrupted`.

**Verification.** Each step can declare a JSON Schema plus criteria: `required`, `min_items`, `max_items`, `string_length`, `contains`, `not_contains`, `equals`, `number_range` and `urls_in_step`. The last one is a grounding check: every URL cited in the output must appear in a retrieval step's results. Each check is stored with evidence.

A verification records `factualClaimsVerified: false` every time, and its summary separates three things:

- **Structural conformance:** the output matches the declared schema and criteria.
- **Citation tracing:** cited URLs were actually returned by a retrieval step.
- **Factual truth:** never established by this engine.

User schemas are untrusted. `pattern` and `patternProperties` are rejected (ReDoS risk), and only local `$ref`s are allowed.

## API (all under `/api/v1`)

Success responses use `{ data, meta: { requestId, page? } }`. Errors use `{ error: { code, message, details? }, meta: { requestId } }`. Every response carries an `x-request-id` header; you can send your own (8–128 chars of `[A-Za-z0-9._-]`).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /health` | public | Liveness |
| `GET /health/ready` | public | DB + migration readiness (503 if not ready) |
| `GET /providers` | user | Providers (configured/health) and capabilities with input/output JSON Schemas |
| `GET /providers/health` | user | Passive provider health |
| `POST /providers/health/probe` | admin | Active probes, where available without spending paid quota (Anthropic model lookup, GitHub `/rate_limit`); audited |
| `POST /workflows/validate` | user | Validate a draft without saving: errors, parallel stages, readiness |
| `POST /workflows` | user | Create workflow (422 if invalid, 403 if it uses disallowed capabilities) |
| `GET /workflows` | user | List own workflows (admin: all); `limit`, `offset` |
| `GET /workflows/:id` | owner/admin | Get workflow |
| `PUT /workflows/:id` | owner/admin | Replace the definition and bump `version` (422 if invalid, 403 for disallowed capabilities); past executions keep the version they ran |
| `DELETE /workflows/:id` | owner/admin | Permanently delete the workflow, its executions and verifications (409 while a run is active); provider statistics and audit events are kept |
| `POST /workflows/:id/validate` | owner/admin | Re-check against current providers; optional `{ input }` validated against `inputSchema` |
| `POST /workflows/:id/executions` | owner/admin | Start execution `{ input }` → **202** `{ id }`; 422 bad input, 409 provider unavailable |
| `GET /executions` | user | List own executions; filter `workflowId`, `status` |
| `GET /executions/:id` | owner/admin | Execution + per-step runs (status, provider, attempts, output, error, verificationId) |
| `POST /executions/:id/cancel` | owner/admin | Cancel an active execution (409 if not active) |
| `GET /verifications/:id` | owner/admin | Checks, evidence, and assessment |
| `GET /metrics` | admin | HTTP latency/status, provider calls/errors/tokens/cost, execution counts (`windowHours`) |
| `GET /audit-events` | admin | Audit trail |

Records owned by another user return 404, so IDs can't be probed.

### Example workflow

```json
{
  "name": "Research brief",
  "inputSchema": { "type": "object", "required": ["topic"], "properties": { "topic": { "type": "string" } } },
  "steps": [
    { "id": "search", "capability": "web.search", "input": { "query": "{{input.topic}}", "count": 5 } },
    {
      "id": "summary", "capability": "llm.generate", "dependsOn": ["search"],
      "input": { "prompt": "Summarize {{input.topic}} using only these results and cite URLs: {{steps.search.output.results}}" },
      "verification": {
        "criteria": [{ "type": "urls_in_step", "path": "text", "sourceStep": "search" }],
        "required": false
      }
    }
  ]
}
```

## Providers

| Provider | Capabilities | Enabled when | Notes |
|---|---|---|---|
| Anthropic (official SDK) | `llm.generate` | `ANTHROPIC_API_KEY` | Default `claude-opus-5-5`, explicit `effort`, server-side refusal fallback; refusals surface as `refused`. Cost estimated from published per-token rates. |
| Google Gemini | `llm.generate` | `GEMINI_API_KEY` (optional `GEMINI_MODEL`, default `gemini-3.6-flash`; `GEMINI_MAX_OUTPUT_TOKENS`, default 8192) | Free tier available. Key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sent in the `x-goog-api-key` header (never in URLs). On the free tier Google may use prompts and outputs to improve its products. No cost is estimated, because the API doesn't report the key's tier. Safety blocks surface as `refused`. |
| Jina AI | `text.embed`, `text.rerank`, `web.extract` | `JINA_API_KEY` (Reader also via `JINA_READER_KEYLESS=true`) | Shapes from `api.jina.ai/openapi.json`; Reader via `r.jina.ai` JSON mode. |
| Tavily | `web.search` | `TAVILY_API_KEY` | Primary search: `POST https://api.tavily.com/search` with `Authorization: Bearer`, `search_depth: basic` (1 credit per call). Key from [app.tavily.com](https://app.tavily.com). A 429 honours `Retry-After`. HTTP 432/433 (plan or pay-as-you-go limit reached) shows as `quota_exceeded`: not retried, falls back to Exa. Empty result lists are valid output (use `min_items` verification to require results). The admin active probe uses `GET /usage`, which Tavily limits to 10 requests per 10 minutes. |
| Exa | `web.search` | `EXA_API_KEY` | Fallback search; reports `costDollars`. |
| GitHub REST | `github.repo` | `GITHUB_TOKEN` | Read-only. |
| Mock | all | `ENABLE_MOCK_PROVIDERS=true` | Dev/test only; refused in production. |

Free-tier limits change. Check each provider's dashboard before relying on them. As of integration: Jina gives new keys free tokens, and the Reader allows 20 RPM without a key. Exa gives new accounts free credits. Tavily development keys are limited to 100 requests per minute; check your plan's monthly credits at app.tavily.com.

## Security summary

- Strict env validation. In production it requires `AUTH_TOKENS` and rejects the dev bypass, mock providers and wildcard CORS.
- Only SHA-256 hashes of API tokens are configured, and they are compared in constant time.
- Roles map to explicit permissions; non-admin users are scoped to the records they own. Each capability is allowlisted per user (`USER_ALLOWED_CAPABILITIES`).
- JSON-only request bodies with a size limit, and zod validation on every route.
- Rate limits per credential, with a tighter limit on execution starts and on probes.
- SSRF guard for `web.extract`:
  - only http(s) on ports 80/443, with no credentials in the URL
  - internal hostnames are blocked
  - DNS is resolved, and private, loopback, link-local, metadata and mapped addresses are rejected
  - optional allowlist and denylist
- Secrets are redacted from logs, persisted errors and audit details: configured key values, common key formats, bearer headers and private-key-shaped hex. Logs never include request bodies or authorization headers.
- No blockchain or financial capability exists, and the GitHub adapter is read-only.

## Web frontend (`web/`)

The landing page (`/`) and console (`/console/`) are vanilla TypeScript built with Vite. Vite was already in the toolchain through vitest, so no UI framework was added. Fastify serves the build from `web/dist` on the same origin as the API, with a strict CSP, immutable caching for hashed assets, and no rate limiting on static files.

| Command | Purpose |
|---|---|
| `npm run build` | Builds the server (`dist/`) and the frontend (`web/dist/`) |
| `npm run dev` + `npm run dev:web` | Backend on :3000, Vite dev server on :5173 proxying `/api` |
| `npm run test:e2e` | After `npm run build`: real-browser checks with installed Chrome/Edge (`CHROME_PATH` to override) at 320–1440px |

- **Landing page:** the hero's status card reads the public `/health` and `/health/ready` endpoints. The dashboard preview uses sample values and is labelled that way.
- **Console:** sign in with a personal API token. It is kept in `sessionStorage` for the current tab only, and provider keys never reach the browser. The console covers:
  - **Overview:** live provider health, capabilities, and active probes (admin only)
  - **Workflows:** templates, server-side validation and readiness
  - **Executions:** live polling, cancellation, and verification evidence
  - **Metrics:** admin only
- **Mock data:** anything produced by the mock provider is badged as MOCK.

## Frontend integration (custom clients)

1. Generate a token for the frontend's user with `npm run token:create -- <user> user` and add the printed entry to `AUTH_TOKENS`. Add the frontend origin to `CORS_ORIGINS`.
2. Send `Authorization: Bearer <token>` from a server-side proxy or BFF if you can, so the token never reaches the browser. For local development, calling the API directly is fine.
3. Call `GET /api/v1/providers` to build capability pickers. Each capability includes `inputSchema` and `outputSchema` (JSON Schema), `available` and `allowedForCaller`.
4. Call `POST /api/v1/workflows/validate` while the user edits a workflow. Show `errors[].path` and `message`, and render `stages` as the execution plan.
5. Call `POST /api/v1/workflows/:id/executions` to start a run. Poll `GET /api/v1/executions/:id` until `status` is `succeeded`, `failed`, `cancelled` or `interrupted`. There is no push channel yet.
6. For steps with a `verificationId`, show the verification's `assessment.summary` verbatim, and never present model output as "verified" beyond what it says. Badge results where `isMock` is true.
