import AVFoundation
import Foundation
import Observation
import PiStackKit

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
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var configurationObserver: NSObjectProtocol?
    private var audioRecovery: Task<Void, Never>?
    private weak var store: BotStore?
    private var active = false
    private var generation = UUID()
    private var receivedAudio = false
    private var sentAudio = false
    private var inputLevel = 0.0
    private var outputLevel = 0.0
    private var inputMeasuredAt = Date.distantPast
    private var outputMeasuredAt = Date.distantPast

    func audioLevel(at date: Date) -> Double {
        let input = muted ? 0 : inputLevel * exp(-max(0, date.timeIntervalSince(inputMeasuredAt) - 0.06) * 7)
        let output = outputLevel * exp(-max(0, date.timeIntervalSince(outputMeasuredAt) - 0.06) * 7)
        return max(input, output)
    }

    private nonisolated static func normalizedLevel(sum: Double, count: Int) -> Double {
        guard count > 0 else { return 0 }
        let rms = sqrt(sum / Double(count))
        let decibels = 20 * log10(max(rms, 0.00001))
        return pow(min(1, max(0, (decibels + 55) / 39)), 0.7)
    }

    func start(_ store: BotStore) async {
        stop()
        let token = UUID()
        generation = token
        active = true
        receivedAudio = false; sentAudio = false
        NSLog("LuluVoice call start")
        self.store = store
        muted = false
        lines = []
        status = "正在请求麦克风权限…"
        let granted = await AVAudioApplication.requestRecordPermission()
        guard active, generation == token else { return }
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
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        ready = false
        inputLevel = 0; outputLevel = 0
        inputMeasuredAt = .distantPast; outputMeasuredAt = .distantPast
        generation = UUID()
        if active { store?.stopVoice() }
        active = false
        store?.onVoiceEvent = nil
        store?.onVoiceError = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.mainMixerNode.removeTap(onBus: 0); engine.stop() }
        player?.stop()
        player = nil
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func receive(_ event: JSONValue) {
        guard active, let type = event["type"]?.string else { return }
        if type != "response.output_audio.delta" { NSLog("LuluVoice event %@", type) }
        switch type {
        case "voice.state":
            if event["state"]?.string == "ready" {
                do { try startAudio(); recoverAudio() } catch { fail("音频启动失败：\(error.localizedDescription)") }
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
        case "voice.flush": player?.stop(); player?.play()
        case "error": fail(event["error"]?["message"]?.string ?? "语音连接失败")
        default: break
        }
    }

    private func fail(_ message: String) { NSLog("LuluVoice failed %@", message); stop(); status = message }

    private func startAudio() throws {
        guard engine == nil else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        guard let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false) else {
            throw NSError(domain: "VoiceCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "不支持的音频格式"])
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: output)
        try installInputTap(engine)
        self.engine = engine
        self.player = player
        let token = generation
        // Measure rendered audio, rather than arriving network packets, so the
        // rings follow the reply being heard even when playback is buffered.
        engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let channels = buffer.floatChannelData else { return }
            let count = Int(buffer.frameLength)
            var sum = 0.0
            for index in 0..<count { let sample = Double(channels[0][index]); sum += sample * sample }
            let level = Self.normalizedLevel(sum: sum, count: count)
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token else { return }
                self.outputLevel += (level - self.outputLevel) * (level > self.outputLevel ? 0.8 : 0.3)
                self.outputMeasuredAt = Date()
            }
        }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token else { return }
                self.recoverAudio()
            }
        }
        engine.prepare()
        try engine.start()
        NSLog("LuluVoice audio initial running=%d", engine.isRunning)
    }

    private func installInputTap(_ engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else {
            throw NSError(domain: "VoiceCall", code: 2, userInfo: [NSLocalizedDescriptionKey: "麦克风音频格式暂不可用"])
        }
        let token = generation
        input.installTap(onBus: 0, bufferSize: 2048, format: source) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16_000 / source.sampleRate)) + 16
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return buffer
            }
            guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
            let count = Int(converted.frameLength)
            var sum = 0.0
            for index in 0..<count { let sample = Double(samples[index]) / 32768; sum += sample * sample }
            let level = Self.normalizedLevel(sum: sum, count: count)
            let data = Data(bytes: samples, count: count * 2)
            Task { @MainActor [weak self] in
                guard let self, self.active, self.generation == token, !self.muted else { return }
                if !self.sentAudio { NSLog("LuluVoice first captured audio bytes=%d", data.count); self.sentAudio = true }
                self.inputLevel += (level - self.inputLevel) * (level > self.inputLevel ? 0.8 : 0.3)
                self.inputMeasuredAt = Date()
                self.store?.sendVoiceAudio(data)
            }
        }
    }

    private func recoverAudio() {
        guard active, let engine, let player else { return }
        audioRecovery?.cancel()
        if engine.isRunning {
            player.play(); ready = true; timeout?.cancel(); status = "正在聆听"
            return
        }
        ready = false
        status = "正在启动音频…"
        let token = generation
        audioRecovery = Task { [weak self] in
            for _ in 0..<4 {
                do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
                guard let self, self.active, self.generation == token, self.engine === engine else { return }
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    if !engine.isRunning {
                        engine.inputNode.removeTap(onBus: 0)
                        try self.installInputTap(engine)
                        engine.prepare()
                        try engine.start()
                    }
                    guard engine.isRunning else { continue }
                    player.play()
                    self.ready = true; self.timeout?.cancel(); self.status = "正在聆听"
                    NSLog("LuluVoice audio recovered running=%d", engine.isRunning)
                    return
                } catch {
                    NSLog("LuluVoice audio recovery failed %@", error.localizedDescription)
                }
            }
            guard let self, self.active, self.generation == token else { return }
            self.fail("通话音频启动失败，请关闭后重试")
        }
    }

    private func play(_ data: Data) {
        if !receivedAudio { NSLog("LuluVoice first returned audio bytes=%d player=%d", data.count, player != nil); receivedAudio = true }
        guard !data.isEmpty, data.count.isMultiple(of: 2), let player, let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let target = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(data.count / 2)
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for index in 0..<Int(buffer.frameLength) {
                let value = UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8
                target[index] = Float(Int16(bitPattern: value)) / 32768
            }
        }
        player.scheduleBuffer(buffer)
        if engine?.isRunning == true, !player.isPlaying { player.play() }
    }
}
