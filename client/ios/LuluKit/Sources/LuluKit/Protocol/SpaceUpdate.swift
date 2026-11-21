import Foundation

public struct SpaceUpdate: Codable, Equatable, Sendable {
    public struct Mode: Codable, Equatable, Sendable {
        public struct Source: Codable, Equatable, Sendable {
            public let kind: String
            public var query: String?
            public var urls: [String]?
            public var url: String?

            public init(kind: String, query: String? = nil, urls: [String]? = nil, url: String? = nil) {
                self.kind = kind
                self.query = query
                self.urls = urls
                self.url = url
            }
        }

        public let kind: String
        public var url: String?
        public var time: String?
        public var tz: String?
        public var provider: String?
        public var goal: String?
        public var source: Source?

        public init(kind: String, url: String? = nil, time: String? = nil, tz: String? = nil, provider: String? = nil, goal: String? = nil, source: Source? = nil) {
            self.kind = kind
            self.url = url
            self.time = time
            self.tz = tz
            self.provider = provider
            self.goal = goal
            self.source = source
        }
    }

    public let mode: Mode
    public let enabled: Bool
    public let checkedAt: Double?
    public let updatedAt: Double?
    public let nextAt: Double?
    public let error: String?
    public let version: Int
    public let seen: Int
    public let notify: Bool
    public let phase: String?
    public let cost: Double
    public let credits: Int?

    public var hasNewContent: Bool { version > seen && mode.kind != "manual" }
}

public struct SpaceContent: Decodable, Sendable {
    public struct Finding: Decodable, Identifiable, Sendable {
        public let id: String
        public let url: URL
        public let title: String
        public let detail: String?
        public let observedAt: Double
        public let truncated: Bool?
    }

    public struct Dataset: Decodable, Sendable {
        public let version: Int
        public let updatedAt: Double?
        public let findings: [Finding]
    }

    public let providers: [String]?
    public let status: SpaceUpdate?
    public let data: Dataset?
}
