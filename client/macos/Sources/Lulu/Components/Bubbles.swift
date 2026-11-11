import SwiftUI

func readingLength(_ text: String) -> Int {
    let count = text.filter { !$0.isWhitespace }.count
    let step = count < 1000 ? 10 : 100
    return max(step, (count + step / 2) / step * step)
}

struct Hook: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let radius = min(rect.width, rect.height) * 0.6
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

struct Pill: View {
    let symbol: String
    let text: String
    var spinning = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Hook()
                .stroke(Color.ink.opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 12, height: 12)
                .padding(.top, 23)
                .padding(.leading, 32)
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .symbolEffect(.rotate, isActive: spinning)
                Text(text).type(12, .medium, line: 16).lineLimit(1)
            }
            .foregroundStyle(Color.sheetInk)
            .padding(.horizontal, 14)
            .frame(height: 36)
            .background(Color.chip, in: .capsule)
            .overlay { Capsule().strokeBorder(Color.line.opacity(0.5), lineWidth: 0.5) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct TypingBubble: View {
    let tasks: [String]
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(tasks, id: \.self) { task in
                Pill(symbol: "arrow.triangle.2.circlepath", text: task, spinning: true)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            TypingDots(size: 7)
                .padding(.horizontal, 18)
                .frame(height: 44)
                .pane(22, tint: .reply)
                .scaleEffect(shown ? 1 : 0.6, anchor: .bottomLeading)
                .opacity(shown ? 1 : 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.snappy, value: tasks)
        .onAppear { withAnimation(.spring(duration: 0.4, bounce: 0.3)) { shown = true } }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("助手正在输入")
    }
}
