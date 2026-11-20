import PiStackKit
import SwiftUI

struct NoteFile: Identifiable {
    let id: String
    let title: String
    let filename: String
    let date: Date
    let summary: String?
    var asset: AssetItem?

    init(asset: AssetItem) {
        id = "asset:" + asset.id
        title = asset.title
        filename = asset.title
        date = Date(timeIntervalSince1970: asset.savedAt / 1000)
        summary = asset.summary
        self.asset = asset
    }

    private init(id: String, title: String, ext: String, date: Date, summary: String) {
        self.id = "mock:" + id
        self.title = title
        filename = title + "." + ext
        self.date = date
        self.summary = summary
    }

    @MainActor
    static func fixtures(_ store: NoteStore) -> [NoteFile] {
        [
            .init(id: "map", title: "苏州散步地图", ext: "pdf", date: store.sampleDate(day: 0, hour: 9, minute: 32),
                  summary: "平江路 → 拙政园 → 苏州博物馆"),
            .init(id: "coffee", title: "苏州咖啡店清单", ext: "html", date: store.sampleDate(day: -1, hour: 16, minute: 22),
                  summary: "十全街｜有露台\n平江路｜适合歇脚"),
            .init(id: "agenda", title: "周五例会议程", ext: "pdf", date: store.sampleDate(day: -1, hour: 11, minute: 17),
                  summary: "本周进展\n下周安排\n待讨论事项")
        ]
    }
}

struct NoteGalleryView: View {
    let notes: [Note]
    let files: [NoteFile]
    let botId: String
    let api: Api
    let bottomInset: CGFloat
    let onOpenNote: (UUID) -> Void
    let newNote: () -> Void
    let onDropFile: (String) -> Void
    @State private var query = ""
    @State private var previewFile: NoteFile?
    @Environment(\.topInset) private var topInset
    @Environment(\.openArtifact) private var openArtifact

    private static let locale = Locale(identifier: "zh_CN")
    private var entries: [NoteGalleryEntry] {
        let all = notes.map(NoteGalleryEntry.note) + files.map(NoteGalleryEntry.file)
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return all
            .filter { term.isEmpty || "\($0.title) \($0.text)".localizedCaseInsensitiveContains(term) }
            .sorted { $0.date > $1.date }
    }

    var body: some View {
        let groups = Dictionary(grouping: entries) { Calendar.current.startOfDay(for: $0.date) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 19) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("全部 Note").font(.largeTitle.bold())
                    Text("\(entries.count) 项").font(.footnote).foregroundStyle(.secondary)
                }
                if entries.isEmpty {
                    Text("没有找到相关内容").foregroundStyle(.secondary)
                }
                ForEach(groups.keys.sorted(by: >), id: \.self) { day in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Self.dayTitle(day)).font(.headline)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3),
                                  alignment: .leading, spacing: 14) {
                            ForEach(groups[day] ?? []) { entry in
                                entryButton(entry)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 740)
            .padding(.horizontal, 18)
            .padding(.top, 7)
        }
        .contentMargins(.top, topInset, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 9) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索", text: $query).accessibilityLabel("搜索 Note")
                }
                .padding(.horizontal, 13)
                .frame(height: 43)
                .glassEffect(.regular)
                roundButton("新建笔记", icon: "square.and.pencil", action: newNote)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 7)
            .padding(.bottom, bottomInset)
        }
        .sheet(item: $previewFile) { NoteMockFileSheet(file: $0, botId: botId, api: api) }
    }

    private func galleryCard(_ entry: NoteGalleryEntry) -> some View {
        let time = entry.date.formatted(.dateTime.hour().minute().locale(Self.locale))
        return VStack(alignment: .center, spacing: 4) {
            Group {
                switch entry {
                case .note(let note):
                    VStack(alignment: .leading, spacing: 3) {
                        Text(note.displayTitle).font(.system(size: 8, weight: .semibold)).lineLimit(1)
                        Text(note.body).font(.system(size: 7)).lineLimit(3)
                        if let first = note.checks.first {
                            Label(first.text, systemImage: first.done ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 7)).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(7)
                case .file(let file):
                    NoteFilePreview(file: file, botId: botId, api: api, compact: true)
                }
            }
            .frame(height: 73)
            .frame(maxWidth: .infinity)
            .background(.background)
            .clipShape(.rect(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.primary.opacity(0.10)))
            .shadow(color: .black.opacity(0.06), radius: 2, y: 2)
            .accessibilityHidden(true)
            Text(time)
                .font(.caption2).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(entry.title))
        .accessibilityValue(Text(time))
    }


    @ViewBuilder
    private func entryButton(_ entry: NoteGalleryEntry) -> some View {
        switch entry {
        case .note(let note):
            Button { onOpenNote(note.id) } label: { galleryCard(entry) }
                .buttonStyle(.plain)
        case .file(let file):
            let source = "note-gallery-\(file.id)"
            Button {
                if let ref = file.asset?.ref, let address = ArtifactAddress(ref) {
                    openArtifact(address, source)
                } else if file.asset == nil {
                    previewFile = file
                }
            } label: { galleryCard(entry) }
                .buttonStyle(.plain)
                .artifactSource(source, radius: 8)
                .artifactDownloadFeedback(source)
                .contextMenu {
                    if let asset = file.asset {
                        Button("拷贝引用", systemImage: "link") { UIPasteboard.general.string = asset.ref }
                        Button("从 Note 移除", systemImage: "minus.circle", role: .destructive) { onDropFile(asset.origin) }
                    }
                }
        }
    }

    private static func dayTitle(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "今天" }
        if calendar.isDateInYesterday(date) { return "昨天" }
        return date.formatted(.dateTime.year().month().day().locale(locale))
    }
}

