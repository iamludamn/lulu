# Panel and Assets

## Core APIs

| API | Purpose |
| --- | --- |
| [`send_to_user`](../core/src/send/tool.ts) | Send a card to Chat. The user can accept its Widget or Asset. The `schedule` tool emits overview cards until the user accepts the Widget. |
| [`widget.keep` / `widget.drop`](../core/src/send/keep.ts) | Accept or remove a card's item by `origin`. |
| [`panel` with `action: "update"`](../core/src/panel/tool.ts) | Update an accepted ordinary Widget by ID. Space page revisions require acceptance of a newer card with the same ID. |
| [`/artifacts/file`, `/spaces/state`, `/spaces/refresh`](../core/src/server/api.ts) | Download a file, read or save Space state, or manage Space background data. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Panel / Widget | `PanelDoc` stores accepted Widgets in display order. Each Widget has a stable `widget.id`. |
| Space | An interactive Widget. Its ID identifies its versioned page and cover, saved state, and background refresh. |
| Assets / Asset | `AssetsDoc` stores accepted files. An HTML Asset captures the content at generation time. |
| Artifact | `artifact://name@version` identifies a stored file. |
| Schedule Overview | A Widget that shows current jobs from `CronJobsDoc` after acceptance. Chat cards preserve their earlier snapshots. |
