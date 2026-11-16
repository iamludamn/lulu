# Development and deployment

## Prerequisites

Install Node.js 22.19 or newer, npm, and the Go version in `client/desktop/go.mod`. Run all npm install and build commands from the repository root. A Cloudflare deployment also needs your own account, Workers/Durable Objects access, a KV namespace, and Wrangler authentication.

The checked-in `apps/cf/wrangler.jsonc` describes the maintainer's deployment. Do not deploy it unchanged to another account. Worker names, KV IDs, and telemetry destinations are deployment-specific; none grants access by itself.

## Configure your instance

1. Run `npm ci` and `npm run build` at the repository root. `@lulu/core` exports compiled `dist`; Wrangler does not build it or `client/web/dist`.
2. Copy `apps/cf/wrangler.jsonc` to `apps/cf/wrangler.local.jsonc` (gitignored). Keep it in the same directory so relative paths still resolve.
3. Change the Worker `name`. Keep the Durable Object bindings and migration history intact. For a fresh account, create your own `LULU_MCP` namespace and replace its `id`. Local Wrangler development uses local storage by default.
4. Remove `OTEL_EXPORTER_OTLP_ENDPOINT` from the copied config until you have your own collector. Set `OTEL_SERVICE_NAME` as needed. Never send telemetry to the maintainer's endpoint.
5. Configure credentials for the features you use. `.env.index` inventories variable names without values; `apps/cf/src/env.d.ts` and the integration implementations are authoritative.

Set `CLOUDFLARE_ACCOUNT_ID` to your own account ID before **every** Wrangler command, even with an existing login. For example, from `apps/cf`:

```sh
export CLOUDFLARE_ACCOUNT_ID='<your-account-id>'
npm exec -- wrangler kv namespace create LULU_MCP --config wrangler.local.jsonc
```

### Configuration by feature

| Feature | Configuration |
| --- | --- |
| Chat | A configured provider credential: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `OPENCODE_API_KEY`. `LULU_MODEL` optionally overrides the selection using `provider/model-id`. The default is `deepseek/deepseek-flash`. |
| MCP registry | `MCP_ADMIN_TOKEN` and `MCP_ENCRYPTION_KEY`. The latter is a base64-encoded AES key; use 32 random bytes, generated and stored securely. Back it up with encrypted state. |
| Sandboxes | `E2B_API_KEY`; optional `E2B_TEMPLATE`, `E2B_DOMAIN`, `E2B_API_URL`, `E2B_SANDBOX_URL`. `SANDBOX_BACKEND` and `SANDBOX_BACKENDS` select/configure E2B backends. |
| Artifacts | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; optional `S3_REGION`. |
| Memory recall classifier | Optional `TYPESAFE_API_KEY`; missing credentials fall back to supplying memory context. |
| Search integrations | `TAVILY_API_KEY`, `EXA_API_KEY` where used. |
| Hold-to-talk ASR | `VOLC_SPEECH_ASR_API_KEY` with `volc.seedasr.sauc.duration` access. Streams mono 16 kHz PCM16 through the bot socket; cancel discards the recording, release sends only the final transcript, and slide-left places it in the composer. Recordings are limited to 60 seconds. |
| Voice | `DOUBAO_API_KEY`; optional `DOUBAO_WS_URL` and `DOUBAO_REPORT` control the transport and reporting mode. |
| Telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, optional `OTEL_SERVICE_NAME`. See [observability](observability.md). |

Missing optional integration credentials do not prevent compilation. They do not imply a feature is usable: model calls, sandbox execution, artifact storage, voice, and MCP setup must be verified separately for the configured instance.

## Secrets and local development

Keep credentials in a secret manager and inject them into the process. Do not create a repository `.env` or commit `.dev.vars`, secret exports, or deployment credentials. With 1Password, use your own Environment containing only the variables needed for this instance:

```sh
export LULU_ENVIRONMENT_ID='<your-1password-environment-id>'
cd apps/cf
CLOUDFLARE_INCLUDE_PROCESS_ENV=true op run --environment "$LULU_ENVIRONMENT_ID" -- npm exec -- wrangler dev --config wrangler.local.jsonc
```

Wrangler can include process environment variables as local bindings with `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`; use a dedicated credential scope. Do not reuse a broad shared environment for an untrusted local Worker. Existing `.dev.vars` or dotenv files can affect loading; remove stale local secret files securely before relying on process injection.

The local server defaults to port 8787. Pass `--port` and `--inspector-port` if they are occupied. In another terminal at the repository root, run `npm run dev -w @lulu/client` for the web development server. It proxies API and WebSocket requests to port 8787; set `LULU_WORKER_URL` if needed. Rebuild the core after core changes.

Local Wrangler state lives under `.wrangler/`. Do not commit it or point development commands at remote production storage. Native clients have their own server setting; configure your instance instead of the checked-in default.

## Deploy your instance

First establish the access boundary described in [SECURITY.md](../SECURITY.md). Protect all API and WebSocket routes and prevent bypass through alternate hostnames. The repository does not provision authentication, gateway policies, backups, or retention settings.

Provision each required Worker secret with `wrangler secret put NAME --config wrangler.local.jsonc`, using a secret manager rather than a plaintext file. For example, from `apps/cf`, with `CLOUDFLARE_ACCOUNT_ID` already set:

```sh
op run --environment "$LULU_ENVIRONMENT_ID" -- sh -c 'printf %s "$DEEPSEEK_API_KEY" | npm exec -- wrangler secret put DEEPSEEK_API_KEY --config wrangler.local.jsonc'
```

Repeat for the credentials needed by your enabled integrations. Never put secret values in Wrangler `vars`. From the repository root, build before deployment:

```sh
npm run build
cd apps/cf
npm exec -- wrangler deploy --config wrangler.local.jsonc
```

Review the target account and Worker before proceeding. Existing secrets are managed separately from code deployment. Back up Durable Object state, KV configuration, object storage, and encryption keys according to your recovery requirements. Review migrations before updating an existing instance; do not reset or delete production resources to resolve a migration error.

## Maintainer automation

`.github/workflows/ci.yml` checks PRs and pushes to `main`; it does not need deployment credentials. `.github/workflows/deploy.yml` deploys pushes to `main` using the checked-in production config and `CLOUDFLARE_API_TOKEN`. It builds before Wrangler and sets `CLOUDFLARE_ACCOUNT_ID` explicitly.

For a fork, leave deployment disabled until you have configured your own account, resource IDs, secrets, and access boundary. Set the repository variable `CLOUDFLARE_ACCOUNT_ID` to opt into the deployment job and add a narrowly scoped `CLOUDFLARE_API_TOKEN` repository secret. Forks skip deployment when the account variable is absent. The original repository retains its existing account as a fallback; a repository variable overrides it. Existing production bindings must be reviewed before enabling deployment.
