import AVFoundation
import Observation
import PiStackKit
import UIKit

@MainActor @Observable
final class VoiceTranscription {
    private enum Phase { case idle, starting, recording, processing }
    private var phase = Phase.idle
    var starting: Bool { phase == .starting }
    var recording: Bool { phase == .recording }
    var processing: Bool { phase == .processing }
    private(set) var levels = Array(repeating: CGFloat.zero, count: 32)
    private var smoothedLevel: CGFloat = 0
    private(set) var error: String?
    private var id: String?
    @ObservationIgnored private var audio: VoiceAudioGraph?
    @ObservationIgnored private var asrStarted = false
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
        phase = .starting
        self.store = store
        Task { [weak self] in
            guard self?.isCurrent(token) == true else { return }
            let granted = await AVAudioApplication.requestRecordPermission()
            guard let self, self.isCurrent(token) else { return }
            guard granted else { self.fail("请在系统设置中允许麦克风访问"); return }
            guard self.store?.snapshot.link == .online else {
                self.fail("当前未连接，无法识别语音")
                return
            }
            self.startAudio(token)
        }
    }

    func finish(_ completion: @escaping (String) -> Void) {
        guard let token = id, isCurrent(token) else { return }
        guard !processing else { return }
        guard recording else {
            fail("录音尚未开始，请按住后再说话")
            return
        }
        stopAudio()
        self.completion = completion
        phase = .processing
        flush(final: true)
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, let self, self.isCurrent(token) else { return }
            self.fail("语音识别超时，请重试")
        }
    }

    func cancel() {
        let previous = id
        id = nil
        stopAudio()
        timeout?.cancel(); timeout = nil
        if asrStarted, let previous {
            store?.onASREvent = nil
            store?.onASRError = nil
            store?.cancelASR(previous)
        }
        asrStarted = false
        store = nil
        pending = Data(); ready = false; bytes = 0
        completion = nil; phase = .idle
    }

    private func isCurrent(_ token: String) -> Bool {
        guard id == token else { return false }
        if UIApplication.shared.applicationState == .background {
            cancel()
            return false
        }
        return true
    }

    private func fail(_ message: String) { cancel(); error = message }

    private func receive(_ event: JSONValue) {
        guard let id, event["sessionId"]?.string == id, isCurrent(id) else { return }
        switch event["type"]?.string {
        case "asr.ready":
            guard !ready else { return }
            ready = true
            flush(final: processing)
        case "asr.error": fail(event["message"]?.string ?? "语音识别失败，请重试")
        case "asr.transcript":
            guard processing, event["final"] == .bool(true) else { return }
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

    private func startAudio(_ token: String) {
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, let self, self.isCurrent(token), self.starting else { return }
            self.fail("麦克风启动超时，请重试")
        }
        let graph = VoiceAudioGraph(mode: .transcription, onInput: { [weak self] data, decibels in
            let level = CGFloat(min(1, max(0, (decibels + 55) / 47)))
            Task { @MainActor [weak self] in
                self?.capture(data, level: level, token: token)
            }
        })
        audio = graph
        graph.enqueue { [weak self] graph in
            do {
                try graph.start()
            } catch {
                let message = "录音启动失败：\(error.localizedDescription)"
                Task { @MainActor [weak self] in
                    guard let self, self.isCurrent(token), self.starting || self.recording else { return }
                    self.fail(message)
                }
            }
        }
    }

    private func capture(_ data: Data, level: CGFloat, token: String) {
        guard isCurrent(token), starting || recording else { return }
        if starting {
            guard let store, store.snapshot.link == .online else {
                fail("当前未连接，无法识别语音")
                return
            }
            phase = .recording
            asrStarted = true
            store.onASREvent = { [weak self] event in self?.receive(event) }
            store.onASRError = { [weak self] message in self?.fail(message) }
            store.startASR(token)
            timeout?.cancel()
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled, let self, self.isCurrent(token) else { return }
                self.fail("录音超时，请控制在 60 秒以内")
            }
        }
        let smoothing = level > smoothedLevel ? 0.65 : 0.25
        smoothedLevel += (level - smoothedLevel) * smoothing
        levels.removeFirst()
        levels.append(smoothedLevel)
        bytes += data.count
        guard bytes <= 60 * 32000 else { fail("录音已超过 60 秒"); return }
        pending.append(data)
        flush(final: false)
    }

    private func stopAudio() {
        smoothedLevel = 0
        levels = Array(repeating: 0, count: 32)
        audio?.cancel()
        audio = nil
    }
}
