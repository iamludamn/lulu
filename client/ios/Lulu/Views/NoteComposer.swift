import SwiftUI

struct NoteComposer: View {
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let expanded: Bool
    let editingNote: Bool
    let opening: Bool
    let sending: Bool
    let transcription: VoiceTranscription
    let voiceStatus: String?
    let onOpen: () -> Void
    let onSend: () -> Void
    let onMicrophone: () -> Void
    let onCancelVoice: () -> Void
    @Namespace private var glass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let controlSize: CGFloat = 48
    private var canSend: Bool { !usingVoice && !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var usingVoice: Bool { voiceStatus != nil }
    var body: some View {
        VStack(spacing: 3) {
            HStack(alignment: .bottom, spacing: 0) {
                if expanded {
                    expandedInput
                        .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: 0.12).delay(0.15)))
                } else {
                    Button(action: onOpen) {
                        Image(systemName: "bubble.left")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .frame(width: controlSize, height: controlSize)
                            .contentShape(.circle)
                    }
                    .buttonStyle(.plain)
                    .disabled(sending || usingVoice)
                    .accessibilityLabel("提问")
                    Spacer(minLength: 0)
                }
                microphone
            }
            .frame(minHeight: controlSize)
            .background { glassSurfaces }
            .overlay(alignment: .top) {
                if let voiceStatus {
                    HStack(spacing: 10) {
                        Label(voiceStatus, systemImage: transcription.recording ? "waveform" : "mic")
                            .font(.footnote)
                        if !expanded {
                            Button("取消", action: onCancelVoice)
                                .font(.footnote.weight(.medium))
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .glassEffect(.regular, in: .capsule)
                    .offset(y: -37)
                }
            }

            if !editingNote && !focused.wrappedValue {
                HStack {
                    caption("提问")
                        .frame(width: controlSize)
                    Spacer(minLength: 0)
                    caption("语音记笔记")
                        .frame(width: controlSize)
                }
                .opacity(expanded ? 0 : 1)
                .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }

    private func caption(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    private var glassSurfaces: some View {
        GeometryReader { geometry in
            GlassEffectContainer(spacing: 18) {
                ZStack(alignment: .bottomTrailing) {
                    Color.clear
                        .frame(width: expanded ? geometry.size.width : controlSize, height: geometry.size.height)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: controlSize / 2))
                        .glassEffectID("note-leading-control", in: glass)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    Color.clear
                        .frame(width: controlSize, height: controlSize)
                        .glassEffect(.regular.interactive(), in: .circle)
                        .glassEffectID("note-microphone", in: glass)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var expandedInput: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if usingVoice {
                Button("取消", action: onCancelVoice)
                    .font(.subheadline)
                    .padding(.leading, 16)
                    .frame(height: controlSize)
                RecordingWaveform(levels: transcription.levels)
                    .frame(height: controlSize)
                    .accessibilityHidden(!transcription.recording)
            } else {
                TextField("和 lulu 聊聊这篇笔记", text: $draft, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused(focused)
                    .accessibilityLabel("和 lulu 聊聊这篇笔记")
                    .padding(.leading, 17)
                    .padding(.vertical, 12)
            }
            Button(action: onSend) {
                Image(systemName: "arrow.up")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(canSend ? Color.white : Color.secondary)
                    .frame(width: 34, height: 34)
                    .background(canSend ? Color.accentColor : Color.secondary.opacity(0.14), in: .circle)
                    .frame(width: controlSize, height: controlSize)
                    .contentShape(.rect)
            }
            .disabled(!canSend)
            .accessibilityLabel("发送")
        }
        .buttonStyle(.plain)
    }

    private var microphone: some View {
        Button(action: onMicrophone) {
            Group {
                if transcription.processing || transcription.starting {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: transcription.recording ? "stop.fill" : "mic.fill")
                        .font(.system(size: transcription.recording ? 15 : 19, weight: .medium))
                        .foregroundStyle(transcription.recording ? Color.red : Color.secondary)
                }
            }
            .frame(width: controlSize, height: controlSize)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(opening || transcription.processing || transcription.starting)
        .accessibilityLabel(transcription.recording ? "停止录音并转写" : expanded ? "语音提问" : "语音记笔记")
    }
}

struct NoteReplySurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular, in: .rect(cornerRadius: 18))
            .padding(.horizontal, 16)
    }
}
