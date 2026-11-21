# 001. Preserve Space compatibility and acceptance history

## Context

Panel documents and chat offers can outlive a release. Early Spaces were stored as `web` widgets and used a flat `spaces/<id>.html` path. Their panel records did not have a dedicated cover. Offers also outlive the widget they reference and can be retried after a newer revision has been accepted.

## Decision

Keep the existing wire format for stored Panel widgets and delivered Chat offers. The iOS decoder accepts the historical `web` kind and a missing cover. A Space can migrate from its exact legacy path to `spaces/<id>/index.html` and start a fresh version sequence while retaining the widget ID, placement, saved state namespace, and refresh preference unless the user explicitly changes it. Another widget kind or another Space's path cannot use this migration.

Only successfully delivered offers are actionable. Persist acceptance receipts in the Panel document, including when the widget is removed. On reconnect the client reconstructs offer status from delivered offers and these receipts. A pending local command does not record a successful acceptance. With a widget still present, replaying an already accepted offer is idempotent even after a newer version is accepted. After removal, the latest eligible version can be intentionally re-added and older cards cannot roll back the widget.

## References

- [Core wire format](../../core/src/protocol/panel.ts) and [iOS historical decoder](../../client/ios/PiStackKit/Sources/PiStackKit/Protocol/Panel.swift)
- [Delivered offers](../../core/src/send/sent.ts), [acceptance and migration](../../core/src/send/space-offers.ts), and [iOS offer status](../../client/ios/PiStackKit/Sources/PiStackKit/Session/SpaceOffers.swift)
- [Space acceptance regression tests](../../core/tests/space-offers.test.mjs)
