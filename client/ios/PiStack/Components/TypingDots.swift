import SwiftUI

struct TypingDots: View {
    var size: CGFloat = 9
    var reduced = false

    var body: some View {
        TimelineView(.animation(paused: reduced)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4.5) {
                ForEach(0..<3, id: \.self) { index in
                    let pulse = reduced ? 0 : max(0, sin(time * 2 * .pi / 1.2 - Double(index) * .pi / 3))
                    Circle()
                        .fill(.secondary)
                        .frame(width: size, height: size)
                        .opacity(reduced ? 0.82 : 0.4 + 0.6 * pulse)
                        .scaleEffect(reduced ? 1 : 0.85 + 0.25 * pulse)
                }
            }
        }
    }
}
