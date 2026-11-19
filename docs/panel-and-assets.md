# Panel and Assets

Panel holds accepted Widgets in `PanelDoc`, including native widgets, Spaces, and the Schedule Overview. Assets holds accepted files in `AssetsDoc`.

## Sending and accepting cards

`send_to_user` sends a card to [Chat](chat.md) with a Widget for Panel or an Asset for Assets. An offer is part of the card interaction. The `schedule` tool emits the Schedule Overview card with a snapshot of job rows. The Scheduled Tasks screen reads current job state from `CronJobsDoc` through the API.

The wire format uses `type: "widget"` for a card, including when its payload is an Asset. The nested `kind: "panel"` and `kind: "asset"` select the destination. Space and Asset cards are checked against stored references before delivery.

Card delivery and acceptance are separate state changes. `widget.keep` resolves the delivered card by `origin` and updates `PanelDoc` or `AssetsDoc`. A Space revision retains the Widget ID and requires acceptance. Stored receipts prevent an old or retried card from rolling back a newer accepted revision.

## Spaces and HTML Assets

A Space is an interactive Widget. Its Widget ID identifies the page, cover, saved state, and background refresh settings. The page lives at `spaces/<id>/index.html`, its static cover at `spaces/<id>/cover.html`, and its saved state at `spaces/<id>/state.json`. Page revisions use a new artifact version, while background refresh updates the data that the page can read.

An HTML Asset is a finished file with content captured at generation time. Use a Space when the user expects fresh data or saved progress on later visits.

## Artifact storage

Artifacts use versioned `artifact://name@version` references. The Artifact object reserves an upload/version, stores bytes through the S3 adapter, and commits metadata after verifying the object exists. Provided request IDs map retries to the same reservation, and recommitting an upload returns its existing version. Preserve the reserve, upload, and commit sequence across the Durable Object and object store when adding write paths.

See [artifact storage](../core/src/artifact/object.ts), [acceptance](../core/src/send/keep.ts), [Space receipts](../core/src/send/space-offers.ts), and [Space refresh](../core/src/space/refresh.ts).
