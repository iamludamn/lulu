import SwiftUI

struct Composer: View {
    @Binding var draft: String
    let connected: Bool
    let busy: Bool
    let placeholder: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    private var canSend: Bool { connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField(placeholder, text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused(focused)
                .disabled(!connected)
                .padding(.leading, 18)
                .padding(.vertical, 13)
            if canSend {
                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(Color.accentColor, in: .circle)
                }
                .buttonStyle(.plain)
                .padding(7)
                .transition(.scale.combined(with: .opacity))
                .accessibilityLabel(busy ? "追加" : "发送")
            }
        }
        .padding(.trailing, canSend ? 0 : 14)
        .frame(minHeight: 48)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.2), value: canSend)
    }
}
