import AppKit
import PiStackKit
import UserNotifications

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    var onOpen: () -> Void = {}
    private var seen: Set<String>?

    func authorize() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func observe(_ rows: [ChatRow], online: Bool, name: String) {
        let replies = rows.filter { $0.role == .assistant && !$0.typing }
        guard var known = seen else {
            if online { seen = Set(replies.map(\.id)) }
            return
        }
        let fresh = replies.filter { !known.contains($0.id) }
        guard !fresh.isEmpty else { return }
        fresh.forEach { known.insert($0.id) }
        seen = known
        guard !NSApp.isActive, Bundle.main.bundleIdentifier != nil else { return }
        for row in fresh {
            let content = UNMutableNotificationContent()
            content.title = name
            content.body = row.card.map(cardText) ?? row.text
            content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: row.id, content: content, trigger: nil))
        }
    }

    private func cardText(_ card: SentCard) -> String {
        switch card {
        case .panel(let widget): "发来一个组件：\(widget.title)"
        case .asset(_, let title, _): "发来一个文件：\(title)"
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run {
            NSApp.activate()
            onOpen()
        }
    }
}
