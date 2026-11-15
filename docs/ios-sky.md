# iOS weather sky

The default sky theme renders broad blurred light fields rather than a screenshot asset. The supplied day, dusk, rain and night mockups include device chrome and widgets; those must not become wallpaper pixels. Other manually selected themes remain available.

Set a city in Settings → Sky weather. No GPS permission is requested. The entered city goes directly to Open-Meteo geocoding; its first match is shown with its resolved name and timezone. Clear it to stop weather requests. This is a manually selected location, not automatic device tracking. Ambiguous city names require checking the resolved result.

The forecast requests current WMO weather code, cloud cover and day/night, plus sunrise/sunset using absolute Unix timestamps and the location's automatic timezone. Wet weather uses muted gray-blue fields; clear sunset uses a warm diagonal field; night uses navy. Snow shares the overcast treatment. Missing solar times use the provider's day/night field. The system appearance remains authoritative for foreground colors, so light-mode nights are intentionally lifted and dark-mode daytime skies dimmed.

Cache: per normalized city, refreshed after 20 minutes, persistent across launches. Both observation and fetch timestamps must be within three hours; future timestamps are rejected. HTTP errors, invalid JSON and timeouts use only a bounded cached result. With no usable weather, the background uses device time (07–18 day, otherwise night), explicitly described in settings as time-only fallback. Returning to foreground refreshes; rendering reevaluates once a minute. Settings shows the resolved city, time zone and last successful fetch, or unavailable status. Existing panel weather is a separate daily forecast cache and may differ.

Provider: [Open-Meteo](https://open-meteo.com/), [API contract](https://open-meteo.com/en/docs). This reuses the existing public weather provider and adds no keys. Commercial distribution must evaluate the provider's service terms.

## Verification, 2026-11-15

- iOS 26.5 iPhone 17 Pro simulator, Debug simulator build succeeds (arm64 and x86_64).
- Existing Swift package suite: five passing tests.
- Temporary executable assertions: freshness boundaries/future timestamps, day/dusk/night, rain/snow/thunderstorm, missing solar times, Codable round trip and empty city; all pass.
- Actual Home captured for day/light, dusk/light, rain/light and night/dark using Debug-only `-lulu.sky.preview <day|dusk|rain|night>` launch arguments. This overrides appearance only, not weather acquisition, and is absent in Release. Real chat history inspected in day/light without sending messages. Private chat screenshots are deliberately excluded from Git.
- First pass had nearly uniform cloud illumination. Second pass reduces seven overlapping fields to four with separated positions, preserving broad defocus. Large colored weather-card decoration removed.
- Visual rubric: compare only the screen interior, excluding generated device frame; inspect base hue, cloud scale/softness, warm-band placement, glass separation, text/link contrast and absence of literal weather decoration. Day/dusk/rain match the direction; night remains smoother than the mockup, and opposite system appearance intentionally changes luminance. No numerical similarity measurement or 90% acceptance claim is made.
- Live geocoding returns Hangzhou. Forecast endpoint initially timed out; retry succeeded with Asia/Shanghai, WMO code 2, cloud cover 60%, is_day 0 and absolute sunrise/sunset timestamps. Launching the app with the city set to Hangzhou also populated `lulu.sky.v1.hangzhou` with the same code/cloud cover, resolved city, timezone and fresh observation timestamp; the Home displayed its night treatment. Controlled appearance captures do not prove networking or weather correctness.

Remaining acceptance: offline cache expiry/relaunch, ambiguous location resolution, cross-timezone sunrise/sunset, all four skies with real chat in both appearances and accessibility contrast measurement. Until completed, this is a draft PR, not a claim that the requested visual acceptance is complete.

Appearance evidence: [day](images/ios-sky/day-light.png), [dusk](images/ios-sky/dusk-light.png), [rain](images/ios-sky/rain-light.png), [night](images/ios-sky/night-dark.png).
