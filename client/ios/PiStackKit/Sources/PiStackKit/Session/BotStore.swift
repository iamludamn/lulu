import Foundation
import Observation

@MainActor @Observable
public final class BotStore {
    public enum Link: Sendable { case connecting, online, offline }
    public enum Halt: Equatable, Sendable { case notFound }

    public struct Request: Identifiable, Sendable {
        public enum State: Sendable { case sending, acknowledged, failed }

        public let command: Command
        public var state: State
        public var error: String?
        public let at: Date

        public var id: String { command.requestId }
    }

    public struct Snapshot {
        public var hasReceivedState = false
        public var link: Link = .connecting
        public var view: ConversationView?
        public var progress: SessionProgress?
        public var models: ModelConfig?
        public var mcp: [McpStatus] = []
        public var panel = PanelState()
        public var assets: [AssetItem] = []
        public var requests: [Request] = []
        public var halt: Halt?
    }

    public private(set) var snapshot = Snapshot()
    @ObservationIgnored private var cachedTranscriptEntries: [ChatEntry]?

    public var transcriptEntries: [ChatEntry] {
        let view = snapshot.view
        let hidden = snapshot.progress?.hiddenEntries ?? []
        if let cachedTranscriptEntries { return cachedTranscriptEntries }
        let entries = chatEntries(view, hidden: hidden)
        cachedTranscriptEntries = entries
        return entries
    }
    public var onVoiceEvent: ((JSONValue) -> Void)?
    public var onVoiceError: ((String) -> Void)?
    public var onASREvent: ((JSONValue) -> Void)?
    public var onASRError: ((String) -> Void)?
    private var asrRequestId: String?
    private var voiceRequestId: String?
    public enum HistoryLoad: Equatable, Sendable {
        case idle
        case loading
        case failed(String)
    }

    public private(set) var historyLoad: HistoryLoad = .idle
    private var historyRequest: (id: String, upperBound: Int)?
    private var historyTimer: Task<Void, Never>?
    private var submitTimers: [String: Task<Void, Never>] = [:]
    private var keepTimers: [String: Task<Void, Never>] = [:]

    private let socketURL: URL
    private let token: String
    private let cacheURL: URL
    private let stateTimeout: Duration
    private let retryTimeout: Duration
    private var stateTimer: Task<Void, Never>?
    @ObservationIgnored private var restoration: Task<Void, Never>?
    private var saving: Task<Void, Never>?
    private var latestState: Data?
    private var task: URLSessionWebSocketTask?
    private var timer: Task<Void, Never>?
    private var attempts = 0
    private var running = false

    public convenience init(botId: String, server: URL, token: String = "") {
        self.init(botId: botId, server: server, token: token, stateTimeout: .seconds(15), retryTimeout: .seconds(30))
    }

    init(botId: String, server: URL, token: String = "", stateTimeout: Duration, retryTimeout: Duration = .seconds(30)) {
        socketURL = Api.socketURL(base: server, botId: botId)
        self.token = token
        cacheURL = Cache.url(for: socketURL)
        self.stateTimeout = stateTimeout
        self.retryTimeout = retryTimeout
    }

    public func start() {
        guard !running, snapshot.halt == nil else { return }
        running = true
        if snapshot.view != nil { snapshot.link = .offline }
        restore()
        connect()
    }

    public func stop() {
        onVoiceError?("连接已关闭，语音通话已结束")
        onASRError?("连接已关闭，语音识别已取消")
        failPendingKeeps("连接已关闭，请重试")
        running = false
        restoration?.cancel()
        restoration = nil
        timer?.cancel()
        timer = nil
        stateTimer?.cancel()
        stateTimer = nil
        let current = task
        task = nil
        current?.cancel(with: .goingAway, reason: nil)
        cancelSubmitTimers()
        if snapshot.halt == nil { snapshot.link = .offline }
        if historyRequest != nil { finishHistory("连接已中断") }
    }

