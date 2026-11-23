import AVFoundation
import Foundation
import os

final class VoiceAudioGraph: @unchecked Sendable {
    enum Mode: Equatable { case conversation, transcription }

    private static let queue = DispatchQueue(label: "lulu.voice.audio", qos: .userInitiated)
    private static weak var owner: VoiceAudioGraph?

    private let mode: Mode
    private let cancelled = OSAllocatedUnfairLock(initialState: false)
    private let onInput: @Sendable (Data, Double) -> Void
    private let onOutput: (@Sendable (Double) -> Void)?
    private let onConfigurationChange: (@Sendable () -> Void)?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var outputFormat: AVAudioFormat?
    private var inputTapped = false
    private var outputTapped = false
    private var configurationObserver: NSObjectProtocol?

    init(
        mode: Mode,
        onInput: @escaping @Sendable (Data, Double) -> Void,
        onOutput: (@Sendable (Double) -> Void)? = nil,
        onConfigurationChange: (@Sendable () -> Void)? = nil
    ) {
        self.mode = mode
        self.onInput = onInput
        self.onOutput = onOutput
        self.onConfigurationChange = onConfigurationChange
    }

    func enqueue(_ operation: @escaping @Sendable (VoiceAudioGraph) -> Void) {
        Self.queue.async { operation(self) }
    }

    func perform<T: Sendable>(_ operation: @escaping @Sendable (VoiceAudioGraph) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            enqueue { graph in continuation.resume(with: Result { try operation(graph) }) }
        }
    }

    func cancel() {
        cancelled.withLock { $0 = true }
        enqueue { $0.stop() }
    }

    func start() throws {
        try checkCancellation()
        guard Self.owner == nil else { throw makeError("麦克风正在使用") }
        let session = AVAudioSession.sharedInstance()
        switch mode {
        case .conversation:
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        case .transcription:
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        }
        try checkCancellation()
        try session.setActive(true)
        Self.owner = self
        do {
            try checkCancellation()
            let engine = AVAudioEngine()
            self.engine = engine
            if mode == .conversation {
                try engine.inputNode.setVoiceProcessingEnabled(true)
                try configurePlayback(engine)
            }
            try installInputTap(engine)
            try checkCancellation()
            if mode == .conversation { engine.prepare() }
            try engine.start()
            if mode == .conversation { NSLog("LuluVoice audio initial running=%d", engine.isRunning) }
        } catch {
            stop()
            throw error
        }
    }

    func resumePlayback() -> Bool {
        guard !cancelled.withLock({ $0 }), engine?.isRunning == true, let player else { return false }
        if !player.isPlaying { player.play() }
        return true
    }

    func recoverPlayback() throws -> Bool {
        try checkCancellation()
        guard Self.owner === self, let engine else { return false }
        try AVAudioSession.sharedInstance().setActive(true)
        if !engine.isRunning {
            if inputTapped {
                engine.inputNode.removeTap(onBus: 0)
                inputTapped = false
            }
            try installInputTap(engine)
            try checkCancellation()
            engine.prepare()
            try engine.start()
        }
        return resumePlayback()
    }

    func play(_ data: Data) {
        guard !cancelled.withLock({ $0 }), !data.isEmpty, data.count.isMultiple(of: 2),
              let player, let outputFormat,
              let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let target = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(data.count / 2)
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            for index in 0..<Int(buffer.frameLength) {
                let value = UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8
                target[index] = Float(Int16(bitPattern: value)) / 32768
            }
        }
        player.scheduleBuffer(buffer)
        _ = resumePlayback()
    }

    func flushPlayback() {
        guard !cancelled.withLock({ $0 }) else { return }
        player?.stop()
        _ = resumePlayback()
    }

    private func checkCancellation() throws {
        if cancelled.withLock({ $0 }) { throw CancellationError() }
    }

    private func configurePlayback(_ engine: AVAudioEngine) throws {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false) else {
            throw makeError("不支持的音频格式")
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        self.player = player
        outputFormat = format
        if let onOutput {
            engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
                guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
                let count = Int(buffer.frameLength)
                var energy = 0.0
                for index in 0..<count {
                    let sample = Double(samples[index])
                    energy += sample * sample
                }
                onOutput(Self.decibels(energy, count: count))
            }
            outputTapped = true
        }
        if let onConfigurationChange {
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { _ in
                onConfigurationChange()
            }
        }
    }

    private func installInputTap(_ engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target) else {
            throw makeError("麦克风音频格式暂不可用")
        }
        let onInput = self.onInput
        input.installTap(onBus: 0, bufferSize: 2048, format: source) { buffer, _ in
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
            var energy = 0.0
            for index in 0..<count {
                let sample = Double(samples[index]) / 32768
                energy += sample * sample
            }
            onInput(Data(bytes: samples, count: count * 2), Self.decibels(energy, count: count))
        }
        inputTapped = true
    }

    private func stop() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = nil
        if let engine {
            if inputTapped { engine.inputNode.removeTap(onBus: 0) }
            if outputTapped { engine.mainMixerNode.removeTap(onBus: 0) }
            engine.stop()
        }
        inputTapped = false
        outputTapped = false
        player?.stop()
        player = nil
        engine = nil
        outputFormat = nil
        if Self.owner === self {
            Self.owner = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private static func decibels(_ energy: Double, count: Int) -> Double {
        20 * log10(max(sqrt(energy / Double(count)), 0.00001))
    }

    private func makeError(_ message: String) -> NSError {
        NSError(domain: "VoiceAudioGraph", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
