# iOS experience and system API assessment

## Observations

- The chat view still rebuilds `chatRows` when its body updates. Continuous scroll coordinates no longer enter view state; only changes to the bottom-anchor and return-button thresholds update the view. Draft input is isolated from the parent view and persisted after a short delay. Markdown, attributed text, and cards may still add layout cost; profiling is needed to identify actual causes of hitches.
- The message list uses a `VStack` and initially displays 40 rows. Loading older messages increases that number. Compare a `LazyVStack` with representative long conversations, but preserve the current reading position: the existing restoration uses content-height differences, while lazy layout estimates those heights.
- The keyboard uses the bottom safe area and scroll anchor. A fixed 350 ms follow-up scroll was removed because it could jump after the user started interacting. Verify keyboard movement, streaming replies, and browsing history on device.
- Profile a Release build on a physical device with short and long conversations, repeated history loading, fast scrolling, interactive keyboard dismissal, and streaming. Use the SwiftUI, Time Profiler, and Animation Hitches instruments; record the device, OS, message count, and before/after measurements before choosing further caching or rendering changes.

## Device regression scenarios

- Open and interactively dismiss the keyboard at the bottom, while reading history, and during deceleration. Check bottom anchoring, the return button, and the position after sending.
- Load older messages repeatedly and verify the reading position. Check that streaming, reconnection, and voice events do not unexpectedly pull the list to the bottom.
- Dismiss the keyboard with a draft and check that send remains available. Verify draft restoration or clearing after backgrounding, clearing, and sending.
- Switch, refresh, and scroll through asset and Space cards to check that stale previews do not replace current content. Check Reduce Motion, VoiceOver, and large text.

## Automated checks

From the repository root, run `scripts/test-ios-experience.sh` to check the bottom thresholds, return behavior, and draft persistence. These checks do not replace device UI validation. Run `swift test --package-path client/ios/PiStackKit` for model tests, including Space receipts.

Drafts are saved approximately 400 ms after typing stops and immediately when cleared, backgrounded, or the page disappears. A forced process termination during that interval may lose the latest input.

## System API priorities

1. **Notifications and direct reply:** Use UserNotifications for background results, grouped by conversation and linked to the relevant chat. Consider `UNTextInputNotificationAction` for replies. This needs server events, APNs, device-token registration and invalidation, deduplication, permission onboarding, lock-screen privacy, and retry behavior. Start with ordinary notifications. [Apple documentation](https://developer.apple.com/documentation/UserNotifications/declaring-your-actionable-notification-types)
2. **App Intents and App Shortcuts:** Expose frequent actions such as opening an assistant or starting a conversation to Siri and Shortcuts. Define account and assistant identity, behavior when signed out, and confirmation for sensitive content. [Apple documentation](https://developer.apple.com/documentation/appintents)
3. **Communication notifications:** The system offers participant avatars and other presentation for direct communications. This requires the capability, message intents, participant identities, and background notification processing. Check whether assistant notifications meet Apple's requirements before adoption. [Apple documentation](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications)
4. **Live Activities:** Consider these for long-running tasks a user explicitly chooses to follow, not per-token streaming. They require a task lifecycle, push and end policies, and handling of system duration limits. [Apple documentation](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)

The current code search did not find a complete APNs or UserNotifications integration. These are proposals, not implemented features.
