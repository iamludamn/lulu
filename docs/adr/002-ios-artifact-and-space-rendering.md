# 002. Limit iOS HTML artifact and Space capabilities

## Context

The iOS client renders delivered HTML both as standalone artifacts and as Spaces. A Space can need live data and saved state. A chat preview should let the user inspect a Space without modifying the state of the accepted widget.

## Decision

Apply the offline content policy to ordinary HTML artifacts and standalone covers. For a Space with the native bridge, the content policy restricts direct connections from page scripts. The bridge handles the page's HTTP data fetches, accepts HTTPS GET requests under its URL checks, and can supply cached or managed data. Uncached reads can reach the network. File-backed caching is scoped to a bot and Space, and a cached response can be used when a refresh fails.

Use the widget ID within the bot as the Space's state namespace. Bridge-backed previews may read its saved state, but retain their own writes in memory for the life of the bridge. Legacy cards normally reuse cached data, can populate a missing entry, and can refresh on an explicit user request. Full-screen Spaces use their configured refresh policy unless managed data owns the refresh.

## References

- [Content policies](../../client/ios/PiStack/Components/HTMLTheme.swift) and [artifact viewer](../../client/ios/PiStack/Components/ArtifactViewer.swift)
- [Bridge](../../client/ios/PiStack/Components/SpaceBridge.swift), [cache](../../client/ios/PiStack/Components/SpaceFetcher.swift), and [card rendering](../../client/ios/PiStack/Components/SpacePreview.swift)
