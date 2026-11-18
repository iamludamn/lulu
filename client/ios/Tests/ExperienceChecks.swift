import Foundation

@main struct ExperienceChecks {
    @MainActor static func main() async throws {
        checkScrollThresholds()
        try await checkDraftPersistence()
        print("iOS experience checks passed")
    }

    private static func checkScrollThresholds() {
        var state = ChatBottomState()
        state.update(distance: 160, userScrolling: false)
        precondition(state.pinned && !state.showJump)
        state.update(distance: 64, userScrolling: true)
        precondition(state.pinned && !state.showJump)
        state.update(distance: 65, userScrolling: true)
        precondition(!state.pinned && state.showJump)
        state.update(distance: 40, userScrolling: true)
        precondition(!state.pinned && state.showJump)
        state.update(distance: 12, userScrolling: false)
        precondition(!state.pinned && state.showJump)
        state.update(distance: 24, userScrolling: true)
        precondition(state.pinned && !state.showJump)
        state.update(distance: 160, userScrolling: true)
        state.followLatest()
        state.update(distance: 100, userScrolling: false)
        precondition(state.pinned && !state.showJump)
        state.update(distance: 100, userScrolling: true)
        precondition(!state.pinned && state.showJump)
    }

    @MainActor private static func checkDraftPersistence() async throws {
        let suite = "lulu.experience.check.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else { fatalError("No defaults suite") }
        defer { defaults.removePersistentDomain(forName: suite) }
        let draft = ChatDraft(botId: "bot", defaults: defaults)
        let key = "pistack.draft.bot"
        draft.text = "first"
        draft.text = "latest"
        precondition(defaults.string(forKey: key) == nil)
        try await Task.sleep(for: .milliseconds(600))
        precondition(defaults.string(forKey: key) == "latest")
        draft.text = "background"
        draft.flush()
        precondition(ChatDraft(botId: "bot", defaults: defaults).text == "background")
        draft.text = "unsent"
        draft.text = ""
        try await Task.sleep(for: .milliseconds(500))
        precondition(defaults.string(forKey: key) == nil)
    }
}
