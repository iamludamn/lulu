import Foundation

let scheduleOfferKind = "lulu.schedules.offer"
let scheduleOriginPrefix = "schedules:"

public func scheduleOfferState(_ entry: ChatEntry, panel: PanelState) -> ViewOfferState? {
    guard case .panel(let widget) = entry.card, case .schedules(let revision, _) = widget.body else { return nil }
    let current = panel.widgets[widget.id]
    if current?.origin == entry.id, let receipt = panel.scheduleReceipts[entry.id] {
        return .accepted(receipt.action)
    }
    if entry.id.hasPrefix(scheduleOriginPrefix), revision != panel.scheduleRevision { return .superseded }
    return current == nil ? .add : .superseded
}
