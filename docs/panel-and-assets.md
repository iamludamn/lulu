# Panel and Assets

## Core APIs

| API | Purpose |
| --- | --- |
| [`send_to_user`](../core/src/send/tool.ts) | Offer a Checklist or Asset in Chat. Use `widget: { kind: "panel", panel: { body: { kind: "schedules" } } }` to offer the system Schedule Overview. |
| [`widget.keep` / `widget.drop`](../core/src/panel.ts) | Accept or remove a card's item by `origin`. |
| [`panel` with `action: "update"`](../core/src/panel.ts) | Update an accepted Checklist by ID. `widget.check` saves a user's checkmark. |
| [`/artifacts/file`, `/spaces/state`, `/spaces/refresh`](../core/src/server/api.ts) | Download a file, read or save Space state, or manage Space background data. |

## Core entities

| Entity | Identity and purpose |
| --- | --- |
| Panel / Widget | `PanelDoc` stores accepted Widgets in display order. Each Widget has a stable `widget.id`. |
| Checklist | A `list` Widget with a `done` boolean on every row. The message-to-widget action creates a Checklist from actionable items in an earlier reply. On the iOS Panel, each completed item disappears and the card hides when all items are complete. Checkmarks stay saved, and completed checklists do not count against the Panel limit. |
| Space | Existing interactive pages remain available on Panel. The Widget ID identifies the versioned page and cover, saved state, and background refresh. New model offers and revisions are paused. |
| Assets / Asset | `AssetsDoc` stores accepted files. An HTML Asset captures the content at generation time. |
| Artifact | `artifact://name@version` identifies a stored file. |
| Schedule Overview | A Widget that shows current jobs from `CronJobsDoc` after acceptance. On iOS, the card shows the earliest active occurrence in local time, and the Panel card expands in place to show the full queue. Each Chat card holds the snapshot from its send. |

The model's offer and update schemas are narrower than the stored Widget schema. Existing stat, gauge, chart, plain or mixed list, timeline, note, media, weather, and actions cards retain their original Chat and Panel formats. Set an [Alarm](execution.md) through Schedule to receive a reminder in Chat.
