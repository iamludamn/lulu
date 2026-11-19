# Space revision offers

GitHub: https://github.com/iamludamn/lulu/issues/49
Linear: https://linear.app/ludamn/issue/LUD-318

## Interaction

Creation and revision use the same preview card and left swipe. Creation says
“滑动加入视图”; revision says “滑动更新视图”. Opening a proposal is a preview:
its state writes remain in memory. Only a successful keep transaction replaces
the panel entry. The Space ID, position, saved-state namespace and omitted
refresh preference survive an update. A copy must use a new ID and artifact path.

While submitting, the card stays visible and cannot submit twice. A failed
command leaves the preview with its error and “滑动重试”. Successful offers become
compact named receipts (“已加入视图” / “已更新”) with “打开当前版本”, which resolves
the panel's current artifact version. Superseded proposals show “已有新版” and have
no keep action. Cached proposals cannot be accepted while disconnected.

## Implementation

Chat used to hide only the latest kept origin. Keeping a new offer changed that
origin, making an older actionable card reappear. The keep handler also allowed
any old card to overwrite the current version.

`PanelState.spaceReceipts` is an additive optional map, keyed by accepted tool-call
origin, containing Space ID, artifact version, add/update action and optional
refresh preference. It is committed atomically with the panel change and retained
when a Space is removed. Legacy panel documents need no migration; removing or
revising a legacy Space records its previous version. Receipts provide both
success history and a version floor after removal. Saved user data is untouched.

Both server and client select the highest delivered artifact version, with the
last delivery winning ties. The transaction rejects obsolete proposals and
same/older replacements. Retrying an accepted offer while a Space is still kept
is a no-op, so it cannot replace a subsequent revision. The latest offer may be
intentionally re-added after removal. Failed or unfinished sends are excluded.

`panel.update` now refuses Space changes and directs the model to offer a revision
card, ensuring it cannot bypass swipe approval. Other widget updates retain their
existing tool path. Asset behavior and transcript entries remain unchanged.

## Validation plan

Prerequisites: Node dependencies installed from the lockfile, Xcode, an available
iOS simulator controlled through the T3 device panel, and deterministic fixture
data without production writes.

1. Reproduce keep A, keep B, then keep A on the original handler. Confirm stale
   A resurfaces after B and overwrites version 2 with version 1.
2. Repeat against the fixed handler. Confirm idempotent accepted retries cannot
   roll back a newer version, and superseded pending offers are refused.
3. Verify refresh preservation, explicit refresh changes, same-version resends,
   full-panel rejection/retry, removal/re-add, legacy decoding and reconnection
   from durable receipts. A failed transaction must leave no success receipt.
4. In the actual app, preview and swipe a new Space; propose a revision; open the
   current panel before accepting; swipe the revision; inspect prior cards.
   Position, one canonical panel entry and previously saved input must survive.
5. Inject a failed keep, retry it, reconnect/relaunch, and cancel a partial swipe.
   Failure/cancellation must leave the current Space intact. Capture screenshots
   and a recording; verify captions and the current-version open action.
6. Run `npm test`, `npm run check`, `npm run lint`,
   `swift test --package-path client/ios/PiStackKit`, and an iOS simulator build.

## Results (2026-11-12)

- Original handler regression reproduced with a transaction fixture.
- 8 Node tests pass, including the actual keep handler's transaction path.
- 5 Swift tests pass for card projection and legacy document compatibility.
- Workspace type checks and lint pass after a clean lockfile install.
- iOS simulator build passes.
- Full `npm run build` passes, including the web and desktop builds.
- Real iOS Simulator interaction passes on the actual built app with a local
  deterministic fixture backend invoking the production `keepWidget` handler:
  create/swipe add; propose @2 while @1 remains canonical; inject a failed keep;
  swipe retry; preserve ID/order/daily refresh/saved budget; open current @2 from
  the original receipt; supersede pending @3 with @4; relaunch/reconnect; partial
  swipe leaves the accepted @2 unchanged. This is not a production deployment or
  a two-device live sync test.
- Screenshots: `01-add.png`, `03-update.png`, `04-failed.png`,
  `05-updated.png`, `06-open-current.png`, `07-superseded.png`,
  `08-reloaded-panel.png`, `09-reconnected.png` in the evidence directory.
- The device block was a stale ownership record belonging to a completed
  verification thread. The owning thread released its own connection through
  `device_close`; no foreign session was reused and no claim files were changed.

Local evidence directory: `/tmp/lulu-49/` (baseline.log, core-test.log,
swift-test.log, check.log, lint.log, ios-build.log, alignment.html).
The HTML includes actual simulator screenshots and the verification results.
