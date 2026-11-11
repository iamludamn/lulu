import SwiftUI

func readingLength(_ text: String) -> Int {
    let count = text.filter { !$0.isWhitespace }.count
    let step = count < 1000 ? 10 : 100
    return max(step, (count + step / 2) / step * step)
}

struct LongHint: View {
    let length: Int

    var body: some View {
        HStack(spacing: 4) {
            Text(verbatim: "轻点查看全文 · 约 \(length) 字")
            Image(systemName: "chevron.right").font(.caption2.weight(.bold))
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
    }
}

private struct LongReplyHighlight: ViewModifier {
    let radius: CGFloat
    let onRead: () -> Void
    @AppStorage private var read: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var visible = true

    init(radius: CGFloat, key: String, onRead: @escaping () -> Void) {
        self.radius = radius
        self.onRead = onRead
        _read = AppStorage(wrappedValue: false, key)
    }

    private static let period = 3.6
    private static let streak = Gradient(stops: [
        .init(color: Color.white.opacity(0), location: 0),
        .init(color: Color.white.opacity(0), location: 0.45),
        .init(color: Color.white.opacity(0.5), location: 0.8),
        .init(color: Color.white, location: 0.96),
        .init(color: Color.white.opacity(0), location: 1),
    ])

    private var idle: Bool { !visible || reduceMotion }
    private var light: Bool { scheme == .light }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background { if !read { glow(shape) } }
            .overlay { if !read { border(shape).opacity(0.6) } }
            .onScrollVisibilityChange(threshold: 0.05) { visible = $0 }
            .onTapGesture {
                read = true
                onRead()
            }
    }

    private func glow(_ shape: RoundedRectangle) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: idle)) { context in
            let breath = reduceMotion ? 0 : sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.period)
            shape.stroke(Color.white, lineWidth: light ? 3 : 4)
                .blur(radius: light ? 10 : 9)
                .opacity(reduceMotion ? (light ? 0.45 : 0.35) : (light ? 0.3 + 0.08 * breath : 0.28 + 0.07 * breath))
        }
        .allowsHitTesting(false)
    }

    private func border(_ shape: RoundedRectangle) -> some View {
        ZStack {
            shape.strokeBorder(light ? Color.black.opacity(0.1) : Color.white.opacity(0.3), lineWidth: 0.6)
            if reduceMotion {
                shape.stroke(Color.white, lineWidth: 6).blur(radius: 4).opacity(light ? 0.9 : 0.55)
                shape.strokeBorder(Color.white.opacity(0.85), lineWidth: 1.5)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: idle)) { context in
                    let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                    let sweep = AngularGradient(gradient: Self.streak, center: .center, angle: .degrees(turn * 360))
                    ZStack {
                        shape.stroke(sweep, lineWidth: light ? 16 : 12).blur(radius: light ? 12 : 8)
                        shape.stroke(sweep, lineWidth: light ? 7 : 5).blur(radius: light ? 4 : 3)
                        shape.strokeBorder(sweep, lineWidth: light ? 2.5 : 2)
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

extension View {
    func longReplyHighlight(radius: CGFloat, key: String, onRead: @escaping () -> Void) -> some View {
        modifier(LongReplyHighlight(radius: radius, key: key, onRead: onRead))
    }
}

struct LongReader: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(verbatim: "全文 · 约 \(readingLength(text)) 字")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭全文")
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.top, 12)
            ScrollView {
                MarkdownText(text: text, selectable: true, document: true)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 28)
            }
        }
        .background(Color.paper.opacity(0.6))
        .presentationDetents([.fraction(2.0 / 3.0), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(.regularMaterial)
    }
}
