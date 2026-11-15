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
    private weak var store: BotStore?
    private var active = false
    private var generation = UUID()

    func start(_ store: BotStore) async {
        stop()
        let token = UUID()
        generation = token
        active = true
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
        timeout?.cancel()
        timeout = nil
        ready = false
        generation = UUID()
        if active { store?.stopVoice() }
        active = false
        store?.onVoiceEvent = nil
        store?.onVoiceError = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        player?.stop()
        player = nil
        engine = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func receive(_ event: JSONValue) {
        guard active, let type = event["type"]?.string else { return }
        switch type {
        case "voice.state":
            if event["state"]?.string == "ready" {
                do { try startAudio(); ready = true; timeout?.cancel(); status = "正在聆听" } catch { fail("音频启动失败：\(error.localizedDescription)") }
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

    private func fail(_ message: String) { stop(); status = message }

    private func startAudio() throws {
        guard engine == nil else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let source = input.outputFormat(forBus: 0)
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false) else {
            throw NSError(domain: "VoiceCall", code: 1, userInfo: [NSLocalizedDescriptionKey: "不支持的音频格式"])
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: output)
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
            let data = Data(bytes: samples, count: Int(converted.frameLength) * 2)
            Task { @MainActor [weak self] in if let self, self.active, self.generation == token, !self.muted { self.store?.sendVoiceAudio(data) } }
        }
        self.engine = engine
        self.player = player
        try engine.start()
        player.play()
    }

    private func play(_ data: Data) {
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
    }
}
