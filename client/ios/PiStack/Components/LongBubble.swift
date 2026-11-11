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

struct LongBubbleBounds: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }

    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct LongReader: View {
    let summary: String
    let text: String
    let origin: CGRect
    let canvas: CGSize
    let onClose: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    @State private var revealed = false
    @State private var closing = false
    @State private var drag: CGFloat = 0

    private var target: CGRect {
        let width = min(720, canvas.width - 20)
        let height = canvas.height * 2 / 3
        return CGRect(x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width: width, height: height)
    }

    private var frame: CGRect { expanded || reduceMotion ? target : origin }
    private var radius: CGFloat { expanded ? 28 : 20 }
    private var motion: Animation { .spring(response: 0.38, dampingFraction: 1) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.opacity(expanded ? 0.25 : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(.regularMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .fill(Color.paper.opacity(0.6))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6)
                }
                .shadow(color: .black.opacity(expanded ? 0.25 : 0), radius: 24, y: 8)
                .frame(width: frame.width, height: frame.height)
                .position(x: frame.midX, y: frame.midY + drag)
                .opacity(reduceMotion && !expanded ? 0 : 1)
            VStack(alignment: .leading, spacing: 8) {
                MarkdownText(text: summary, airy: true)
                LongHint(length: readingLength(text))
            }
            .lineSpacing(3)
            .padding(.horizontal, 15)
            .padding(.vertical, 10)
            .frame(width: origin.width, height: origin.height, alignment: .topLeading)
            .position(x: origin.midX, y: origin.midY)
            .opacity(expanded || closing || reduceMotion ? 0 : 1)
            .animation(.easeOut(duration: 0.08), value: expanded)
            .allowsHitTesting(false)
            reader
                .frame(width: target.width, height: target.height)
                .clipShape(.rect(cornerRadius: 28, style: .continuous))
                .position(x: target.midX, y: target.midY + drag)
                .mask {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .frame(width: frame.width, height: frame.height)
                        .position(x: frame.midX, y: frame.midY + drag)
                }
                .opacity(revealed ? 1 : 0)
                .allowsHitTesting(revealed && !closing)
        }
        .task {
            withAnimation(reduceMotion ? .easeOut(duration: 0.15) : motion) { expanded = true }
            do {
                try await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 280))
            } catch { return }
            guard !closing else { return }
            withAnimation(.easeOut(duration: 0.16)) { revealed = true }
        }
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { close() }
    }

    private var reader: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Capsule().fill(Color.secondary.opacity(0.45)).frame(width: 36, height: 5)
                HStack {
                    Text(verbatim: "全文 · 约 \(readingLength(text)) 字")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.caption.weight(.semibold))
                            .frame(width: 44, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("关闭全文")
                }
            }
            .padding(.leading, 20)
            .padding(.trailing, 8)
            .padding(.top, 8)
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { if !closing { drag = max(0, $0.translation.height) } }
                    .onEnded { value in
                        if value.translation.height > 80 {
                            close()
                        } else {
                            withAnimation(motion) { drag = 0 }
                        }
                    }
            )
            ScrollView {
                MarkdownText(text: text, selectable: true, document: true)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 28)
            }
        }
    }

    private func close() {
        guard !closing else { return }
        closing = true
        withAnimation(.easeOut(duration: 0.1)) { revealed = false }
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : motion) {
            expanded = false
            drag = 0
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 150 : 380))
            onClose()
        }
    }
}
