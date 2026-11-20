# Deployment

## Configure Cloudflare

Use your own Cloudflare account and Wrangler login. Copy [wrangler.jsonc](../apps/cf/wrangler.jsonc) to `apps/cf/wrangler.local.jsonc`. Set your Worker name and `LULU_MCP` KV namespace ID, retain the Durable Object bindings and migrations, and point telemetry at your collector or remove its endpoint. Protect HTTP and WebSocket routes as described in [Security](../SECURITY.md).

Use a secret manager for Worker credentials. Chat requires a model provider credential. See [.env.index](../.env.index) and [env.d.ts](../apps/cf/src/env.d.ts) for supported settings. Set `CLOUDFLARE_ACCOUNT_ID` before all Wrangler commands.

## Build and deploy

```sh
# From the repository root
npm ci
npm run build
cd apps/cf
export CLOUDFLARE_ACCOUNT_ID='<your-account-id>'
# Provision feature credentials with wrangler secret put NAME --config wrangler.local.jsonc.
npm exec -- wrangler deploy --config wrangler.local.jsonc
```

For local development, run `npm exec -- wrangler dev --config wrangler.local.jsonc` from `apps/cf`. To load bindings from a secret manager's process environment, set `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`. The Worker listens on port 8787 by default. For the Web client, run `npm run dev -w @lulu/client` from the root.

## iOS dictation correction

With `VOLC_SPEECH_ASR_API_KEY` configured, iOS dictation uses [second-pass recognition and disfluency cleanup](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) and a built-in final-transcript replacement (`库伯内特斯` → `Kubernetes`). These optional string bindings in the Worker's `vars` adjust the defaults.

- Set `VOLC_SPEECH_ASR_REFINE` to `"false"` to disable second-pass recognition and disfluency cleanup. The refined result can take longer to return after recording ends.
- Set `VOLC_SPEECH_ASR_CORRECTION_TABLE_ID` to use a Doubao Speech replacement table in place of the built-in rule. This works independently of `VOLC_SPEECH_ASR_REFINE`. See [replacement table setup](https://docs.volcengine.com/docs/doubao-voice/replacement-word?lang=zh).

To compare results, tap the microphone in the iOS chat composer, read the same sample with each configuration, and tap again to place the transcript in the draft. Try a sentence with a hesitation and a sentence containing a dictionary entry. Check both the wording and the time from stopping the recording to seeing the draft.

## Automatic deploy

[GitHub Actions](../.github/workflows/deploy.yml) checks, builds, and deploys pushes to `main` using the checked-in config. To opt in on a fork, first replace deployment settings, then set the `CLOUDFLARE_ACCOUNT_ID` repository variable and `CLOUDFLARE_API_TOKEN` secret.
