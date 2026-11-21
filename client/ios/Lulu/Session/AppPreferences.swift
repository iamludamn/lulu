import Foundation

enum AppPreferences {
    static let server = "lulu.server"
    static let wallpaper = "lulu.wallpaper"

    static func migrateLegacyKeys(in defaults: UserDefaults, domain: String) {
        guard let preferences = defaults.persistentDomain(forName: domain) else { return }
        let legacyPrefix = "pistack."
        for (legacyKey, value) in preferences where legacyKey.hasPrefix(legacyPrefix) {
            let key = "lulu.\(legacyKey.dropFirst(legacyPrefix.count))"
            if preferences[key] == nil { defaults.set(value, forKey: key) }
            defaults.removeObject(forKey: legacyKey)
        }
    }
}
