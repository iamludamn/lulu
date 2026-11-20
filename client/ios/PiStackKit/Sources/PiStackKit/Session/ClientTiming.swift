import Foundation
import OSLog

public enum ClientTiming {
    private static let logger = Logger(subsystem: "lulu", category: "performance")

    public static func mark(_ stage: String, at uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        logger.info("\(stage, privacy: .public) uptime=\(uptime, privacy: .public)")
    }
}
