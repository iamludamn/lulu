import AVFoundation
import Observation
import PiStackKit

@MainActor @Observable
final class VoiceTranscription {
    private(set) var recording = false
    private(set) var levels = Array(repeating: CGFloat.zero, count: 32)
    private var smoothedLevel: CGFloat = 0
    private(set) var processing = false
    private(set) var error: String?
    private var id: String?
    private var engine: AVAudioEngine?
    private weak var store: BotStore?
    private var ready = false
    private var pending = Data()
    private var completion: ((String) -> Void)?
    private var timeout: Task<Void, Never>?
    private var bytes = 0

    func start(_ store: BotStore) {
        cancel()
        error = nil
        let token = UUID().uuidString
        id = token
        recording = true
        self.store = store
        Task {
            let granted = await AVAudioApplication.requestRecordPermission()
            guard id == token else { return }
            guard granted else { fail("请在系统设置中允许麦克风访问"); return }
            guard store.snapshot.link == .online else { fail("当前未连接，无法识别语音"); return }
            store.onASREvent = { [weak self] event in self?.receive(event) }
            store.onASRError = { [weak self] message in self?.fail(message) }
            do {
                try startAudio(token)
                store.startASR(token)
                timeout = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(60))
                    guard !Task.isCancelled, self?.id == token else { return }
                    self?.fail("录音超时，请控制在 60 秒以内")
                }
            } catch { fail("录音启动失败：\(error.localizedDescription)") }
        }
    }

    func finish(_ completion: @escaping (String) -> Void) {
        guard let token = id, engine != nil else {
            if error == nil { fail("录音太短，请按住后再说话") }
            return
        }
        stopAudio()
        self.completion = completion
        processing = true
        flush(final: true)
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, self?.id == token else { return }
            self?.fail("语音识别超时，请重试")
        }
    }

    func cancel() {
        let previous = id
        id = nil
        stopAudio()
        timeout?.cancel(); timeout = nil
        if let previous { store?.cancelASR(previous) }
        store?.onASREvent = nil; store?.onASRError = nil
        pending = Data(); ready = false; bytes = 0
        completion = nil; processing = false
    }

    private func fail(_ message: String) { cancel(); error = message }

    private func receive(_ event: JSONValue) {
        guard let id, event["sessionId"]?.string == id else { return }
        switch event["type"]?.string {
        case "asr.ready": ready = true; flush(final: processing)
        case "asr.error": fail(event["message"]?.string ?? "语音识别失败，请重试")
        case "asr.transcript":
            guard event["final"] == .bool(true) else { return }
            let text = (event["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let done = completion
            cancel()
            if text.isEmpty { error = "没有听清，请再试一次" }
            else { done?(text) }
        default: break
        }
    }

    private func flush(final: Bool) {
        guard ready, let id else { return }
        while pending.count >= 6400 {
            store?.sendASRAudio(Data(pending.prefix(6400)), session: id)
            pending.removeFirst(6400)
        }
        if final {
            if !pending.isEmpty { store?.sendASRAudio(pending, session: id); pending = Data() }
            store?.finishASR(id)
        }
    }

    private func startAudio(_ token: String) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [])
        // Target selection must remain tactile after microphone capture begins.
        try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setActive(true)
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else { throw ApiError.message("不支持的音频格式") }
        input.installTap(onBus: 0, bufferSize: 2048, format: source) { [weak self] buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / source.sampleRate)) + 16
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return buffer
            }
            guard error == nil, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
            let count = Int(converted.frameLength)
            var energy = 0.0
            for index in 0..<count {
                let sample = Double(samples[index]) / 32768
                energy += sample * sample
            }
            let decibels = 20 * log10(max(sqrt(energy / Double(count)), 0.00001))
            let level = CGFloat(min(1, max(0, (decibels + 55) / 47)))
            let data = Data(bytes: samples, count: count * 2)
            Task { @MainActor [weak self] in
                guard let self, self.id == token, !self.processing else { return }
                let smoothing = level > self.smoothedLevel ? 0.65 : 0.25
                self.smoothedLevel += (level - self.smoothedLevel) * smoothing
                self.levels.removeFirst()
                self.levels.append(self.smoothedLevel)
                self.bytes += data.count
                guard self.bytes <= 60 * 32000 else { self.fail("录音已超过 60 秒"); return }
                self.pending.append(data)
                self.flush(final: false)
            }
        }
        self.engine = engine
        try engine.start()
    }

    private func stopAudio() {
        recording = false
        smoothedLevel = 0
        levels = Array(repeating: 0, count: 32)
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop(); self.engine = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
