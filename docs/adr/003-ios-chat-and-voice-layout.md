# 003. Preserve iOS chat geometry and voice compositing

## Chat layout

Count the header gap in the transcript's measured height so short, bottom-aligned conversations remain positioned consistently. Place the long-message reader outside the pager so its backdrop covers the screen. Capture the chat page's original canvas and convert its origin into the overlay's coordinate space to preserve the source geometry. Read the bottom safe-area inset from the UIKit window so keyboard height cannot be subtracted as container padding.

While retrying a card action, hold the previous error presentation until the swipe interaction releases the row. Clearing the server error mid-animation would change the row's height and disturb the gesture.

## Voice rendering

Animate the authored cloud texture with a distortion pass that tapers displacement to zero at the edges, preventing exposed pixels. Draw the voice-reactive light rings in a separate pass and return premultiplied color for SwiftUI compositing. Use clear native glass with a soft rim so the texture remains visible while the controls retain their translucent edge.

## References

- [Transcript layout](../../client/ios/PiStack/Views/ChatView.swift), [reader overlay](../../client/ios/PiStack/Views/HomeView.swift), and [card interaction](../../client/ios/PiStack/Views/MessageRow.swift)
- [Voice composition](../../client/ios/PiStack/Views/VoiceAtmosphere.swift) and [shader passes](../../client/ios/PiStack/Views/VoiceAtmosphere.metal)
