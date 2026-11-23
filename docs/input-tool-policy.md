# 对话输入与工具禁用设计

服务端可以为一个 input 指定禁用工具。限制跟随提交记录，在 input 实际加入运行后生效。异步回调可以在拿到结果后才决定限制，例如让 delegate 完成回调处理结果时禁用 `send_to_user`。成功发送的 Assistant Message 记录当时所在的运行和已加入的 inputs，便于从 Chat 历史追溯来源。

## ID 和数据模型

| 标识 | 用途 |
| --- | --- |
| `requestId` | 沿用会话内的提交去重键和现有 Chat 投递关联。 |
| `SubmissionId` | pi-durable 分配的 input ID。提交记录沿用已有的 `entry` 字段指向输入条目。 |
| `turnId` | 本轮首个 `LiveDoc.run.inputs` 成员的 `SubmissionId`。与 `conversationId` 一起标识一次运行。 |
| `callId` | 沿用 `send_to_user` 的调用 ID，标识一条 Chat 消息或卡片。 |

一轮运行可以跨多次模型调用和工具执行。pi-durable 在轮内把后续入轮的 `steer` 追加到 `run.inputs`，同时可能更换 generation task。以首个 input 为锚点，运行 ID 在这些交接之间保持稳定。历史关联只需要存本会话内的 ID，跨会话引用同时携带 `conversationId`。

新增一个按会话持久化的 pi-durable 文档。普通输入沿用原有提交路径，只有带来源关联或禁用项的 input 才有单独记录。

```ts
type InputToolPolicy = {
  originSubmissionIds: SubmissionId[]
  disabledTools: string[]
}

type ConversationToolPolicy = {
  inputs: Record<string, InputToolPolicy> // 键为 SubmissionId
  activeTurn?: {
    turnId: SubmissionId
    disabledTools: string[]
  }
}

type ReplyTurn = {
  turnId: SubmissionId
  inputSubmissionIds: SubmissionId[]
}
```

`originSubmissionIds` 记录直接触发本次 input 的上游提交，用于追溯跨轮的因果关系。策略由发起提交的服务端业务代码显式指定。需要把上游限制继续带下去时，由回调在提交时写入新 input 的 `disabledTools`。工具执行时只读取已经算好的禁用清单。

## 提交与回调

1. 业务处理器提供 input 的原始 `requestId`、来源 IDs 和禁用工具清单。用同一个 pi-durable 事务调用 `submit(tx, draft)` 并按返回的 `SubmissionId` 保存策略。按名称校验和去重禁用项。
2. 同一会话用相同 `requestId` 重试时，沿用首次提交的 input 和策略。回调重放也使用同一个回调 `requestId`。这使去重、入队和策略保存具有相同的提交边界。
3. Delegate 完成回调在已有的 `settle` 事务里用 `run.origin` 填写来源，按当次结果选择禁用项，再提交 `delegate_result`。用该次执行的 `noticeId` 去重，沿用 `linkFollowup` 更新投递关联和记忆。删除完成等业务回调在发起异步操作时持久化来源 IDs，在回传结果时走相同的提交入口。

例如，用户 input `42` 发起 delegate，主会话照常发确认。完成回调提交 input `57`，保存来源 `[42]` 和禁用项 `["send_to_user"]`。如果 `57` 开启新一轮，该轮的 `turnId` 是 `57`。原始 input `42` 和回调 input `57` 可分别追踪，回调可以在完成时独立决定是否禁用发送。[Delegate 来源记录](../core/src/delegate/tool.ts) · [完成回调](../core/src/delegate/lifecycle.ts) · [后续提交关联](../core/src/conversation/requests.ts)

回调也可以给正在执行的轮次追加禁用项。此时它在异步操作启动时就保存明确的 `{ conversationId, turnId }`。完成时在事务内对照当前 `LiveDoc.run.inputs[0]`，匹配就合并禁用项。目标已结束或已切换时返回 `stale_turn`。这项限制作用于该轮后续通过执行检查的工具调用。

## 入轮和工具执行

