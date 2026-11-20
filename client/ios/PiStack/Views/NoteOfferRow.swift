import SwiftUI

struct NoteOfferRow: View {
    let offer: NoteStore.Offer
    let onLand: () -> Void
    let onAccept: () -> Void
    @State private var settled: Bool

    init(offer: NoteStore.Offer, onLand: @escaping () -> Void, onAccept: @escaping () -> Void) {
        self.offer = offer
        self.onLand = onLand
        self.onAccept = onAccept
        _settled = State(initialValue: offer.outcome != nil)
    }

    var body: some View {
        VStack(alignment: .leading) {
            if settled, let outcome = offer.outcome {
                Label(outcome.label, systemImage: outcome == .outdated ? "info.circle" : "checkmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
            } else {
                SwipeToKeep(destination: .notes, onLand: {
                    settled = true
                    onLand()
                }, onKeep: onAccept, confirmed: offer.outcome != nil) { _, armed in
                    face(armed: armed)
                        .accessibilityAction(named: offer.original == nil ? "存入 Note" : "更新原笔记") {
                            onAccept()
                            settled = true
                            onLand()
                        }
                }
            }
        }
        .onAppear { if offer.outcome != nil { settled = true } }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    private func face(armed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(offer.original == nil ? "Note" : "Note 更新", systemImage: "note.text")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(offer.note.displayTitle).font(.headline)
            Text(offer.note.body).font(.subheadline).lineSpacing(3).lineLimit(5)
            Label(offer.original == nil ? "右滑存入 Note" : "右滑更新原笔记", systemImage: "arrow.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(armed ? .primary : .secondary)
        }
        .padding(14)
        .frame(maxWidth: 360, alignment: .leading)
        .frosted(22)
        .contentShape(.rect(cornerRadius: 22))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("note-offer")
        .padding(.trailing, 28)
    }
}
