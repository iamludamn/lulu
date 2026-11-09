import SwiftUI

struct TypingDots: View {
    var size: CGFloat = 9
    var reduced = false

    var body: some View {
        TimelineView(.animation(paused: reduced)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4.5) {
                ForEach(0..<3, id: \.self) { index in
                    let fade = reduced ? 0.7 : 0.5 - 0.5 * cos((time - Double(index) / 3) * 2 * .pi)
                    Circle()
                        .fill(.secondary)
                        .frame(width: size, height: size)
                        .opacity(0.4 + 0.6 * fade)
                }
            }
        }
    }
}
