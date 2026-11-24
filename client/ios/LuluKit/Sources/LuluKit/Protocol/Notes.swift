import Foundation

public struct NotePayload: Codable, Equatable, Sendable {
    public struct Block: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable { case text, check, file }
        public let id: UUID
        public let kind: Kind
        public let text: String?
        public let done: Bool?
        public let ref: String?

        public init(id: UUID, kind: Kind, text: String? = nil, done: Bool? = nil, ref: String? = nil) {
            self.id = id
            self.kind = kind
            self.text = text
            self.done = done
            self.ref = ref
        }
    }

    public let title: String
    public let blocks: [Block]
    public let source: String?

    public init(title: String, blocks: [Block], source: String?) {
        self.title = title
        self.blocks = blocks
        self.source = source
    }
}

public struct NoteRevision: Codable, Equatable, Sendable {
    public let id: UUID
    public let revision: Int
    public let updatedAt: Double
    public let title: String
    public let blocks: [NotePayload.Block]
    public let source: String?

    public var payload: NotePayload { NotePayload(title: title, blocks: blocks, source: source) }
}

public struct NoteMutation: Codable, Sendable {
    public let id: UUID
    public let requestId: UUID
    public let baseRevision: Int
    public let content: NotePayload

    public init(id: UUID, requestId: UUID, baseRevision: Int, content: NotePayload) {
        self.id = id
        self.requestId = requestId
        self.baseRevision = baseRevision
        self.content = content
    }
}

public struct NoteGallery: Decodable, Sendable {
    struct Cursor: Decodable, Sendable {
        let updatedAt: Int64
        let id: UUID
    }

    let next: Cursor?
    public let notes: [NoteRevision]
    public let pinned: [String]
}

public struct NoteProposal: Decodable, Equatable, Sendable {
    public let id: UUID
    public let base: NoteRevision?
    public let content: NotePayload
    public let at: Double
}

public struct NoteAcceptance: Decodable, Equatable, Sendable {
    public let id: UUID
    public let editing: Bool
}

public struct NoteExchange: Codable, Sendable {
    public let question: String
    public let reply: String

    public init(question: String, reply: String) {
        self.question = question
        self.reply = reply
    }
}

public struct NoteAnswer: Decodable, Sendable {
    public let reply: String
    public let content: NotePayload?

    public init(reply: String, content: NotePayload? = nil) {
        self.reply = reply
        self.content = content
    }
}
