import Foundation

public enum SpaceOfferState: Equatable, Sendable {
    case add, update, accepted(SpaceReceipt.Action), superseded

    public var actionable: Bool { self == .add || self == .update }
    public var caption: String {
        switch self {
        case .add: "滑动加入视图"
        case .update: "滑动更新视图"
        case .accepted(.add): "已加入视图"
        case .accepted(.update): "已更新"
        case .superseded: "已有新版"
        }
    }
}

extension PanelWidget {
    public var spaceVersion: Int? {
        guard case .space(let src, _, _, _) = body,
              let address = ArtifactAddress(src), address.name == "spaces/\(id)/index.html" else { return nil }
        return address.version
    }
}

/// Reconstructed from delivered offers and durable panel receipts, never a local
/// hidden-card set. Pending network commands do not count as accepted updates.
public func spaceOfferStates(_ entries: [ChatEntry], panel: PanelState) -> [String: SpaceOfferState] {
    var latest: [String: (origin: String, version: Int)] = [:]
    for entry in entries {
        guard case .panel(let widget) = entry.card, let version = widget.spaceVersion else { continue }
        if version >= (latest[widget.id]?.version ?? -1) { latest[widget.id] = (entry.id, version) }
    }
    var acceptedVersions: [String: Int] = [:]
    for receipt in panel.spaceReceipts.values {
        acceptedVersions[receipt.id] = max(acceptedVersions[receipt.id] ?? receipt.version, receipt.version)
    }
    return Dictionary(uniqueKeysWithValues: entries.compactMap { entry in
        guard case .panel(let widget) = entry.card, let version = widget.spaceVersion else { return nil }
        let current = panel.widgets[widget.id]
        if current != nil, let receipt = panel.spaceReceipts[entry.id] {
            return (entry.id, .accepted(receipt.action))
        }
        if current?.origin == entry.id { return (entry.id, .accepted(.add)) }
        let floor = max(acceptedVersions[widget.id] ?? 0, current?.spaceVersion ?? 0)
        guard latest[widget.id]?.origin == entry.id, version >= floor,
              current == nil || version > floor else { return (entry.id, .superseded) }
        return (entry.id, current == nil ? .add : .update)
    })
}
