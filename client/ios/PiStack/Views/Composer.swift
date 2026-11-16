import PiStackKit
import SwiftUI
import UIKit

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
    @State private var listening = false
    private enum VoiceTarget { case send, text, cancel, conversation }
    private let voiceRadius: CGFloat = 104
    private var diagonal: CGFloat { voiceRadius / sqrt(2) }
    @State private var voiceTarget: VoiceTarget = .send
    @GestureState private var voiceGestureActive = false
    @State private var notice: String?
    @State private var noticeTask: Task<Void, Never>?

    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var showSend: Bool { canSend && !listening }

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
                                Text(listening ? (voiceTarget == .text ? "松手放入输入框" : "滑动转文字") : placeholder)
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
                    .transition(reduceMotion ? .opacity : .scale.combined(with: .opacity))
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
            if listening {
                Text(voiceTarget == .text ? "转文字" : voiceTarget == .cancel ? "松手取消" : voiceTarget == .conversation ? "松手进入语音对话" : "松开发送")
                .font(.caption)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .glassEffect(.regular, in: .capsule)
                .offset(y: -48)
                .allowsHitTesting(false)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if let notice = transcription.processing ? "正在识别…" : notice {
                Text(notice)
                    .font(.caption)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .glassEffect(.regular, in: .capsule)
                    .offset(y: -48)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if listening {
                ZStack(alignment: .bottomTrailing) {
                    voiceOption("取消", icon: "xmark", selected: voiceTarget == .cancel)
                        .offset(x: -diagonal, y: voiceRadius - diagonal)
                    voiceOption("语音对话", icon: "phone.fill", selected: voiceTarget == .conversation)
                }.frame(width: 122, height: 96, alignment: .bottomTrailing)
                .padding(.trailing, 16)
                .offset(y: -(voiceRadius + 8))
                .allowsHitTesting(false)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(.snappy(duration: 0.2), value: listening)
        .animation(.snappy(duration: 0.2), value: voiceTarget)
        .animation(.snappy(duration: 0.2), value: notice)
        .onChange(of: voiceGestureActive) { _, active in
            if !active {
                if listening { transcription.cancel() }
                listening = false
                voiceTarget = .send
            }
        }
        .onChange(of: transcription.error) { _, error in
            if let error { showNotice(error) }
        }
        .onDisappear { transcription.cancel() }
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
                Image(systemName: "mic.fill").font(.system(size: 19, weight: .medium))
            }
        }
        .foregroundStyle(listening ? .primary : .secondary)
        .frame(width: 48, height: 48)
        .glassEffect(.regular, in: .circle)
        .scaleEffect(listening ? 1.08 : 1)
        .contentShape(Circle())
        .allowsHitTesting(!transcription.processing)
        .gesture(LongPressGesture(minimumDuration: 0.35).sequenced(before: DragGesture(minimumDistance: 0))
            .updating($voiceGestureActive) { value, active, _ in
                if case .second(true, _) = value { active = true }
            }
            .onChanged { value in
                guard case .second(true, let drag) = value else { return }
                if !listening {
                    noticeTask?.cancel()
                    notice = nil
                    listening = true
                    focused.wrappedValue = false
                    transcription.start(store)
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                }
                let next = target(for: drag?.translation ?? .zero)
                if next != voiceTarget {
                    voiceTarget = next
                    if next != .send {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    }
                }
            }
            .onEnded { value in
                guard case .second(true, let drag) = value else { return }
                switch target(for: drag?.translation ?? .zero) {
                case .send:
                    transcription.finish { text in onTranscribed(text, true) }
                case .text:
                    transcription.finish { text in onTranscribed(text, false) }
                case .cancel: transcription.cancel(); showNotice("已取消")
                case .conversation: transcription.cancel(); notice = nil; onVoiceConversation()
                }
                listening = false
                voiceTarget = .send
                noticeTask?.cancel()
                noticeTask = Task { @MainActor in
                    try? await Task.sleep(for: .seconds(2))
                    if !Task.isCancelled { notice = nil }
                }
            })
        .onTapGesture { onVoiceConversation() }
        .accessibilityLabel("语音对话")
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("轻点开始通话，长按展开语音选项")
    }

    private func target(for translation: CGSize) -> VoiceTarget {
        let x = translation.width, y = translation.height
        let cancelDistance = hypot(x + diagonal, y + diagonal)
        let phoneDistance = hypot(x, y + voiceRadius)
        if min(cancelDistance, phoneDistance) < 32 && hypot(x, y) > 30 {
            return cancelDistance < phoneDistance ? .cancel : .conversation
        }
        if x < -77 && abs(y) < 30 { return .text }
        return .send
    }

    private func voiceOption(_ title: String, icon: String, selected: Bool) -> some View {
        Image(systemName: icon)
            .font(.system(size: 19, weight: .medium))
            .foregroundStyle(.secondary)
            .frame(width: 48, height: 48)
            .glassEffect(.regular, in: .circle)
            .scaleEffect(selected ? 1.1 : 1)
            .accessibilityLabel(title)
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
