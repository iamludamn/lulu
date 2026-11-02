import SwiftUI

struct TypingDots: View {
    var size: CGFloat = 8

    var body: some View {
        TimelineView(.animation) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: size * 0.55) {
                ForEach(0..<3, id: \.self) { index in
                    let wave = max(0, sin(time * 5 - Double(index) * 0.9))
                    Circle()
                        .fill(.secondary)
                        .frame(width: size, height: size)
                        .opacity(0.4 + 0.6 * wave)
                        .scaleEffect(0.85 + 0.25 * wave)
                }
            }
        }
    }
}
