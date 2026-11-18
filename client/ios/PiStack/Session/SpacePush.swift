import PiStackKit
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class SpacePush: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    static let shared = SpacePush()

    private let enabledKey = "space.push.enabled"
    private var destination: (Api, String)?
    private var token: String?
    private(set) var pendingSpace: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = Self.shared
        return true
    }

    func connect(api: Api, botId: String) async {
        destination = (api, botId)
        guard UserDefaults.standard.bool(forKey: enabledKey) else { return }
        let permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if permission == .authorized || permission == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
            await register()
        } else if let token {
            try? await api.spaceDevice(botId, token: token, enabled: false)
        }
    }

    func enable(api: Api, botId: String) async {
        if (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) == true {
            UserDefaults.standard.set(true, forKey: enabledKey)
            await connect(api: api, botId: botId)
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Self.shared.token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await Self.shared.register() }
    }

    private func register() async {
        guard let (api, botId) = destination, let token else { return }
        try? await api.spaceDevice(botId, token: token, enabled: true)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let space = response.notification.request.content.userInfo["space"] as? String else { return }
        await MainActor.run {
            Self.shared.pendingSpace = space
            NotificationCenter.default.post(name: .openSpaceUpdate, object: space)
        }
    }

    func opened(_ id: String) {
        if pendingSpace == id { pendingSpace = nil }
    }
}

extension Notification.Name {
    static let openSpaceUpdate = Notification.Name("openSpaceUpdate")
}
