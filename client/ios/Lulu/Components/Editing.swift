import SwiftUI

private struct Wiggle: ViewModifier {
    let active: Bool
    let seed: Int
    @State private var swung = false

    func body(content: Content) -> some View {
        content
            .rotationEffect(.degrees(active ? (swung ? 1.1 : -1.1) : 0))
            .animation(active ? .easeInOut(duration: 0.12 + 0.02 * Double(seed % 3)).repeatForever(autoreverses: true) : .snappy, value: swung)
            .onChange(of: active, initial: true) { _, now in swung = now }
    }
}

extension View {
    func editable(_ editing: Bool, seed: Int, radius: CGFloat, onRemove: @escaping () -> Void) -> some View {
        allowsHitTesting(!editing)
            .contentShape(.rect(cornerRadius: radius, style: .continuous))
            .overlay(alignment: .topLeading) {
                if editing {
                    Button(action: onRemove) {
                        Image(systemName: "minus")
                            .font(.caption.weight(.heavy))
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background(Color.red, in: .circle)
                            .overlay { Circle().strokeBorder(.white.opacity(0.9), lineWidth: 1.5) }
                    }
                    .buttonStyle(.plain)
                    .offset(x: -6, y: -6)
                    .transition(.scale.combined(with: .opacity))
                    .accessibilityLabel("移除")
                }
            }
            .modifier(Wiggle(active: editing, seed: seed))
    }

    @ViewBuilder
    func reorderable(_ id: String, editing: Bool, onMove: @escaping (String, String) -> Void) -> some View {
        if editing {
            draggable(id)
                .dropDestination(for: String.self) { items, _ in
                    guard let dragged = items.first, dragged != id else { return false }
                    onMove(dragged, id)
                    return true
                }
        } else {
            self
        }
    }

    func doneBar(_ editing: Bool, done: @escaping () -> Void) -> some View {
        overlay(alignment: .bottom) {
            if editing {
                Button("完成", action: done)
                    .font(.headline)
                    .padding(.horizontal, 28)
                    .padding(.vertical, 6)
                    .buttonStyle(.glassProminent)
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: editing)
    }
}

extension Array where Element: Equatable {
    func moved(_ item: Element, to target: Element) -> [Element] {
        guard let from = firstIndex(of: item), let to = firstIndex(of: target), from != to else { return self }
        var result = self
        result.insert(result.remove(at: from), at: to)
        return result
    }
}
