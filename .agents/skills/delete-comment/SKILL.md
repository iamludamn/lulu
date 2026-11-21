---
name: delete-comment
description: Audit source comments in lulu, remove redundant or stale comments, file issues for workarounds, and move design rationale into ADRs. Use when asked for /delete-comment or to reduce comments in a named source area.
---

# Delete comments

1. Use the requested paths. If none are named, use the repository-wide source scope in [lint-comments.mjs](../../../scripts/lint-comments.mjs). Run `node scripts/lint-comments.mjs --inventory` from the repository root and review the parsed comments against their surrounding code, callers, tests, and history. Treat adjacent lines that explain one point as a single annotation.
2. Delete comments that restate the code or describe behavior that has changed. If a comment justifies a concrete workaround, remove it and open or link a repository issue with the affected code, the failure mode, and a testable outcome. Keep build directives such as Swift's tools-version and executable shebangs in the baseline while the toolchain needs them.
3. Move significant rationale into a focused record in [docs/adr](../../../docs/adr). Update an existing record when it already owns the decision. Preserve compatibility constraints and explain the consequence of changing the decision. Keep source behavior intact when removing comment text.
4. Remove obsolete entries from [comment-baseline.json](../../../scripts/comment-baseline.json). Match entries by path and exact comment text, with one entry per occurrence. Run `npm run lint` and the relevant project checks. Verify a temporary new comment causes a `no-comments` failure and remove the probe.
5. Report the baseline-to-current classification counts, the issues and ADRs, and the physical source lines saved. Inline comments count toward the number of comments but save zero lines when code still occupies the line. Report remaining directives separately.
