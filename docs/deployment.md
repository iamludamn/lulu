# Deployment

lulu runs as a single Cloudflare Worker named `lulu`, configured in `apps/cf/wrangler.jsonc`.

- URL: `https://lulu.jiahaowu0322.workers.dev`
- Cloudflare account ID: `de4897a194002b8815e728d7240c4218`. The login has two Cloudflare accounts, so every `wrangler` command must set `CLOUDFLARE_ACCOUNT_ID`.
- State: the `LULU_MCP` KV namespace and the Durable Objects `Bot`, `Memory` and `Artifact`. Migration history is in `wrangler.jsonc`.
- MCP server configs are encrypted in KV. OAuth credentials and pending sign-ins are encrypted in the Bot Durable Object; existing KV credentials are imported on first use.
- Destructive commands such as `wrangler delete` must pass `--name lulu` explicitly.
- The old `pistack-cf` worker was retired on 2026-11-01 and is not deployed.

## Build before deploy

`@lulu/core` exports its compiled `dist`, and the worker serves `client/web/dist`. Wrangler does not compile either, so run `npm run build` at the repository root before `wrangler dev` or `wrangler deploy`.

## Automatic deploy

Every push to `main` runs `.github/workflows/deploy.yml`: install, `npm run check`, `npm run build`, then `wrangler deploy` from `apps/cf`. It needs only the repository secret `CLOUDFLARE_API_TOKEN`. The worker keeps its existing secrets, because a deploy never deletes secrets. Run the manual steps below only for a deploy from a branch or to change secrets.

## Deploy

Run `wrangler deploy` from `apps/cf` with the secrets file passed as `--secrets-file`. The worker reads these secrets:

- `E2B_API_KEY`
- `S3_*`
- `OPENCODE_API_KEY`
- `DOUBAO_API_KEY`
- `MCP_ENCRYPTION_KEY`
- `MCP_ADMIN_TOKEN` (the passphrase for the MCP registry page at `/mcp`; the registry API answers 503 until it is set)
- `OTEL_EXPORTER_OTLP_HEADERS` (see [observability](observability.md))

Secrets are never committed. They live in the root `.env` file, which is gitignored and can be used directly as the secrets file.

## Local development

`wrangler dev` needs the same build first. Port 8787 is often taken, so pass `--port` and `--inspector-port` when needed.
