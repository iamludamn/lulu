# Chat

## Core APIs

| API | Purpose |
| --- | --- |
| [`hello` / `state`](../core/src/protocol/wire.ts) | Open Chat and receive its snapshot or subsequent updates. |
| [`prompt.submit`](../core/src/conversation/bot.ts) | Submit a User Message. A successful result confirms acceptance. |
| [`send_to_user`](../core/src/send/tool.ts) | Deliver an Assistant Message with text, optional Markdown, or a [card](panel-and-assets.md). |
| [`prompt.receipts`](../core/src/conversation/requests.ts) | Report replies received by the client. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Conversation | `conversationId`. Owns the transcript. |
| User Message | `requestId` ties retries to the same request. The Submission ID tracks whether Pi placed and answered it. |
| Assistant Message | Text or a card delivered by a successful `send_to_user` call. Its `callId` identifies the message. |
