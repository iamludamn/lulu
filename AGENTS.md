## dev rules

* 沿用 pi 官方提供的 package 与实现路径：优先使用 pi 包暴露的扩展点（如 `defineExtension`、`section`、`defineTool`、`SettingsManager`），先推测官方期望的用法再实现
* 代码中本身留有的可拓展项 **优先于** 其他路径绕过或自己单独实现
* 不写注释
* 不需要单元测试，在我没要求的情况在不主动测试
* 任何开发遵循数据结构优先，从数据结构出发，严禁过度设计（YAGNI）
* 代码仓库中在我没有明确要求的情况下不留文档，这会增加我的维护成本
* 新增代码逻辑时，应该优先考虑如何镜像优雅的模块拆分，思考是否有必要拆分，和现有模块的关系

### Durable 约定

参考 [Pi Durable](<https://earendil.com/posts/pi-durable/>)，具体用法以文档为准。

* 任务会重跑，有外部副作用的步骤需要幂等，新工具需显式声明 `replay`。
* 可恢复的状态放在 Doc 中，与 transcript 原子提交，不放在内存里。
* 注入模型的状态用 `section`；会话只保存 extension 与 tool 的名称，不保存代码。
* 提交的幂等与重试依赖 `requestId`，不依赖内存状态。
* Durable 的假设是和 OS & FS 解耦，所有理论上 Durable 链路上的代码除了 execution env 都不应该依赖 `node:fs`

## 分支与部署

* `main` 是 PiStack 产品线（origin 为 ZenlixAI/zbot-preview），`lulu` 分支是另一条独立的产品线（iOS 客户端 lulu），在 main 的基础上独立演进。**不要把 lulu 合并进 main，也不要把 main 的代码部署到 lulu 的 worker**。
* lulu 只部署为 Cloudflare worker `lulu`（账号 jiahaowu0322@gmail.com，ID `de4897a194002b8815e728d7240c4218`，地址 `https://lulu.jiahaowu0322.workers.dev`），配置在 `apps/cf/wrangler.jsonc`，使用独立的 KV `LULU_MCP` 和独立的 Durable Object 数据（单个迁移 v1）。原 `pistack-cf` 已于 2026-11-01 下线，不再部署。
* 账号下有两个 Cloudflare 账号，所有 wrangler 命令必须设置 `CLOUDFLARE_ACCOUNT_ID`。`apps/cf` 的配置名是 `lulu`，`wrangler delete` 一类的命令要显式写 `--name`。
* `@lulu/core` 对外导出的是 `dist`，改完源码必须先在仓库根目录 `npm run build`（同时构建 core 和 web），wrangler 不会自己编译。部署用 `wrangler deploy`，密钥用 `--secrets-file` 带上：`E2B_API_KEY`、`S3_*`、`OPENCODE_API_KEY`、`DOUBAO_API_KEY`、`MCP_ENCRYPTION_KEY`。
* 本地 `wrangler dev` 同样要先 build；8787 常被占用，需要时指定 `--port` 和 `--inspector-port`。

## 密钥与 ENV

* 项目用到的密钥统一放在仓库根目录的 `.env` 文件（`KEY="value"` 格式，已 gitignore，权限 600），不进仓库、PR、commit、ticket 和对话。部署时 `.env` 可直接作为 `--secrets-file`。
* 有多个 T3 environment（omarchy、Mac 等）时，`.env` 要在各设备间保持一致：任一设备新增或更新密钥后，用 `scp` 同步到其他环境仓库根目录的 `.env`，并比对 sha256。新环境缺 `.env` 时，先从已有环境拉取，不要让用户手动操作。
* Mac 上的仓库在 `~/AACS/lulu`，SSH 用 `a1234@wujiahaodemacbook-pro.tailfdc8bd.ts.net`；用短主机名会因 known_hosts 报 host key 验证失败。

## Observability

Self-hosted on omarchy. Honeycomb is no longer used.

### Data flow

* The worker exports OTLP/HTTP JSON **traces only** (`core/src/telemetry/otlp.ts`). It emits no metrics; metrics are derived from spans in the collector.
* Worker config: `OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.ludamn.xyz` (var in `apps/cf/wrangler.jsonc`) and `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` (secret, must be in the `--secrets-file` when deploying). The token is `OTLP_TOKEN` in `~/observability/.env` on omarchy. Never commit or print it.
* Ingress: Cloudflare Tunnel `lulu-otel` (ID `d14e48e1-9620-4f89-a69e-2fdaa06ddee5`, account `de4897a194002b8815e728d7240c4218`) routes `otel.ludamn.xyz` to `127.0.0.1:14318` on omarchy. It runs as the user systemd service `cloudflared-lulu-otel`; its token is in `~/.config/cloudflared/lulu-otel.env` (mode 600).
* Stack: `~/observability/` on omarchy (`docker-compose.yml`, `otelcol.yaml`, `.env`, `grafana/`). `otel/opentelemetry-collector-contrib` checks the bearer token (401 otherwise), derives metrics with the `span_metrics` and `signal_to_metrics` connectors, and forwards to `grafana/otel-lgtm` (Grafana, Tempo, Prometheus, Loki). Data lives in the docker volume `observability_lgtm-data`.

### Reading the data

* Humans: Grafana dashboard `lulu-overview` on omarchy port 3000. Reach it at `http://100.102.15.105:3000` over Tailscale, or with `ssh -L 13000:127.0.0.1:3000 ludamn@10.10.21.157` and open `http://127.0.0.1:13000`. The admin password is `GF_SECURITY_ADMIN_PASSWORD` in `~/observability/.env`.
* Agents: the `grafana` MCP server (`mcp-grafana`, read-only service account) is registered on omarchy; use TraceQL for traces and PromQL for metrics. `promtool` and `logcli` are in `~/.local/bin`. Prometheus listens on `127.0.0.1:9090` and Loki on `127.0.0.1:3100`, both local to omarchy.
* Metric names: `lulu_span_calls_total`, `lulu_span_duration_milliseconds_{bucket,count,sum}`, `lulu_run_{turns,chats,tools,tool_errors,input_tokens,output_tokens,cost}_total`, `lulu_chat_{input_tokens,output_tokens,cache_read_tokens,cost}_total`.
* Counters use **delta** temporality (Prometheus runs with `otlp-native-delta-ingestion`). Query them with `sum_over_time`, not `rate` or `increase`.

### Span conventions

* Every span carries `lulu.bot.id`, `lulu.agent` and `lulu.conversation.kind` (`root` or `delegate`).
* `lulu.run` carries per-run totals: `lulu.run.{turns,chats,tools,tool_errors,delegates,retries,compactions,input_tokens,output_tokens,cache_read_tokens,cost}`. `chat` carries `gen_ai.usage.*` and `lulu.usage.cost`.
* User messages are `bot.command prompt.submit` spans. Subagents are `lulu.run` spans with `lulu.conversation.kind=delegate`. Sandbox time is the duration of `sandbox.*` spans.
* A new dimension used in a dashboard must also be listed in the collector connector config in `otelcol.yaml`, otherwise it is dropped from the derived metrics.

### Access notes

* omarchy is `10.10.21.157` on the LAN. Port 22 on its Tailscale address is taken over by Tailscale SSH, so use the LAN address with the dedicated key `~/.ssh/omarchy_lulu_ed25519`. That key is restricted to `10.10.21.0/24` and to forwarding `127.0.0.1:3000`.
* Shadowrocket on the Mac captures traffic to `100.64.0.0/10` and breaks access over Tailscale. Add a DIRECT rule for that range.

## Git Workflow

### Commits

* Follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>`. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
* Scope is the affected area, such as `core`, `cf`, `web`, `ios`. Omit it when the change spans everything.
* Summary is imperative, lowercase, no trailing period, at most 72 characters.
* Breaking changes add `!` after the type or scope and a `BREAKING CHANGE:` footer.
* The body explains *why* when it is not obvious. Wrap at 72 columns. Do not restate the diff.
* Each commit is one logical change and leaves the tree building (`npm run build` at the root).
* Stage explicit paths with `git add <path>`, not `git add -A`. The working tree often holds unrelated in-progress work.
* Before committing, check `git diff --staged` for secrets such as API keys, `.dev.vars`, and `--secrets-file` contents.
* Never bypass hooks (`--no-verify`) or signing unless the user explicitly asks.
* End every commit message with the trailer `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.

### Branches

* Name branches `<type>/<short-kebab-description>`, for example `feat/otlp-observability`.
* Branch from the integration branch `lulu`. Never branch from or open a PR against `main` (PiStack product line).
* Keep one topic per branch. Rebase onto the latest `lulu` before opening a PR.
* Force-push only your own feature branch, and only with `--force-with-lease`. Never force-push `lulu` or `main`.

### Pull Requests

* Title uses the same Conventional Commit format as commit summaries.
* Body has a `## Summary` section (what and why) and a `## Test plan` section (how it was verified, or what was not verified).
* Squash-merge feature branches so `lulu` keeps one Conventional Commit per change.
* End the PR body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### Agent Behavior

* Do not commit, push, or open a PR unless the user asks.
* Do not delete branches, stashes, or uncommitted changes without confirming with the user.
