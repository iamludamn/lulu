import Foundation

public struct ModelRef: Codable, Hashable, Sendable {
    public let provider: String
    public let id: String

    public init(provider: String, id: String) {
        self.provider = provider
        self.id = id
    }
}

public struct ModelConfig: Codable, Sendable {
    public let model: ModelRef?
    public let overridden: Bool
    public let models: [ModelRef]
}

public struct McpStatus: Codable, Identifiable, Sendable {
    public enum Source: String, Codable, Sendable { case bot, platform }
    public enum State: String, Codable, Sendable {
        case connected, failed
        case needsAuth = "needs-auth"
    }

    public let name: String
    public let source: Source
    public let state: State
    public let tools: Int
    public let error: String?
    public let checkedAt: Double

    public var id: String { name }
}

public struct SubtaskProgress: Codable, Identifiable, Sendable {
    public let id: String
    public let description: String
    public let running: Bool
}

public struct MessageProgress: Codable, Identifiable, Sendable {
    public enum State: String, Codable, Sendable { case todo, processing, done }

    public let id: Int
    public let entry: String?
    public let answer: String?
    public let text: String
    public let after: Int?
    public let state: State
    public let error: String?
    public let subtasks: [SubtaskProgress]
}

public struct SessionProgress: Codable, Sendable {
    public let messages: [MessageProgress]
    public let hiddenEntries: [String]
}

public struct MemoryCommit: Codable, Identifiable, Sendable {
    public let oid: String
    public let message: String
    public let at: Double

    public var id: String { oid }
}

public struct MemoryListing: Codable, Sendable {
    public let files: [String]
    public let commits: [MemoryCommit]
}

public enum Schedule: Decodable, Sendable {
    case once(at: Double)
    case daily(time: String, tz: String)

    private enum Keys: String, CodingKey { case kind, at, time, tz }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "once": self = .once(at: try container.decode(Double.self, forKey: .at))
        default: self = .daily(time: try container.decode(String.self, forKey: .time), tz: try container.decode(String.self, forKey: .tz))
        }
    }
}

public struct ScheduleEntry: Decodable, Identifiable, Sendable {
    public enum State: String, Decodable, Sendable { case active, paused, done, missed }

    public struct Run: Decodable, Sendable {
        public enum Status: String, Decodable, Sendable { case running, done, failed, closed }
        public let scheduledFor: Double
        public let status: Status
    }

    public let id: String
    public let name: String
    public let schedule: Schedule
    public let state: State
    public let nextRunAt: Double?
    public let lastRun: Run?
}

public struct ToolSlot: Sendable {
    public let name: String
    public let done: Bool
}

public let liveDoc = "pi.live"
