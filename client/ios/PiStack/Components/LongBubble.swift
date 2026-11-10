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

private struct FlowingBorder: ViewModifier {
    let radius: CGFloat
    let paused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var visible = true

    private static let period = 3.6
    private static let streak = Gradient(stops: [
        .init(color: Color.white.opacity(0), location: 0),
        .init(color: Color.white.opacity(0), location: 0.45),
        .init(color: Color.white.opacity(0.5), location: 0.8),
        .init(color: Color.white, location: 0.96),
        .init(color: Color.white.opacity(0), location: 1),
    ])

    private var idle: Bool { paused || !visible || reduceMotion }
    private var light: Bool { scheme == .light }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background { glow(shape) }
            .overlay { border(shape) }
            .onScrollVisibilityChange(threshold: 0.05) { visible = $0 }
    }

    private func glow(_ shape: RoundedRectangle) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: idle)) { context in
            let breath = reduceMotion ? 0 : sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.period)
            shape.stroke(Color.white, lineWidth: light ? 4 : 5)
                .blur(radius: light ? 10 : 9)
                .opacity(reduceMotion ? (light ? 0.95 : 0.7) : (light ? 0.62 + 0.2 * breath : 0.58 + 0.16 * breath))
        }
        .allowsHitTesting(false)
    }

    private func border(_ shape: RoundedRectangle) -> some View {
        ZStack {
            shape.strokeBorder(light ? Color.black.opacity(0.1) : Color.white.opacity(0.3), lineWidth: 0.6)
            if reduceMotion {
                // 减弱动态效果：整圈静态高亮。浅色下气泡本身是白色磨砂，只靠白色细线看不出来，
                // 所以同时叠一圈向外的白色光晕和一圈带色的细线。
                shape.stroke(Color.white, lineWidth: 6).blur(radius: 4).opacity(light ? 0.9 : 0.55)
                shape.strokeBorder(light ? Color.accentColor.opacity(0.55) : Color.white.opacity(0.85), lineWidth: 1.5)
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
    func flowingBorder(radius: CGFloat, paused: Bool) -> some View {
        modifier(FlowingBorder(radius: radius, paused: paused))
    }
}

struct LongReader: View {
    let id: String
    let text: String
    let space: Namespace.ID
    let size: CGSize
    let onClose: () -> Void
    @State private var drag: CGFloat = 0
    @State private var settled = false

    private let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                MarkdownText(text: text, selectable: true, document: true)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.top, 4)
                    .padding(.bottom, 28)
            }
        }
        .opacity(settled ? 1 : 0)
        .background { surface }
        .clipShape(shape)
        .matchedGeometryEffect(id: id, in: space)
        .frame(width: size.width, height: size.height)
        .offset(y: drag)
        .onAppear { withAnimation(.easeIn(duration: 0.2).delay(0.15)) { settled = true } }
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { close() }
    }

    private var surface: some View {
        shape.fill(.regularMaterial)
            .overlay { shape.fill(Color.paper.opacity(0.6)) }
            .overlay { shape.strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6) }
            .shadow(color: .black.opacity(0.25), radius: 24, y: 8)
    }

    private var header: some View {
        VStack(spacing: 8) {
            Capsule().fill(Color.secondary.opacity(0.45)).frame(width: 36, height: 5)
            HStack {
                Text(verbatim: "全文 · 约 \(readingLength(text)) 字")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(coordinateSpace: .global)
                .onChanged { drag = max(0, $0.translation.height) }
                .onEnded { value in
                    if value.translation.height > 80 {
                        close()
                    } else {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { drag = 0 }
                    }
                }
        )
    }

    private func close() {
        withAnimation(.easeOut(duration: 0.1)) { settled = false }
        onClose()
    }
}
