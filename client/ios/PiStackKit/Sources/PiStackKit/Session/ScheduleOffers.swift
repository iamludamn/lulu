import Foundation

let scheduleOfferKind = "lulu.schedules.offer"
let scheduleOriginPrefix = "schedules:"

public func scheduleOfferState(_ entry: ChatEntry, panel: PanelState) -> ViewOfferState? {
    guard case .panel(let widget) = entry.card, case .schedules(let revision, _) = widget.body else { return nil }
    let current = panel.widgets[widget.id]
    if current?.origin == entry.id, let receipt = panel.scheduleReceipts[entry.id] {
        return .accepted(receipt.action)
    }
    guard revision == panel.scheduleRevision else { return .superseded }
    return current == nil ? .add : .update
}
