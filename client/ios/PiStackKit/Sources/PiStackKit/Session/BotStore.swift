import Foundation
import Observation

@MainActor @Observable
public final class BotStore {
    public enum Link: Sendable { case connecting, online, offline }
    public enum Halt: Sendable { case notFound }

    public struct Request: Identifiable, Sendable {
        public enum State: Sendable { case sending, failed }

        public let command: Command
        public var state: State
        public var error: String?
        public let at: Date

        public var id: String { command.requestId }
    }

    public struct Snapshot {
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

    private let socketURL: URL
    private var task: URLSessionWebSocketTask?
    private var timer: Task<Void, Never>?
    private var attempts = 0
    private var running = false

    public init(botId: String, server: URL) {
        socketURL = Api.socketURL(base: server, botId: botId)
    }

    public func start() {
        guard !running else { return }
        running = true
        snapshot.link = .connecting
        snapshot.halt = nil
        connect()
    }

    public func stop() {
        running = false
        timer?.cancel()
        timer = nil
        let current = task
        task = nil
        current?.cancel(with: .goingAway, reason: nil)
    }

    public func submit(_ content: String) { dispatch(Command(.submit(content))) }
    public func abort() { dispatch(Command(.abort)) }
    public func selectModel(_ model: ModelRef) { dispatch(Command(.selectModel(model))) }
    public func keep(_ origin: String) { dispatch(Command(.keep(origin: origin))) }
    public func drop(_ origin: String) { dispatch(Command(.drop(origin: origin))) }

    public func reorder(_ layout: Layout, _ ids: [String]) {
        switch layout {
        case .panel: snapshot.panel = PanelState(order: ids, widgets: snapshot.panel.widgets)
        case .assets: snapshot.assets = ids.compactMap { id in snapshot.assets.first { $0.id == id } }
        }
        dispatch(Command(.order(layout, ids)))
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
        guard let request = snapshot.requests.first(where: { $0.id == requestId }) else { return }
        dispatch(request.command)
    }

    public func dismiss(_ requestId: String) {
        snapshot.requests.removeAll { $0.id == requestId }
    }

    private func connect() {
        let task = URLSession.shared.webSocketTask(with: socketURL)
        task.maximumMessageSize = 64 << 20
        self.task = task
        task.resume()
        transmit(["type": "hello"])
        for request in snapshot.requests where request.state == .sending { transmit(request.command.frame) }
        Task { await listen(task) }
    }

    private func listen(_ task: URLSessionWebSocketTask) async {
        while true {
            do {
                let message = try await task.receive()
                guard self.task === task else { return }
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                let decoded = await Task.detached { try? JSONDecoder().decode(ServerMessage.self, from: data) }.value
                guard self.task === task, let decoded else { continue }
                receive(decoded)
            } catch {
                closed(task)
                return
            }
        }
    }

    private func closed(_ task: URLSessionWebSocketTask) {
        guard self.task === task else { return }
        self.task = nil
        snapshot.link = .offline
        switch task.closeCode.rawValue {
        case 4404: snapshot.halt = .notFound
        default:
            guard running else { return }
            let delay = min(15.0, 0.5 * pow(2, Double(attempts)))
            attempts += 1
            timer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                self?.connect()
            }
        }
    }

    private func receive(_ message: ServerMessage) {
        attempts = 0
        snapshot.link = .online
        switch message {
        case .state(let view, let progress, let mcp, let panel, let assets):
            snapshot.view = view.applied(to: snapshot.view)
            snapshot.progress = progress
            snapshot.mcp = mcp
            snapshot.panel = panel
            snapshot.assets = assets
        case .models(let config): snapshot.models = config
        case .voice: break
        case .result(let requestId, let error):
            guard let index = snapshot.requests.firstIndex(where: { $0.id == requestId }) else { return }
            if let error {
                snapshot.requests[index].state = .failed
                snapshot.requests[index].error = error
            } else {
                snapshot.requests.remove(at: index)
            }
        }
    }

    private func dispatch(_ command: Command) {
        snapshot.requests.removeAll { $0.id == command.requestId }
        snapshot.requests.append(Request(command: command, state: .sending, at: .now))
        transmit(command.frame)
    }

    private func transmit(_ frame: [String: Any]) {
        guard let task, let data = try? JSONSerialization.data(withJSONObject: frame) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }
}
