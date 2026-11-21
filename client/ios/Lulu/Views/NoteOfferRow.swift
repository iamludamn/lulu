import SwiftUI

struct NoteOfferRow: View {
    let offer: NoteStore.Offer
    let files: [NoteFile]
    let sending: Bool
    let error: String?
    let onLand: () -> Void
    let onAccept: () -> Void
    @State private var settled: Bool
    @State private var showsPreview = false

    init(offer: NoteStore.Offer, files: [NoteFile], sending: Bool = false, error: String? = nil, onLand: @escaping () -> Void, onAccept: @escaping () -> Void) {
        self.offer = offer
        self.files = files
        self.sending = sending
        self.error = error
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
                    if offer.outcome != .outdated { onLand() }
                }, onKeep: onAccept, sending: sending, confirmed: offer.outcome != nil, failed: error != nil) { accept, armed in
                    offerContent(armed: armed)
                        .accessibilityAction(named: offer.original == nil ? "存入笔记" : "更新原笔记") {
                            accept()
                        }
                }
            }
        }
        .sheet(isPresented: $showsPreview) {
            if let original = offer.original {
                NoteUpdatePreview(original: original, proposed: offer.note, files: files)
            }
        }
        .onAppear { if offer.outcome != nil { settled = true } }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func offerContent(armed: Bool) -> some View {
        if let original = offer.original {
            Button { showsPreview = true } label: {
                face(armed: armed, original: original)
            }
            .buttonStyle(.plain)
            .accessibilityHint("查看修改前后完整内容")
        } else {
            face(armed: armed, original: nil)
        }
    }

    private func face(armed: Bool, original: Note?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(original == nil ? "笔记" : "笔记更新", systemImage: "note.text")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(offer.note.displayTitle).font(.headline)
            if let original {
                let changedLines = NoteUpdatePreview.addedLines(before: original.body, after: offer.note.body)
                if let first = changedLines.first {
                    Text(first).font(.subheadline).lineSpacing(3).lineLimit(3)
                } else if original.body != offer.note.body {
                    Text("删减了正文").font(.subheadline)
                }
                let retained = Set(original.fileIDs).intersection(offer.note.fileIDs).count
                if retained > 0 {
                    Label("保留 \(retained) 个附件", systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
                }
                Label("查看更新预览", systemImage: "chevron.right")
                    .font(.caption.weight(.semibold))
            } else {
                Text(offer.note.body).font(.subheadline).lineSpacing(3).lineLimit(5)
                ForEach(offer.note.checks.prefix(2)) { item in
                    Label(item.text, systemImage: item.done ? "checkmark.circle.fill" : "circle")
                        .font(.subheadline)
                        .lineLimit(1)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
            Label(original == nil ? "右滑存入笔记" : "右滑更新原笔记", systemImage: "arrow.right")
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

private struct NoteUpdatePreview: View {
    let original: Note
    let proposed: Note
    let files: [NoteFile]
    @Environment(\.dismiss) private var dismiss
    @State private var showsProposed = true

    private var note: Note { showsProposed ? proposed : original }
    private var changedLines: Set<Int> {
        let comparison = showsProposed ? original.body : proposed.body
        return Set(Self.insertions(before: comparison, after: note.body).map { $0.index })
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(note.displayTitle).font(.largeTitle.bold())
                    let lines = Self.lines(note.body)
                    if lines.isEmpty {
                        Text("无正文").foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(lines.indices, id: \.self) { index in
                                let line = lines[index]
                                Text(line.isEmpty ? " " : line)
                                    .padding(.vertical, 2)
                                    .padding(.horizontal, 4)
                                    .background {
                                        if changedLines.contains(index) {
                                            RoundedRectangle(cornerRadius: 4).fill(Color.accentColor.opacity(0.12))
                                        }
                                    }
                            }
                        }
                        .lineSpacing(4)
                    }
                    ForEach(note.checks) { check in
                        Label(check.text, systemImage: check.done ? "checkmark.circle.fill" : "circle")
                    }
                    ForEach(files.filter { note.fileIDs.contains($0.id) }) { file in
                        Label(file.filename, systemImage: "paperclip")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: 620, alignment: .leading)
                .padding(20)
                .textSelection(.enabled)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("对照版本", selection: $showsProposed) {
                    Text("修改前").tag(false)
                    Text("修改后").tag(true)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 620)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(Color.paper)
            }
            .background(Color.paper)
            .navigationTitle("更新预览")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    static func addedLines(before: String, after: String) -> [String] {
        insertions(before: before, after: after).map { $0.text }.filter { !$0.isEmpty }
    }

    private static func insertions(before: String, after: String) -> [(index: Int, text: String)] {
        lines(after).difference(from: lines(before)).insertions.compactMap { change in
            if case let .insert(index, line, _) = change { return (index, line) }
            return nil
        }
    }

    private static func lines(_ text: String) -> [String] {
        text.isEmpty ? [] : text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map(String.init)
    }
}
