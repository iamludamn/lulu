import CryptoKit
import Foundation
import Network
import Testing
@testable import PiStackKit

private final class StateServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "lulu.state-test")
    private let ready = DispatchSemaphore(value: 0)
    private var connections: [NWConnection] = []
    private let stateDelay: TimeInterval?

    init(stateDelay: TimeInterval?) throws {
        self.stateDelay = stateDelay
        listener = try NWListener(using: .tcp, on: .any)
        listener.stateUpdateHandler = { [ready] state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            if self.stateDelay != nil { self.receiveHandshake(connection, data: Data()) }
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success else {
            listener.cancel()
            throw URLError(.cannotConnectToHost)
        }
    }

    var port: UInt16 { listener.port!.rawValue }
    var connectionCount: Int { queue.sync { connections.count } }

    func stop() {
        listener.cancel()
        queue.sync { connections.forEach { $0.cancel() }; connections.removeAll() }
    }

    private func receiveHandshake(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] bytes, _, _, error in
            guard let self, error == nil, let bytes, !bytes.isEmpty else { return }
            let request = data + bytes
            guard let text = String(data: request, encoding: .utf8) else { return }
            guard text.contains("\r\n\r\n") else { self.receiveHandshake(connection, data: request); return }
            guard let header = text.components(separatedBy: "\r\n").first(where: { $0.lowercased().hasPrefix("sec-websocket-key:") }),
                  let key = header.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) else { return }
            let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
            let accept = Data(digest).base64EncodedString()
            let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
            let json = #"{"type":"state","view":{"entries":[],"order":[],"docs":{}},"progress":{"messages":[],"hiddenEntries":[]},"mcp":[],"panel":{"order":[],"widgets":{}},"assets":[]}"#
            let payload = Data(json.utf8)
            var frame = Data([0x81, 126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)])
            frame.append(payload)
            connection.send(content: Data(response.utf8), completion: .contentProcessed { error in
                guard error == nil else { return }
                self.queue.asyncAfter(deadline: .now() + (self.stateDelay ?? 0)) {
                    connection.send(content: frame, completion: .contentProcessed { _ in })
                }
            })
        }
    }
}

@MainActor private func waitFor(_ predicate: () -> Bool) async throws -> Bool {
    for _ in 0..<100 {
        if predicate() { return true }
        try await Task.sleep(for: .milliseconds(20))
    }
    return predicate()
}

@Test @MainActor func missingInitialStateTransitionsOffline() async throws {
    let server = try StateServer(stateDelay: nil)
    defer { server.stop() }
    let store = BotStore(botId: UUID().uuidString, server: URL(string: "http://127.0.0.1:\(server.port)")!, stateTimeout: .milliseconds(250))
    defer { store.stop() }
    store.start()
    #expect(try await waitFor { store.snapshot.link == .offline })
    #expect(!store.snapshot.hasReceivedState)
}

@Test @MainActor func initialStateCancelsConnectionTimeout() async throws {
    let server = try StateServer(stateDelay: 0)
    defer { server.stop() }
    let store = BotStore(botId: UUID().uuidString, server: URL(string: "http://127.0.0.1:\(server.port)")!, stateTimeout: .milliseconds(500))
    defer { store.stop() }
    store.start()
    #expect(try await waitFor { store.snapshot.hasReceivedState })
    try await Task.sleep(for: .milliseconds(700))
    #expect(store.snapshot.link == .online)
}

@Test @MainActor func waitingForCredentialsDoesNotStartConnectionTimeout() async throws {
    let server = try StateServer(stateDelay: 0)
    defer { server.stop() }
    let store = BotStore(botId: UUID().uuidString, server: URL(string: "http://127.0.0.1:\(server.port)")!, token: nil, stateTimeout: .milliseconds(100))
    defer { store.stop() }
    store.start()
    try await Task.sleep(for: .milliseconds(250))
    #expect(server.connectionCount == 0)
    #expect(store.snapshot.link == .connecting)
    store.authorize("")
    #expect(try await waitFor { store.snapshot.hasReceivedState })
}

@Test @MainActor func slowInitialStateStillArrivesAfterOfflineNotice() async throws {
    let server = try StateServer(stateDelay: 0.6)
    defer { server.stop() }
    let store = BotStore(botId: UUID().uuidString, server: URL(string: "http://127.0.0.1:\(server.port)")!, stateTimeout: .milliseconds(250), retryTimeout: .seconds(2))
    defer { store.stop() }
    store.start()
    #expect(try await waitFor { store.snapshot.link == .offline })
    #expect(try await waitFor { store.snapshot.hasReceivedState })
    #expect(store.snapshot.link == .online)
}

@Test @MainActor func stalledConnectionIsRetried() async throws {
    let server = try StateServer(stateDelay: nil)
    defer { server.stop() }
    let store = BotStore(botId: UUID().uuidString, server: URL(string: "http://127.0.0.1:\(server.port)")!, stateTimeout: .milliseconds(100), stateRetryGrace: .milliseconds(100))
    defer { store.stop() }
    store.start()
    #expect(try await waitFor { server.connectionCount >= 2 })
}