struct NoteDetailView: View {
    @Binding var note: Note
    let files: [NoteFile]
    let botId: String
    let api: Api
    let onDiscuss: (UUID) -> Void
    let onSource: (String) -> Void
    let newNote: () -> Void
    @State private var showsFiles = false
    @State private var previewFile: NoteFile?
    @Environment(\.openArtifact) private var openArtifact

    private static let locale = Locale(identifier: "zh_CN")
    var body: some View {
        let value = note
        ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                Text(value.date.formatted(.dateTime.month().day().hour().minute().locale(Self.locale)))
                    .font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                TextField("新笔记", text: $note.title, axis: .vertical)
                    .font(.largeTitle.bold())
                    .accessibilityLabel("笔记标题")
                TextField("开始记录…", text: $note.body, axis: .vertical)
                    .lineSpacing(4)
                    .accessibilityLabel("笔记正文")
                ForEach($note.checks) { item in
                    HStack(spacing: 8) {
                        Button {
                            item.wrappedValue.done.toggle()
                        } label: {
                            Image(systemName: item.wrappedValue.done ? "checkmark.circle.fill" : "circle")
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .accessibilityLabel(item.wrappedValue.done ? "取消勾选" : "勾选")
                        TextField("清单项", text: item.text)
                    }
                }
                ForEach(files.filter { value.fileIDs.contains($0.id) }) { file in
                    Button { open(file) } label: {
                        VStack(spacing: 0) {
                            Label(file.filename, systemImage: "doc")
                                .font(.footnote.weight(.semibold))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                            NoteFilePreview(file: file, botId: botId, api: api, compact: false).frame(height: 116)
                        }
                        .background(.thinMaterial)
                        .clipShape(.rect(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .artifactSource("note-attachment-\(file.id)", radius: 12)
                    .artifactDownloadFeedback("note-attachment-\(file.id)")
                }
                if let source = value.source {
                    Button("查看 Lulu 原对话", systemImage: "bubble") { onSource(source) }
                    .font(.footnote)
                }
            }
            .frame(maxWidth: 660)
            .padding(.horizontal, 22)
            .padding(.top, 15)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.paper.ignoresSafeArea())
        .toolbarVisibility(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("带回对话", systemImage: "bubble.left") { onDiscuss(value.id) }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack(spacing: 10) {
                roundButton("添加清单项", icon: "checklist") {
                    note.checks.append(.init(text: ""))
                }
                roundButton("引用已有文件", icon: "paperclip") { showsFiles = true }
                Spacer()
                roundButton("新建笔记", icon: "square.and.pencil", action: newNote)
            }
            .padding(.horizontal, 17)
            .padding(.vertical, 6)
            .background(Color.paper)
        }
        .sheet(isPresented: $showsFiles) { filePicker }
        .sheet(item: $previewFile) { NoteMockFileSheet(file: $0, botId: botId, api: api) }
    }


    private func open(_ file: NoteFile) {
        if let ref = file.asset?.ref, let address = ArtifactAddress(ref) {
            openArtifact(address, "note-attachment-\(file.id)")
        } else if file.asset == nil {
            previewFile = file
        }
    }

    private var filePicker: some View {
        NavigationStack {
            List(files) { file in
                Button {
                    if !note.fileIDs.contains(file.id) { note.fileIDs.append(file.id) }
                    showsFiles = false
                } label: { Label(file.filename, systemImage: "doc") }
                    .disabled(note.fileIDs.contains(file.id))
            }
            .navigationTitle("从画廊选择文件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { showsFiles = false } }
            }
        }
    }
}

private func roundButton(_ label: String, icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
        Image(systemName: icon).font(.body.weight(.medium)).frame(width: 43, height: 43)
    }
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
    .accessibilityLabel(label)
}

private struct NoteMockFileSheet: View {
    let file: NoteFile
    let botId: String
    let api: Api
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                NoteFilePreview(file: file, botId: botId, api: api, compact: false)
                    .frame(height: 230)
                    .clipShape(.rect(cornerRadius: 14))
                    .padding(18)
            }
            .navigationTitle(file.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

private struct NoteFilePreview: View {
    let file: NoteFile
    let botId: String
    let api: Api
    let compact: Bool

    var body: some View {
        Group {
            if let asset = file.asset {
                AssetPage(address: ArtifactAddress(asset.ref), botId: botId, api: api, scale: compact ? 0.36 : 0.8)
            } else if file.id == "mock:map" {
                ZStack(alignment: .topLeading) {
                    Color.teal.opacity(0.12)
                    GeometryReader { proxy in
                        let w = proxy.size.width
                        let h = proxy.size.height
                        Path { river in
                            river.move(to: CGPoint(x: w * 0.13, y: h * 0.86))
                            river.addQuadCurve(to: CGPoint(x: w * 0.53, y: h * 0.48), control: CGPoint(x: w * 0.39, y: h * 0.88))
                            river.addQuadCurve(to: CGPoint(x: w * 0.88, y: h * 0.17), control: CGPoint(x: w * 0.68, y: h * 0.59))
                        }
                        .stroke(.cyan.opacity(0.30), lineWidth: compact ? 7 : 14)
                        Path { walk in
                            walk.move(to: CGPoint(x: w * 0.25, y: h * 0.76))
                            walk.addLines([CGPoint(x: w * 0.43, y: h * 0.63), CGPoint(x: w * 0.59, y: h * 0.57), CGPoint(x: w * 0.77, y: h * 0.29)])
                        }
                        .stroke(.teal, style: StrokeStyle(lineWidth: compact ? 1.5 : 3, dash: [4, 3]))
                    }
                    Text(compact ? file.title : "平江路")
                        .font(.system(size: compact ? 7 : 12, weight: .medium))
                        .padding(compact ? 7 : 14)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    Text(file.title).font(compact ? .system(size: 8, weight: .semibold) : .headline)
                    Text(file.summary ?? "").font(compact ? .system(size: 7) : .subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(compact ? 7 : 16)
                .background(.background)
            }
        }
    }

}

private enum NoteGalleryEntry: Identifiable {
    case note(Note)
    case file(NoteFile)

    var id: String {
        switch self {
        case .note(let note): note.id.uuidString
        case .file(let file): file.id
        }
    }

    var title: String {
        switch self {
        case .note(let note): note.displayTitle
        case .file(let file): file.title
        }
    }

    var date: Date {
        switch self {
        case .note(let note): note.date
        case .file(let file): file.date
        }
    }

    var text: String {
        switch self {
        case .note(let note): note.body
        case .file(let file): file.summary ?? ""
        }
    }
}
