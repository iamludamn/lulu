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
