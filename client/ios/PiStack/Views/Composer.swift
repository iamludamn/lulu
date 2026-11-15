import SwiftUI

struct Composer: View {
    @Binding var draft: String
    let busy: Bool
    let placeholder: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var showSend: Bool { canSend && focused.wrappedValue }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(alignment: .bottom, spacing: 6) {
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focused)
                    .padding(.leading, 18)
                    .padding(.vertical, 13)
                if showSend {
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
            .padding(.trailing, showSend ? 0 : 14)
            .frame(minHeight: 48)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
            .animation(.snappy(duration: 0.2), value: showSend)
            Image(systemName: "mic.fill")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 48, height: 48)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("语音，功能即将推出")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
}

extension View {
    func composerChrome() -> some View {
        frame(minHeight: 48)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
    }
}
