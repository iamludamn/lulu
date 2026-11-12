import SwiftUI

struct TypingDots: View {
    var size: CGFloat = 9
    var reduced = false

    var body: some View {
        TimelineView(.animation(paused: reduced)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4.5) {
                ForEach(0..<3, id: \.self) { index in
                    let phase: Double = time * (2 * Double.pi / 1.2) - Double(index) * (Double.pi / 3)
                    let pulse: Double = reduced ? 0 : max(0, sin(phase))
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