    public func loadEarlier() {
        guard historyRequest == nil, snapshot.halt == nil, let view = snapshot.view, view.before != nil,
              let first = view.entries.first, let before = Int(first.id), before > 0 else { return }
        guard snapshot.link == .online, let task else {
            historyLoad = .failed("连接恢复后可重试")
            return
        }
        let requestId = newId()
        historyRequest = (requestId, before)
        historyLoad = .loading
        historyTimer = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: self.stateTimeout) } catch { return }
            guard self.task === task, self.historyRequest?.id == requestId else { return }
            self.finishHistory("加载超时")
            self.closed(task)
        }
        transmit(["type": "history.load", "requestId": requestId, "before": before])
    }

    public func submit(_ content: String) { dispatch(Command(.submit(content))) }
    public func startASR(_ id: String) {
        asrRequestId = id
        transmit(["type": "asr.start", "requestId": id])
    }
    public func sendASRAudio(_ data: Data, session: String) {
        guard asrRequestId == session else { return }
        transmit(["type": "asr.audio", "requestId": session, "audio": data.base64EncodedString()])
    }
    public func finishASR(_ id: String) {
        transmit(["type": "asr.finish", "requestId": id])
    }
    public func cancelASR(_ id: String) {
        if asrRequestId == id { asrRequestId = nil }
        transmit(["type": "asr.cancel", "requestId": id])
    }
    public func startVoice() {
        NSLog("LuluVoice sending start link=%@", String(describing: snapshot.link))
        let id = newId()
        voiceRequestId = id
        transmit(["type": "voice.start", "requestId": id])
    }
    public func sendVoiceAudio(_ data: Data) {
        transmit(["type": "voice.audio", "requestId": newId(), "audio": data.base64EncodedString()])
    }
    public func muteVoice(_ muted: Bool) {
        transmit(["type": "voice.mute", "requestId": newId(), "muted": muted])
    }
    public func stopVoice() {
        voiceRequestId = nil
        transmit(["type": "voice.stop", "requestId": newId()])
    }
    public func abort() { dispatch(Command(.abort)) }
    public func selectModel(_ model: ModelRef) { dispatch(Command(.selectModel(model))) }
    public func keep(_ origin: String) {
        if let request = snapshot.requests.last(where: { request in
            if case .keep(let value) = request.command.kind { return value == origin }
            return false
        }) {
            guard request.state == .failed else { return }
            retry(request.id)
            return
        }
        dispatch(Command(.keep(origin: origin)))
    }
    public func drop(_ origin: String) { dispatch(Command(.drop(origin: origin))) }

    public func reorderAssets(_ ids: [String]) {
        snapshot.assets = ids.compactMap { id in snapshot.assets.first { $0.id == id } }
        dispatch(Command(.order(ids)))
    }

    public func check(_ widget: String, item index: Int, done: Bool) {
        snapshot.panel = snapshot.panel.checking(widget, item: index, done: done)
        dispatch(Command(.check(id: widget, index: index, done: done)))
    }

    public func makeWidget(origin: String) {
        let same = snapshot.requests.filter {
            if case .makeWidget(origin) = $0.command.kind { return true }
            return false
        }
        guard !same.contains(where: { $0.state == .sending }) else { return }
        snapshot.requests.removeAll { request in same.contains { $0.id == request.id } }
        dispatch(Command(.makeWidget(origin: origin)))
    }

    public func retry(_ requestId: String) {
        guard snapshot.halt == nil, let index = snapshot.requests.firstIndex(where: { $0.id == requestId && $0.state == .failed }) else { return }
        snapshot.requests[index].state = .sending
        snapshot.requests[index].error = nil
        send(snapshot.requests[index].command)
    }

    public func dismiss(_ requestId: String) {
        submitTimers.removeValue(forKey: requestId)?.cancel()
        keepTimers.removeValue(forKey: requestId)?.cancel()
        snapshot.requests.removeAll { $0.id == requestId }
    }

    private func restore() {
        guard snapshot.view == nil else { return }
        let url = cacheURL
        restoration = Task { [weak self] in
            let restored = await Task.detached(priority: .userInitiated) { () -> (Cache, (PanelState, [AssetItem])?)? in
                guard let cache = Cache.load(url)?.offline else { return nil }
                if let data = cache.state ?? (try? Data(contentsOf: url.appendingPathExtension("state"))),
                   let surfaces = try? JSONDecoder().decode(Cache.Surfaces.self, from: data) {
                    return (cache, (surfaces.panel ?? PanelState(), surfaces.assets ?? []))
                }
                return (cache, nil)
            }.value
            guard !Task.isCancelled, let self else { return }
            self.restoration = nil
            guard self.snapshot.halt == nil, self.snapshot.view == nil, let (cache, state) = restored else { return }
            self.cachedTranscriptEntries = nil
            self.snapshot.view = cache.view
            self.snapshot.progress = cache.progress
            if !self.snapshot.hasReceivedState, let (panel, assets) = state {
                self.snapshot.panel = panel
                self.snapshot.assets = assets
            }
        }
    }

    private func persist() {
        guard let view = snapshot.view, let progress = snapshot.progress else { return }
        let cache = Cache(view: view, progress: progress, state: latestState)
        let url = cacheURL
        let previous = saving
        previous?.cancel()
        saving = Task {
            try? await Task.sleep(for: .seconds(1.5))
            await previous?.value
            guard !Task.isCancelled else { return }
            await Task.detached { cache.write(to: url) }.value
        }
    }

    private func connect() {
        guard running, snapshot.halt == nil else { return }
        var request = URLRequest(url: socketURL)
        if socketURL.scheme == "wss", !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 64 << 20
        self.task = task
        task.resume()
        stateTimer?.cancel()
        stateTimer = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: self.stateTimeout) } catch { return }
            guard self.task === task else { return }
            self.snapshot.link = .offline
            do { try await Task.sleep(for: self.retryTimeout) } catch { return }
            guard self.task === task else { return }
            self.closed(task)
        }
        transmit(["type": "hello", "incremental": true])
        Task { await listen(task) }
    }

    private func listen(_ task: URLSessionWebSocketTask) async {
        while true {
            do {
                let message = try await task.receive()
                guard self.task === task else { return }
                let (decoded, state) = await Task.detached { () -> (ServerMessage?, Data?) in
                    let data: Data
                    switch message {
                    case .string(let text): data = Data(text.utf8)
                    case .data(let bytes): data = bytes
                    @unknown default: return (nil, nil)
                    }
                    let decoded = try? JSONDecoder().decode(ServerMessage.self, from: data)
                    if case .state = decoded { return (decoded, data) }
                    return (decoded, nil)
                }.value
                guard self.task === task, let decoded else { continue }
                receive(decoded, data: state)
            } catch {
                closed(task)
                return
            }
        }
    }

    private func closed(_ task: URLSessionWebSocketTask) {
        guard self.task === task else { return }
        self.task = nil
        stateTimer?.cancel()
        stateTimer = nil
        let notFound = task.closeCode.rawValue == 4404
        if notFound {
            snapshot.halt = .notFound
            restoration?.cancel()
            restoration = nil
        }
        snapshot.link = .offline
        failPendingKeeps("连接已断开，请重试")
        if historyRequest != nil { finishHistory("连接已中断") }
        cancelSubmitTimers()
        task.cancel(with: .goingAway, reason: nil)
        onASRError?("连接已断开，语音识别已取消")
        if onVoiceEvent != nil { onVoiceError?("连接已断开，语音通话已结束") }
        guard running, !notFound else { return }
        let delay = min(15.0, 0.5 * pow(2, Double(attempts)))
        attempts += 1
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.connect()
        }
    }

    private func receive(_ message: ServerMessage, data: Data?) {
        switch message {
        case .state(let view, let progress, let mcp, let panel, let assets):
            guard let applied = view.applied(to: snapshot.view) else { return }
            if view.reset == true || view.conversation != snapshot.view?.conversation ||
                !view.entries.isEmpty || view.order != nil ||
                progress.hiddenEntries != (snapshot.progress?.hiddenEntries ?? []) {
                cachedTranscriptEntries = nil
            }
            let connected = snapshot.link != .online
            attempts = 0
            stateTimer?.cancel()
            stateTimer = nil
            latestState = data
            if connected { snapshot.link = .online }
            snapshot.view = applied
            snapshot.progress = progress
            snapshot.mcp = mcp
            snapshot.panel = panel
            snapshot.assets = assets
            snapshot.hasReceivedState = true
            if !snapshot.requests.isEmpty {
                let submitted = Set(progress.messages.compactMap(\.requestId))
                for id in submitted { submitTimers.removeValue(forKey: id)?.cancel() }
                snapshot.requests.removeAll {
                    if case .submit = $0.command.kind { return submitted.contains($0.id) }
                    return false
                }
            }
            if connected {
                for request in snapshot.requests where request.state == .sending { send(request.command) }
            }
            persist()
        case .history(let entries, let before):
            guard let historyRequest, let view = snapshot.view else { return }
            let upperBound = historyRequest.upperBound
            let ids = entries.compactMap { Int($0.id) }
            let joinsWindow = view.before == upperBound || entries.last?.id == view.before.map(String.init)
            guard view.entries.first?.id == String(upperBound), ids.count == entries.count,
                  zip(ids, ids.dropFirst()).allSatisfy({ $0 < $1 }),
                  ids.last.map({ $0 < upperBound && joinsWindow }) ?? (before == nil) else {
                finishHistory("历史消息已更新，请重试")
                return
            }
            cachedTranscriptEntries = nil
            snapshot.view = ConversationView(entries: entries + view.entries, docs: view.docs,
                                             before: before, conversation: view.conversation)
            finishHistory(nil)
            persist()
        case .models(let config): snapshot.models = config
        case .voice(let event):
            if event["type"]?.string == "voice.state" { NSLog("LuluVoice store state %@ callback=%d", event["state"]?.string ?? "", onVoiceEvent != nil) }
            if event["type"]?.string?.hasPrefix("asr.") == true { onASREvent?(event) }
            else { onVoiceEvent?(event) }
        case .result(let requestId, let error):
            if requestId == asrRequestId {
                if let error { onASRError?(error) }
                return
            }
            if requestId == voiceRequestId {
                NSLog("LuluVoice start result error=%@", error ?? "none")
                voiceRequestId = nil
                if let error { onVoiceError?(error) }
                return
            }
            if requestId == historyRequest?.id {
                finishHistory(error ?? "服务器未返回历史消息")
                return
            }
            submitTimers.removeValue(forKey: requestId)?.cancel()
            keepTimers.removeValue(forKey: requestId)?.cancel()
            guard let index = snapshot.requests.firstIndex(where: { $0.id == requestId }) else { return }
            if let error {
                snapshot.requests[index].state = .failed
                snapshot.requests[index].error = error
            } else if case .submit = snapshot.requests[index].command.kind {
                snapshot.requests[index].state = .acknowledged
            } else {
                snapshot.requests.remove(at: index)
            }
        }
    }

    private func finishHistory(_ error: String?) {
        historyTimer?.cancel()
        historyTimer = nil
        historyRequest = nil
        historyLoad = error.map(HistoryLoad.failed) ?? .idle
    }

    private func dispatch(_ command: Command) {
        guard snapshot.halt == nil else { return }
        snapshot.requests.removeAll { $0.id == command.requestId }
        snapshot.requests.append(Request(command: command, state: .sending, at: .now))
        send(command)
    }

    private func send(_ command: Command) {
        let id = command.requestId
        guard snapshot.link == .online, task != nil else {
            if case .keep = command.kind { failRequest(id, "当前未连接，请重试") }
            return
        }
        switch command.kind {
        case .submit:
            submitTimers.removeValue(forKey: id)?.cancel()
            submitTimers[id] = Task { [weak self, retryTimeout] in
                do { try await Task.sleep(for: retryTimeout * 2) } catch { return }
                self?.submitTimers[id] = nil
                self?.failRequest(id, nil)
            }
        case .keep:
            guard keepTimers[id] == nil else { return }
            keepTimers[id] = Task { [weak self, retryTimeout] in
                do { try await Task.sleep(for: retryTimeout) } catch { return }
                self?.keepTimers[id] = nil
                self?.failRequest(id, "收藏确认超时，请重试")
            }
        default:
            break
        }
        transmit(command.frame)
    }

    private func cancelSubmitTimers() {
        for timer in submitTimers.values { timer.cancel() }
        submitTimers.removeAll()
    }

    private func failRequest(_ id: String, _ message: String?) {
        guard let index = snapshot.requests.firstIndex(where: {
            $0.id == id && $0.state == .sending
        }) else { return }
        snapshot.requests[index].state = .failed
        snapshot.requests[index].error = message
    }

    private func failPendingKeeps(_ message: String) {
        for timer in keepTimers.values { timer.cancel() }
        keepTimers.removeAll()
        for index in snapshot.requests.indices where snapshot.requests[index].state == .sending {
            guard case .keep = snapshot.requests[index].command.kind else { continue }
            snapshot.requests[index].state = .failed
            snapshot.requests[index].error = message
        }
    }

    private func transmit(_ frame: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: frame) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in self?.closed(task) }
        }
    }
}
