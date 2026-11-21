# 005. Admit scheduled work atomically and run coding tools in delegates

## Context

Pi Durable permits one submission admission per commit and requires it before other table writes. lulu also runs user-facing chat and delegated tasks in separate conversations with different tool sets.

## Decision

Give each due job its own commit. Admit its work before other table writes and advance its schedule in that same commit, so a failed dispatch does not mark the job as fired. Continue to use a separate child conversation with the default extensions for delegated work. That gives delegates the coding tools associated with their sandbox while the main conversation remains focused on chat and coordination.

## References

- [Cron dispatch](../../core/src/cron/engine.ts) and [execution overview](../execution.md)
- [Child configuration](../../core/src/delegate/spawn.ts), [main configuration](../../core/src/conversation/bot.ts), and [tool separation test](../../core/tests/sandbox-agent.test.mjs)
