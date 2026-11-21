import AVFoundation
import Foundation
import Observation
import LuluKit

@MainActor @Observable
final class VoiceCall {
    struct Line: Identifiable {
        let id = UUID()
        let mine: Bool
        var text: String
    }

    private(set) var lines: [Line] = []
    private(set) var status = "准备连接…"
    private(set) var muted = false
    private(set) var ready = false
    private var timeout: Task<Void, Never>?
    @ObservationIgnored private var audio: VoiceAudioGraph?
    private var audioRecovery: Task<Void, Never>?
    private weak var store: BotStore?
    private var active = false
    private var generation = UUID()
    private var receivedAudio = false
    private var sentAudio = false
    @ObservationIgnored private var inputLevel = 0.0
    @ObservationIgnored private var outputLevel = 0.0
    @ObservationIgnored private var inputMeasuredAt = Date.distantPast
    @ObservationIgnored private var outputMeasuredAt = Date.distantPast

    func audioLevel(at date: Date) -> Double {
        let input = muted ? 0 : inputLevel * exp(-max(0, date.timeIntervalSince(inputMeasuredAt) - 0.06) * 7)
        let output = outputLevel * exp(-max(0, date.timeIntervalSince(outputMeasuredAt) - 0.06) * 7)
        return max(input, output)
    }

    private nonisolated static func normalizedLevel(_ decibels: Double) -> Double {
        pow(min(1, max(0, (decibels + 55) / 39)), 0.7)
    }

    func start(_ store: BotStore) async {
        guard !Task.isCancelled else { return }
        stop()
        let token = UUID()
        generation = token
        active = true
        receivedAudio = false; sentAudio = false
        NSLog("LuluVoice call start")
        self.store = store
        muted = false
        lines = []
        let granted: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            granted = true
        case .denied:
            granted = false
        case .undetermined:
            status = "正在请求麦克风权限…"
            granted = await AVAudioApplication.requestRecordPermission()
        @unknown default:
            granted = false
        }
        guard !Task.isCancelled, active, generation == token else { return }
        guard granted else { status = "请在系统设置中允许麦克风访问"; active = false; return }
        guard store.snapshot.link == .online else { status = "当前未连接，无法开始语音"; active = false; return }
        store.onVoiceEvent = { [weak self] event in self?.receive(event) }
        store.onVoiceError = { [weak self] message in self?.fail(message) }
        status = "正在连接语音…"
        store.startVoice()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled, let self, self.active, self.generation == token, !self.ready else { return }
            self.fail("语音连接超时，请关闭后重试")
        }
    }

    func setMuted(_ muted: Bool) {
        guard active, ready else { return }
        self.muted = muted
        store?.muteVoice(muted)
    }

    func stop() {
        NSLog("LuluVoice call stop active=%d", active)
        timeout?.cancel()
        timeout = nil
        audioRecovery?.cancel(); audioRecovery = nil
        ready = false
        inputLevel = 0; outputLevel = 0
        inputMeasuredAt = .distantPast; outputMeasuredAt = .distantPast
        generation = UUID()
        if active { store?.stopVoice() }
        active = false
        store?.onVoiceEvent = nil
        store?.onVoiceError = nil
        audio?.cancel()
        audio = nil
    }

    private func receive(_ event: JSONValue) {
        guard active, let type = event["type"]?.string else { return }
        if type != "response.output_audio.delta" { NSLog("LuluVoice event %@", type) }
        switch type {
        case "voice.state":
            if event["state"]?.string == "ready" {
                startAudio()
            } else if event["state"]?.string == "closed" {
                let reason = event["reason"]?.string ?? "语音已结束"
                stop(); status = reason
            }
        case "conversation.item.input_audio_transcription.completed":
            if let text = event["transcript"]?.string, !text.isEmpty { lines.append(Line(mine: true, text: text)) }
        case "response.output_audio_transcription.delta":
            if let text = event["transcript"]?.string, !text.isEmpty { lines.append(Line(mine: false, text: text)) }
        case "response.output_audio.delta":
            if let value = event["delta"]?.string, let data = Data(base64Encoded: value) { play(data) }
        case "voice.flush": audio?.enqueue { $0.flushPlayback() }
        case "error": fail(event["error"]?["message"]?.string ?? "语音连接失败")
        default: break
        }
    }

    private func fail(_ message: String) { NSLog("LuluVoice failed %@", message); stop(); status = message }

    private func startAudio() {
        guard audio == nil else { return }
        let token = generation
        let graph = VoiceAudioGraph(mode: .conversation, onInput: { [weak self] data, decibels in
            let level = Self.normalizedLevel(decibels)
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token, !self.muted else { return }
                if !self.sentAudio { NSLog("LuluVoice first captured audio bytes=%d", data.count); self.sentAudio = true }
                self.inputLevel += (level - self.inputLevel) * (level > self.inputLevel ? 0.8 : 0.3)
                self.inputMeasuredAt = Date()
                self.store?.sendVoiceAudio(data)
            }
        }, onOutput: { [weak self] decibels in
            let level = Self.normalizedLevel(decibels)
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token else { return }
                self.outputLevel += (level - self.outputLevel) * (level > self.outputLevel ? 0.8 : 0.3)
                self.outputMeasuredAt = Date()
            }
        }, onConfigurationChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token else { return }
                self.recoverAudio()
            }
        })
        audio = graph
        graph.enqueue { [weak self] graph in
            let result = Result { try graph.start() }
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token else { return }
                switch result {
                case .success: self.recoverAudio()
                case .failure(let error): self.fail("音频启动失败：\(error.localizedDescription)")
                }
            }
        }
    }

    private func recoverAudio() {
        guard active, let audio else { return }
        audioRecovery?.cancel()
        let token = generation
        audioRecovery = Task { [weak self] in
            let running = (try? await audio.perform { $0.resumePlayback() }) ?? false
            guard !Task.isCancelled, let self, self.generation == token else { return }
            if running {
                self.audioBecameReady()
                return
            }
            self.ready = false
            self.status = "正在启动音频…"
            for _ in 0..<4 {
                do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
                do {
                    let running = try await audio.perform { try $0.recoverPlayback() }
                    guard !Task.isCancelled, self.generation == token else { return }
                    if running {
                        self.audioBecameReady()
                        NSLog("LuluVoice audio recovered running=1")
                        return
                    }
                } catch {
                    guard !Task.isCancelled, self.generation == token else { return }
                    NSLog("LuluVoice audio recovery failed %@", error.localizedDescription)
                }
            }
            self.fail("通话音频启动失败，请关闭后重试")
        }
    }

    private func audioBecameReady() {
        ready = true
        timeout?.cancel()
        status = "正在聆听"
    }

    private func play(_ data: Data) {
        if !receivedAudio { NSLog("LuluVoice first returned audio bytes=%d player=%d", data.count, audio != nil); receivedAudio = true }
        audio?.enqueue { $0.play(data) }
    }
}
