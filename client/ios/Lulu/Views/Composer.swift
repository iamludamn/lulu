import LuluKit
import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

struct Composer: View {
    @Binding var draft: String
    let store: BotStore
    let transcription: VoiceTranscription
    let onTranscribed: (String, Bool) -> Void
    let busy: Bool
    let placeholder: String
    var focused: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onVoiceConversation: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var listening = false
    @State private var showPreparation = false
    private enum VoiceTarget { case send, text, cancel, conversation }
    private let voiceRadius: CGFloat = 104
    @State private var voiceTarget: VoiceTarget = .send
    @State private var notice: String?
    @State private var noticeTask: Task<Void, Never>?

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var showSend: Bool { canSend && !listening }
    private var tapRecording: Bool { !listening && (transcription.starting || transcription.recording) }

    private var voiceHint: String? {
        if listening {
            if voiceTarget == .cancel { return "松手取消" }
            if voiceTarget == .conversation { return "松手进入语音对话" }
            if let error = transcription.error { return error }
            if transcription.recording { return voiceTarget == .text ? "松手转文字" : "松开发送" }
        }
        if transcription.starting { return showPreparation ? "正在准备录音…" : nil }
        if transcription.recording { return "轻点停止并转写" }
        return transcription.processing ? "正在识别…" : notice
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(alignment: .bottom, spacing: 6) {
                TextField("", text: $draft, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused(focused)
                    .accessibilityLabel(placeholder)
                    .padding(.leading, 18)
                    .padding(.vertical, 13)
                    .opacity(listening ? 0 : 1)
                    .overlay(alignment: .leading) {
                        if listening || draft.isEmpty {
                            HStack(spacing: 6) {
                                Text(listening ? (voiceTarget == .text && transcription.recording ? "松手放入输入框" : "滑动转文字") : placeholder)
                                if listening { Image(systemName: "arrow.left") }
                            }
                                .font(.body)
                                .foregroundStyle(.tertiary)
                                .padding(.leading, 18)
                                .allowsHitTesting(false)
                        }
                    }
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
                    .transition(.asymmetric(
                        insertion: reduceMotion ? .opacity : .scale.combined(with: .opacity),
                        removal: .identity
                    ))
                    .accessibilityLabel(busy ? "追加" : "发送")
                }
            }
            .padding(.trailing, showSend ? 0 : 14)
            .frame(minHeight: 48, maxHeight: listening ? 48 : nil)
            .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
            .scaleEffect(x: 1, y: voiceTarget == .text ? 1.05 : 1, anchor: .center)
            .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: showSend)
            if listening { Color.clear.frame(width: 52, height: 1) }
            microphone
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
        .overlay(alignment: .top) {
            if let voiceHint {
                Text(voiceHint)
                    .font(.caption)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .glassEffect(.regular, in: .capsule)
                    .offset(y: -48)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if listening {
                conversationOption
                    .padding(.trailing, 16)
                    .offset(y: -(voiceRadius + 8))
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: listening)
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: voiceTarget)
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: notice)
        .onChange(of: transcription.error) { _, error in
            if let error { showNotice(error) }
        }
        .task(id: transcription.starting) {
            showPreparation = false
            guard transcription.starting else { return }
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard !Task.isCancelled, transcription.starting else { return }
            showPreparation = true
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { revokeListening() }
        }
        .onDisappear { revokeListening() }
    }

    private func showNotice(_ message: String) {
        noticeTask?.cancel()
        notice = message
        noticeTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { notice = nil }
        }
    }

    private var microphone: some View {
        ZStack {
            if transcription.processing {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: tapRecording ? "stop.fill" : "mic.fill")
                    .font(.system(size: 19, weight: .medium))
            }
        }
        .foregroundStyle(listening || tapRecording ? .primary : .secondary)
        .frame(width: 48, height: 48)
        .glassEffect(.regular, in: .circle)
        .scaleEffect(listening ? 1.08 : 1)
        .overlay {
            VoiceInteraction(
                isEnabled: !transcription.processing,
                isTapRecording: tapRecording,
                onTap: toggleTranscription,
                onHold: beginListening,
                onDrag: updateListening,
                onRelease: finishListening,
                onCancel: cancelListening
            )
        }
    }

    private func toggleTranscription() {
        guard !listening, !transcription.processing else { return }
        if tapRecording {
            transcription.finish { text in onTranscribed(text, false) }
        } else {
            startTranscription()
        }
    }

    private func beginListening() {
        guard !tapRecording else { return }
        listening = true
        startTranscription()
    }

    private func startTranscription() {
        noticeTask?.cancel()
        notice = nil
        showPreparation = false
        focused.wrappedValue = false
        transcription.start(store)
    }

    private func updateListening(_ translation: CGSize) {
        guard listening else { return }
        let next = target(for: translation)
        guard next != voiceTarget else { return }
        voiceTarget = next
        if next != .send {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }

    private func finishListening(_ translation: CGSize) {
        guard listening else { return }
        switch target(for: translation) {
        case .send:
            transcription.finish { text in onTranscribed(text, true) }
        case .text:
            transcription.finish { text in onTranscribed(text, false) }
        case .cancel: transcription.cancel(); showNotice("已取消")
        case .conversation: transcription.cancel(); notice = nil; onVoiceConversation()
        }
        listening = false
        voiceTarget = .send
    }

    private func cancelListening() {
        guard listening else { return }
        transcription.cancel()
        listening = false
        voiceTarget = .send
        showNotice("已取消")
    }

    private func revokeListening() {
        transcription.cancel()
        listening = false
        voiceTarget = .send
        showPreparation = false
        noticeTask?.cancel()
        notice = nil
    }

    private func target(for translation: CGSize) -> VoiceTarget {
        let x = translation.width, y = translation.height
        if hypot(x, y + voiceRadius) < 32 { return .conversation }
        if x < -77 && abs(y) < 30 { return .text }
        return hypot(x, y) <= 30 ? .send : .cancel
    }

    private var conversationOption: some View {
        Image(systemName: "phone.fill")
            .font(.system(size: 19, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: 48, height: 48)
            .glassEffect(.regular, in: .circle)
            .scaleEffect(voiceTarget == .conversation ? 1.1 : 1)
            .accessibilityLabel("语音对话")
    }
}

private struct VoiceInteraction: UIViewRepresentable {
    let isEnabled: Bool
    let isTapRecording: Bool
    let onTap: () -> Void
    let onHold: () -> Void
    let onDrag: (CGSize) -> Void
    let onRelease: (CGSize) -> Void
    let onCancel: () -> Void

    func makeUIView(context: Context) -> Surface {
        Surface(self)
    }

    func updateUIView(_ view: Surface, context: Context) {
        view.interaction = self
        view.isUserInteractionEnabled = isEnabled
        view.accessibilityTraits = isEnabled ? .button : [.button, .notEnabled]
        view.accessibilityLabel = isTapRecording ? "停止录音并转写" : "语音输入"
        view.accessibilityHint = isTapRecording ? nil : "轻点开始录音，长按展开语音选项"
    }

    final class Surface: UIView {
        var interaction: VoiceInteraction
        private var start = CGPoint.zero
        private let impact = UIImpactFeedbackGenerator(style: .medium)

        init(_ interaction: VoiceInteraction) {
            self.interaction = interaction
            super.init(frame: .zero)
            backgroundColor = .clear
            isAccessibilityElement = true

            let tap = TouchDownTapGestureRecognizer(target: self, action: #selector(tapped))
            tap.onTouchDown = { [weak self] in
                guard let self, self.interaction.isEnabled else { return }
                self.impact.impactOccurred()
            }
            let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
            hold.minimumPressDuration = 0.35
            tap.require(toFail: hold)
            addGestureRecognizer(tap)
            addGestureRecognizer(hold)
        }

        required init?(coder: NSCoder) { return nil }

        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
            hypot(point.x - bounds.midX, point.y - bounds.midY) <= min(bounds.width, bounds.height) / 2
        }

        override func accessibilityActivate() -> Bool {
            guard interaction.isEnabled else { return false }
            interaction.onTap()
            return true
        }

        @objc private func tapped() {
            guard interaction.isEnabled else { return }
            interaction.onTap()
        }

        @objc private func held(_ gesture: UILongPressGestureRecognizer) {
            let point = gesture.location(in: nil)
            let translation = CGSize(width: point.x - start.x, height: point.y - start.y)
            switch gesture.state {
            case .began:
                guard interaction.isEnabled else { return }
                start = point
                interaction.onHold()
            case .changed:
                interaction.onDrag(translation)
            case .ended:
                interaction.onRelease(translation)
            case .cancelled, .failed:
                interaction.onCancel()
            default:
                break
            }
        }
    }
}

private final class TouchDownTapGestureRecognizer: UITapGestureRecognizer {
    var onTouchDown: (() -> Void)?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        onTouchDown?()
        super.touchesBegan(touches, with: event)
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
