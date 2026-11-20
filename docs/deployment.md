# Deployment

## Configure Cloudflare

Use your own Cloudflare account and Wrangler login. Copy [wrangler.jsonc](../apps/cf/wrangler.jsonc) to `apps/cf/wrangler.local.jsonc`. Set your Worker name and `LULU_MCP` KV namespace ID, retain the Durable Object bindings and migrations, and point telemetry at your collector or remove its endpoint. Protect HTTP and WebSocket routes as described in [Security](../SECURITY.md).

Use a secret manager for Worker credentials. Chat requires a model provider credential. See [.env.index](../.env.index) and [env.d.ts](../apps/cf/src/env.d.ts) for supported settings. Set `CLOUDFLARE_ACCOUNT_ID` before all Wrangler commands.

## Object storage migration

Use the existing private bucket and S3 Worker credentials. The endpoint must support conditional `PutObject` and destination-conditional `CopyObject`. Existing deployments keep the Artifact Durable Object binding while the Worker imports the legacy index on first use. Keep it available until the import has completed. The files and existing pinned URLs use the same bucket paths after import.

The first Bot start seeds the external app state and the smaller startup projection. Subsequent startup reads use the projection directly. The Bot writes current app state before acknowledging a commit to the selected documents. An interrupted publication is resumed using its pending marker. If native copies are absent, the Bot hydrates them from the external app state. Use the same private bucket when replacing the Bot's local storage.

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

## Cloudflare Cron

Set the Worker bindings `LULU_CRON_ACCOUNT_ID` and `LULU_CRON_WORKER_NAME` to the account ID and deployed script name. Set `LULU_CRON_API_TOKEN` as a Worker secret using a dedicated API token with Workers Scripts Write access scoped to that account. Lulu owns the script's complete Cron Trigger list when these bindings are present. Leave `triggers.crons` unset in Wrangler and dedicate the script's triggers to Lulu.

The Worker routes Cron events to the existing Bot. Daily jobs can share a UTC rule and use their chosen time zone to select the correct occurrence. One-time jobs register a UTC calendar rule, round up to the next minute when needed, and release the rule after dispatch, expiration, pause, or deletion once no active job uses it. Short timers and unconfirmed registrations use the existing Durable Object Alarm while [Cron Trigger changes propagate](https://developers.cloudflare.com/workers/configuration/cron-triggers/). The same fallback applies when Cron bindings are absent or registration fails.

## iOS dictation correction

With `VOLC_SPEECH_ASR_API_KEY` configured, iOS dictation uses [second-pass recognition and disfluency cleanup](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) and a built-in final-transcript replacement (`库伯内特斯` → `Kubernetes`). These optional string bindings in the Worker's `vars` adjust the defaults.

- Set `VOLC_SPEECH_ASR_REFINE` to `"false"` to disable second-pass recognition and disfluency cleanup. The refined result can take longer to return after recording ends.
- Set `VOLC_SPEECH_ASR_CORRECTION_TABLE_ID` to use a Doubao Speech replacement table in place of the built-in rule. This works independently of `VOLC_SPEECH_ASR_REFINE`. See [replacement table setup](https://docs.volcengine.com/docs/doubao-voice/replacement-word?lang=zh).

To compare results, tap the microphone in the iOS chat composer, read the same sample with each configuration, and tap again to place the transcript in the draft. Try a sentence with a hesitation and a sentence containing a dictionary entry. Check both the wording and the time from stopping the recording to seeing the draft.

## Automatic deploy

[GitHub Actions](../.github/workflows/deploy.yml) checks, builds, and deploys pushes to `main` using the checked-in config. To opt in on a fork, first replace deployment settings, then set the `CLOUDFLARE_ACCOUNT_ID` repository variable and `CLOUDFLARE_API_TOKEN` secret.
