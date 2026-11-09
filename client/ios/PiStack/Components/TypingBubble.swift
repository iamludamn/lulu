import SwiftUI

struct TypingBubble: View {
    let text: String
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduced

    var body: some View {
        TimelineView(.animation(paused: reduced)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let swell = reduced ? 0 : 0.5 - 0.5 * cos(time * .pi)
            let beat = reduced ? 0 : 0.5 - 0.5 * cos(time * 2 * .pi)
            HStack(spacing: 8) {
                TypingDots(reduced: reduced)
                if !text.isEmpty {
                    Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 13.5)
            .frosted(20)
            .scaleEffect(1 + 0.04 * swell)
            .background(alignment: .bottomLeading) {
                ZStack(alignment: .bottomLeading) {
                    tail(12).offset(x: 2, y: 2).scaleEffect(1 + 0.1 * beat, anchor: .bottomLeading)
                    tail(6).offset(x: -4, y: 9).scaleEffect(1 + 0.1 * beat, anchor: .bottomLeading)
                }
            }
        }
        .scaleEffect(shown ? 1 : 0.5, anchor: .bottomLeading)
        .opacity(shown ? 1 : 0)
        .padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.snappy, value: text)
        .onAppear { withAnimation(.spring(duration: 0.4, bounce: 0.3)) { shown = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("助手正在输入")
    }

    private func tail(_ size: CGFloat) -> some View {
        Circle()
            .fill(.ultraThinMaterial)
            .overlay { Circle().fill(Color.frost) }
            .frame(width: size, height: size)
    }
}
