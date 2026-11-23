import Foundation
import Observation

@MainActor @Observable
final class ChatDraft {
    var text: String {
        didSet {
            guard text != oldValue else { return }
            saveTask?.cancel()
            if text.isEmpty {
                flush()
            } else {
                saveTask = Task { [weak self] in
                    do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
                    self?.flush()
                }
            }
        }
    }

    private let key: String
    private let defaults: UserDefaults
    @ObservationIgnored private var saveTask: Task<Void, Never>?

    init(botId: String, defaults: UserDefaults = .standard) {
        key = "lulu.draft.\(botId)"
        self.defaults = defaults
        text = defaults.string(forKey: key) ?? ""
    }

    func flush() {
        saveTask?.cancel()
        saveTask = nil
        if text.isEmpty { defaults.removeObject(forKey: key) }
        else { defaults.set(text, forKey: key) }
    }
}
