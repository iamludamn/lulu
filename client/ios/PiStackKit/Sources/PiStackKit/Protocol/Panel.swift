import Foundation

public enum Tone: String, Decodable, Sendable {
    case neutral, good, warn, bad, accent
}

public enum SpaceRefresh: String, Decodable, Sendable {
    case manual, open, daily
}

public struct PanelWidget: Decodable, Identifiable, Equatable, Sendable {
    public enum Size: String, Decodable, Sendable { case s, m, l }

    public enum Value: Decodable, Equatable, Sendable {
        case number(Double)
        case text(String)

        public init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                self = .number(number)
            } else {
                self = .text(try container.decode(String.self))
            }
        }
    }

    public struct Delta: Decodable, Equatable, Sendable {
        public let text: String
        public let tone: Tone
    }

    public struct Meter: Decodable, Equatable, Sendable {
        public let label: String
        public let value: Double
        public let max: Double
        public let tone: Tone?
    }

    public struct Series: Decodable, Equatable, Sendable {
        public let name: String
        public let values: [Double]
        public let tone: Tone?
    }

    public struct Item: Decodable, Equatable, Sendable {
        public let title: String
        public let subtitle: String?
        public let value: String?
        public let tone: Tone?
        public let done: Bool?
    }

    public struct Event: Decodable, Equatable, Sendable {
        public let at: Double
        public let end: Double?
        public let title: String
        public let detail: String?
        public let tone: Tone?
    }

    public struct Button: Decodable, Equatable, Sendable {
        public let label: String
        public let icon: String?
        public let prompt: String
    }

    public enum Body: Decodable, Equatable, Sendable {
        case stat(value: Value, unit: String?, at: Double?, delta: Delta?, spark: [Double])
        case gauge([Meter])
        case chart(bars: Bool, x: [String], series: [Series])
        case list([Item])
        case timeline([Event])
        case note(String)
        case media(src: String, caption: String?)
        case space(src: String, summary: String?, refresh: SpaceRefresh)
        case actions([Button])
        case unknown

        private enum Keys: String, CodingKey { case kind, value, unit, at, delta, spark, items, mark, x, series, events, markdown, src, caption, buttons, summary, refresh }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            switch try c.decode(String.self, forKey: .kind) {
            case "stat":
                self = .stat(
                    value: try c.decode(Value.self, forKey: .value),
                    unit: try c.decodeIfPresent(String.self, forKey: .unit),
                    at: try c.decodeIfPresent(Double.self, forKey: .at),
                    delta: try c.decodeIfPresent(Delta.self, forKey: .delta),
                    spark: try c.decodeIfPresent([Double].self, forKey: .spark) ?? []
                )
            case "gauge": self = .gauge(try c.decode([Meter].self, forKey: .items))
            case "chart":
                self = .chart(
                    bars: try c.decodeIfPresent(String.self, forKey: .mark) == "bar",
                    x: try c.decode([String].self, forKey: .x),
                    series: try c.decode([Series].self, forKey: .series)
                )
            case "list": self = .list(try c.decode([Item].self, forKey: .items))
            case "timeline": self = .timeline(try c.decode([Event].self, forKey: .events))
            case "note": self = .note(try c.decode(String.self, forKey: .markdown))
            case "media": self = .media(src: try c.decode(String.self, forKey: .src), caption: try c.decodeIfPresent(String.self, forKey: .caption))
            // "web" is what the first release called a space; keep reading widgets stored under it.
            case "space", "web": self = .space(
                    src: try c.decode(String.self, forKey: .src),
                    summary: try c.decodeIfPresent(String.self, forKey: .summary),
                    refresh: (try? c.decodeIfPresent(SpaceRefresh.self, forKey: .refresh)).flatMap { $0 } ?? .manual
                )
            case "actions": self = .actions(try c.decode([Button].self, forKey: .buttons))
            default: self = .unknown
            }
        }
    }

    public var isSpace: Bool {
        if case .space = body { return true }
        return false
    }

    public let id: String
    public let size: Size
    public let title: String
    public let icon: String?
    public let tone: Tone?
    public let ask: String?
    public let updatedAt: Double?
    public let origin: String?
    public let body: Body
}

public struct PanelState: Decodable, Equatable, Sendable {
    public let order: [String]
    public let widgets: [String: PanelWidget]

    public init(order: [String] = [], widgets: [String: PanelWidget] = [:]) {
        self.order = order
        self.widgets = widgets
    }

    private struct Lenient: Decodable {
        let widget: PanelWidget?

        init(from decoder: Decoder) throws {
            widget = try? PanelWidget(from: decoder)
        }
    }

    private enum Keys: String, CodingKey { case order, widgets }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        order = try container.decode([String].self, forKey: .order)
        widgets = try container.decode([String: Lenient].self, forKey: .widgets).compactMapValues(\.widget)
    }

    public var list: [PanelWidget] { order.compactMap { widgets[$0] } }
}

public struct ArtifactAddress: Identifiable, Hashable, Sendable {
    public let name: String
    public let version: Int?

    public init?(_ ref: String) {
        guard ref.hasPrefix("artifact://") else { return nil }
        let rest = ref.dropFirst("artifact://".count)
        if let at = rest.lastIndex(of: "@"), let version = Int(rest[rest.index(after: at)...]) {
            name = String(rest[..<at])
            self.version = version
        } else {
            name = String(rest)
            version = nil
        }
    }

    public var id: String { "\(name)@\(version ?? 0)" }
    public var fileName: String { (name as NSString).lastPathComponent }
    public var isMarkdown: Bool { ["md", "markdown"].contains((name as NSString).pathExtension.lowercased()) }
    public var isHTML: Bool { ["html", "htm"].contains((name as NSString).pathExtension.lowercased()) }
}

public enum SentCard: Equatable, Sendable {
    case panel(PanelWidget)
    case asset(ref: String, title: String, summary: String?)
}

public struct AssetItem: Decodable, Identifiable, Equatable, Sendable {
    public let origin: String
    public let ref: String
    public let title: String
    public let summary: String?
    public let savedAt: Double

    public var id: String { origin }
}
