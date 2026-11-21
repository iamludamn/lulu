import CryptoKit
import Foundation
import SQLite3

@MainActor
final class NoteDatabase {
    private let db: OpaquePointer

    init(scope: String) throws {
        let directory = URL.applicationSupportDirectory.appending(path: "Notes", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        var handle: OpaquePointer?
        let result = sqlite3_open(directory.appending(path: key + ".sqlite3").path, &handle)
        guard let handle else { throw Failure.unavailable }
        guard result == SQLITE_OK,
              sqlite3_exec(handle, "CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)", nil, nil, nil) == SQLITE_OK else {
            sqlite3_close(handle)
            throw Failure.unavailable
        }
        db = handle
    }

    isolated deinit { sqlite3_close(db) }

    func load<T: Decodable>(_ type: T.Type) throws -> T? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT payload FROM snapshot WHERE id = 1", -1, &statement, nil) == SQLITE_OK else {
            throw Failure.unavailable
        }
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let bytes = sqlite3_column_blob(statement, 0) else { throw Failure.unavailable }
        return try JSONDecoder().decode(type, from: Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, 0))))
    }

    func save<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO snapshot (id, payload) VALUES (1, ?)", -1, &statement, nil) == SQLITE_OK else {
            throw Failure.unavailable
        }
        defer { sqlite3_finalize(statement) }
        let result = data.withUnsafeBytes { bytes -> Int32 in
            guard sqlite3_bind_blob(statement, 1, bytes.baseAddress, Int32(bytes.count), nil) == SQLITE_OK else { return SQLITE_ERROR }
            return sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw Failure.unavailable }
    }

    private enum Failure: LocalizedError {
        case unavailable
        var errorDescription: String? { "无法保存本地笔记" }
    }
}