| 情况 | 生效规则 |
| --- | --- |
| input 在 inbox 排队 | 现有运行继续使用当前策略。 |
| `steer` 实际加入当前轮 | 从该 input 入轮起，禁用项加入本轮的有效清单。 |
| `followUp` 在边界被取出 | 按下一轮实际入轮的 inputs 计算。队列边界可能同时取出 `steer`。 |
| 一轮含多条 input | 取各 input 禁用项的并集，再合并该 `turnId` 的追加项。需要独立工具权限的工作须运行在不同轮次。 |

执行检查放在受控工具的 `execute` 入口。第一种受控工具是 `send_to_user`。扩展到其他工具时复用同一个检查，并将检查接入该工具的执行入口。提交入口只接受已经接入检查的工具名。

检查使用工具的 `api.commit` 在同一个事务里读取当前运行和策略。通过 `api.taskId` 对照当前轮的工具槽，包含嵌套调用的槽。工具任务已脱离当前运行时，按过期调用处理。有效禁用清单命中时返回 `isError: true` 和诊断码 `tool_disabled`，在工具业务逻辑前退出。回调写入和工具检查以事务先后为准。已通过检查的调用可以完成，重放时重新检查。模型可以看到工具声明，执行是否获准由服务端检查决定。

`send_to_user` 被拒绝时走现有失败结果路径，Chat 只投影成功的工具结果。对于直接带有发送禁用项的 Chat input，投递补发应识别该策略并跳过该 input。回调或指定运行上的禁用项只约束对应轮次，原始 Chat 请求继续按现有投递流程处理。[发送工具](../core/src/send/tool.ts) · [投递补发](../core/src/conversation/requests.ts) · [Chat 消息投影](../client/ios/LuluKit/Sources/LuluKit/Session/View.swift)

## Assistant Message 来源

把执行检查当时得到的 `ReplyTurn` 写入成功的 `send_to_user` 工具结果 `SendDetails.turn`。从同一组 `inputSubmissionIds` 计算现有的 `requestIds`。即使投递账本没有匹配项，只要运行有 inputs，成功发送的消息依然可以追溯。历史消息的 `turn` 可缺省，客户端可以从对应工具结果按需读取该字段。

例如，`42` 开启运行后先发确认，`43` 通过 `steer` 加入后再发结果。确认记录 `{ turnId: 42, inputSubmissionIds: [42] }`，结果记录 `{ turnId: 42, inputSubmissionIds: [42, 43] }`。这组 ID 表示每次发送时已参与运行的 inputs。对没有成功发送的运行，执行检查使用活跃状态中的 `turnId` 和 `run.inputs`。[发送结果类型](../core/src/protocol/send.ts) · [现有回复关联](../core/src/conversation/requests.ts)

## 实现落点

- 在 `core/src/conversation/` 管理策略文档、提交绑定、活跃轮次更新和执行检查。让 `requests.ts` 的投递逻辑复用这组 input IDs，并识别需要跳过的补发。
- 在 `core/src/delegate/lifecycle.ts` 的完成回调接入统一提交入口，由业务调用方显式提供禁用项。
- 在 `core/src/send/tool.ts` 接入执行检查和成功发送的来源记录，在 `core/src/protocol/send.ts` 定义可选的 `SendDetails.turn`。

## 验收场景

| 场景 | 预期 |
| --- | --- |
| 普通 input 发送确认和最终回复 | 两条消息共用 `turnId`，各有 `callId`，最终回复仍可回执。 |
| 带限制的 `steer` 等待入轮 | 入轮前发送成功，入轮后的工具尝试返回 `tool_disabled`，且工具本体未执行。 |
| 带限制的 `followUp` 与 `steer` 同时入轮 | 本轮按实际成员取禁用项并集。下一轮按自身成员重新计算。 |
| Delegate 回调提交静默 input | 原始确认可见，回调 input 保留来源 ID，回调入轮后发送被拒绝。 |
| 回调为活跃目标追加禁用项 | 追加事务提交后的执行检查会拒绝该工具。 |
| 回调重放或进程重启 | 提交和策略沿用原记录，恢复执行的工具重新检查。 |
| 回调晚于目标运行结束 | 返回 `stale_turn`，已经开启的新轮可以照常发送。 |
| 明确禁用发送的 Chat input | 投递补发不为该 input 另起发送。 |
| 历史消息缺少 `turn` | 仍按现有消息和卡片格式展示。 |
