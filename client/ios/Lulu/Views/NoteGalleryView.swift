import LuluKit
import SwiftUI

struct NoteFile: Identifiable {
    let id: String
    let title: String
    let filename: String
    let date: Date
    let summary: String?
    var asset: AssetItem?
    var address: ArtifactAddress? { ArtifactAddress(id) }

    init(asset: AssetItem) {
        id = asset.ref
        title = asset.title
        filename = asset.title
        date = Date(timeIntervalSince1970: asset.savedAt / 1000)
        summary = asset.summary
        self.asset = asset
    }

    init?(reference: String) {
        guard let address = ArtifactAddress(reference) else { return nil }
        id = reference
        title = URL(fileURLWithPath: address.name).lastPathComponent
        filename = title
        date = .distantPast
        summary = nil
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
            .init(id: "coffee", title: "苏州咖啡店清单", ext: "html", date: store.sampleDate(day: -3, hour: 16, minute: 22),
                  summary: "十全街｜有露台\n平江路｜适合歇脚"),
            .init(id: "agenda", title: "周五例会议程", ext: "pdf", date: store.sampleDate(day: -70, hour: 11, minute: 17),
                  summary: "本周进展\n下周安排\n待讨论事项")
        ]
    }
}

struct NoteGalleryView: View {
    let notes: [Note]
    let files: [NoteFile]
    let pinnedIDs: Set<String>
    let noteZoom: Namespace.ID
    let botId: String
    let api: Api
    var syncError: String? = nil
    var onRetry: () -> Void = {}
    let onTogglePin: (String) -> Void
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
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        let matches = entries
        let pinned = matches.filter { pinnedIDs.contains($0.id) }
        let unpinned = matches.filter { !pinnedIDs.contains($0.id) }
        var groups = Dictionary(grouping: unpinned) { Self.sectionTitle(for: $0.date, today: today, calendar: calendar) }
            .sorted { ($0.value.first?.date ?? .distantPast) > ($1.value.first?.date ?? .distantPast) }
        if !pinned.isEmpty { groups.insert((key: "置顶", value: pinned), at: 0) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 19) {
                HomePageHeading(title: "片刻思绪", subtitle: "笔记与文件")
                if groups.isEmpty {
                    Text("没有找到相关内容").foregroundStyle(.secondary)
                }
                if let syncError {
                    Button(action: onRetry) {
                        Label(syncError + "，轻点重试", systemImage: "arrow.clockwise")
                            .font(.footnote)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.key) { group in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(group.key).font(.title3.bold())
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3),
                                  alignment: .leading, spacing: 14) {
                            ForEach(group.value) { entry in
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
            HStack(alignment: .center, spacing: 9) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索", text: $query).accessibilityLabel("搜索笔记")
                }
                .padding(.horizontal, 13)
                .frame(height: noteToolbarButtonSize)
                .glassEffect(.regular, in: .capsule)
                Button(action: newNote) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 21, weight: .medium))
                        .foregroundStyle(.secondary)
                        .offset(x: -1, y: -1)
                        .frame(width: noteToolbarButtonSize, height: noteToolbarButtonSize)
                        .contentShape(.circle)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("新建笔记")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 7)
        }
        .sheet(item: $previewFile) { NoteMockFileSheet(file: $0, botId: botId, api: api) }
    }

    private func galleryCard(_ entry: NoteGalleryEntry) -> some View {
        let time = Self.cardDate(entry.date)
        let isPinned = pinnedIDs.contains(entry.id)
        let thumbnail = Group {
            switch entry {
            case .note(let note):
                NoteThumbnail(note: note)
            case .file(let file):
                NoteFilePreview(file: file, botId: botId, api: api, compact: true)
            }
        }
        .frame(height: 73)
        .frame(maxWidth: .infinity)
        .noteThumbnailSurface()
        .overlay(alignment: .topTrailing) {
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 19, height: 19)
                    .background(.regularMaterial, in: .rect(cornerRadius: 4))
                    .padding(4)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityHidden(true)
        return VStack(alignment: .center, spacing: 4) {
            if case .note(let note) = entry {
                thumbnail.matchedTransitionSource(id: note.id, in: noteZoom) {
                    $0.clipShape(.rect(cornerRadius: 7))
                }
            } else {
                thumbnail
            }
            Text(time)
                .font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(entry.title))
        .accessibilityValue(Text(isPinned ? "已置顶，\(time)" : time))
    }


    @ViewBuilder
    private func entryButton(_ entry: NoteGalleryEntry) -> some View {
        switch entry {
        case .note(let note):
            Button { onOpenNote(note.id) } label: { galleryCard(entry) }
                .buttonStyle(.plain)
                .contextMenu { pinButton(entry) }
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
                    pinButton(entry)
                    if let asset = file.asset {
                        Button("拷贝引用", systemImage: "link") { UIPasteboard.general.string = asset.ref }
                        Button("从笔记移除", systemImage: "minus.circle", role: .destructive) { onDropFile(asset.origin) }
                    }
                }
        }
    }

    private func pinButton(_ entry: NoteGalleryEntry) -> some View {
        let isPinned = pinnedIDs.contains(entry.id)
        return Button(isPinned ? "取消置顶" : "置顶", systemImage: isPinned ? "pin.slash" : "pin") {
            onTogglePin(entry.id)
        }
    }

    private static func sectionTitle(for date: Date, today: Date, calendar: Calendar) -> String {
        let day = calendar.startOfDay(for: date)
        switch calendar.dateComponents([.day], from: day, to: today).day ?? Int.max {
        case 0: return "今天"
        case 1: return "昨天"
        case 2...7: return "过去 7 天"
        case 8...30: return "过去 30 天"
        default:
            if calendar.isDate(date, equalTo: today, toGranularity: .year) {
                return date.formatted(.dateTime.month(.wide).locale(locale))
            }
            return date.formatted(.dateTime.year().locale(locale))
        }
    }

    private static func cardDate(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) || calendar.isDateInYesterday(date) {
            return date.formatted(.dateTime.hour().minute().locale(locale))
        }
        if calendar.isDate(date, equalTo: .now, toGranularity: .year) {
            return date.formatted(.dateTime.month().day().locale(locale))
        }
        return date.formatted(.dateTime.year().month().day().locale(locale))
    }
}

struct NoteThumbnail: View {
    let note: Note
    var inComposer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(note.displayTitle)
                .font(.system(size: inComposer ? 10 : 8, weight: .semibold))
                .lineLimit(1)
                .padding(.trailing, inComposer ? 19 : 0)
            Text(note.body)
                .font(.system(size: inComposer ? 8 : 6))
                .lineLimit(inComposer ? 2 : 3)
            if let first = note.checks.first {
                Label(first.text, systemImage: first.done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: inComposer ? 8 : 6))
                    .lineLimit(1)
            }
        }
        .padding(7)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

extension View {
    func noteThumbnailSurface() -> some View {
        background(.background)
            .clipShape(.rect(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.primary.opacity(0.10)))
            .shadow(color: .black.opacity(0.06), radius: 2, y: 2)
    }
}

struct NoteDetailView: View {
    @Binding var note: Note
    let files: [NoteFile]
    let botId: String
    let api: Api
    let store: BotStore
    let noteStore: NoteStore
    let onSource: (String) -> Void
    @FocusState private var titleFocused: Bool
    @FocusState private var focusedBlock: UUID?
    @FocusState private var messageFocused: Bool
    @State private var message = ""
    @State private var questionExpanded = false
    @State private var questionOpening = false
    @State private var transcription = VoiceTranscription()
    @State private var voiceTarget: VoiceTarget?
    @State private var sendTask: Task<Void, Never>?
    @State private var failure: Failure?
    @State private var restored = false
    @State private var contentBottom: CGFloat = 0
    @State private var selections: [UUID: TextSelection] = [:]
    @State private var fileInsertion: InsertionPoint?
    @State private var showsFiles = false
    @State private var previewFile: NoteFile?
    @Environment(\.openArtifact) private var openArtifact
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private struct Failure {
        let title: String
        let message: String
    }

    private enum VoiceTarget {
        case question
        case body(DictationPoint)
    }

    private struct DictationPoint {
        let block: UUID?
        let text: String
        let offsets: Range<Int>?
    }

    private var editingNote: Bool { titleFocused || focusedBlock != nil }
    private var sending: Bool { sendTask != nil }
    private var dockAnimation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.27) }
    private var composerMode: NoteComposer.Mode {
        if titleFocused { return .editingTitle }
        if focusedBlock != nil { return .editingBody }
        return questionExpanded ? .question : .reading
    }

    private var voiceStatus: String? {
        guard let voiceTarget else { return nil }
        let status = transcription.processing ? "正在转写" : transcription.recording ? "正在录音" : "正在准备"
        switch voiceTarget {
        case .question: return "语音问 lulu · \(status)"
        case .body: return "语音记笔记 · \(status)"
        }
    }

    var body: some View {
        let value = note
        let updated = noteStore.updatedBlocks(in: value)
        ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                TextField("新笔记", text: $note.title, axis: .vertical)
                    .font(.largeTitle.bold())
                    .focused($titleFocused)
                    .accessibilityLabel("笔记标题")
                ForEach(value.blocks) { block in
                    editBlock(block)
                        .background {
                            if updated.contains(block.id) {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color.accentColor.opacity(0.09))
                                    .padding(-5)
                            }
                        }
                }
                if value.blocks.last?.isText != true {
                    Button("继续写正文") {
                        let block = Note.Block(content: .text(""))
                        note.blocks.append(block)
                        focusedBlock = block.id
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                }
                if let source = value.source {
                    Button("查看 Lulu 原对话", systemImage: "bubble") { onSource(source) }
                    .font(.footnote)
                }
            }
            .frame(maxWidth: 660)
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { contentBottom = $0 }
        }
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(SpatialTapGesture(coordinateSpace: .global).onEnded { tap in
            guard voiceTarget == nil else { return }
            if questionExpanded {
                collapseQuestion()
            } else if editingNote, tap.location.y > contentBottom {
                titleFocused = false
                focusedBlock = nil
            }
        }, including: editingNote || questionExpanded ? .all : .none)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            detailDock
        }
        .background(Color.paper.ignoresSafeArea())
        .toolbarVisibility(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if noteStore.canUndo(value) {
                    Button("撤回笔记更新", systemImage: "arrow.uturn.backward") {
                        if noteStore.undoUpdate(in: value.id) { restored = true }
                    }
                }
            }
        }
        .alert(failure?.title ?? "笔记", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("好", role: .cancel) { failure = nil }
        } message: {
            Text(failure?.message ?? "")
        }
        .onChange(of: editingNote) { _, editing in
            if editing {
                if case .question? = voiceTarget { cancelVoice() }
                collapseQuestion()
            }
        }
        .onChange(of: messageFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused && voiceTarget == nil { collapseQuestion() }
        }
        .onChange(of: transcription.error) { _, error in
            guard let error else { return }
            voiceTarget = nil
            failure = Failure(title: "语音转写失败", message: error)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { cancelVoice() }
        }
        .onDisappear {
            sendTask?.cancel()
            cancelVoice()
        }
        .task(id: restored) {
            guard restored else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            restored = false
        }
        .sheet(isPresented: $showsFiles) { filePicker }
        .sheet(item: $previewFile) { NoteMockFileSheet(file: $0, botId: botId, api: api) }
    }

    private var detailDock: some View {
        VStack(spacing: 8) {
            if !editingNote, voiceTarget == nil { replyCard }
            NoteComposer(draft: $message, focused: $messageFocused, mode: composerMode,
                         opening: questionOpening, sending: sending, transcription: transcription, voiceStatus: voiceStatus,
                         onOpen: openQuestion, onSend: send, onMicrophone: toggleVoice, onCancelVoice: cancelVoice,
                         onAddChecklist: addChecklist, onChooseFile: chooseFile)
        }
        .frame(maxWidth: 720)
        .padding(.bottom, 4)
        .modifier(ComposerKeyboardAvoidance(focused: editingNote || messageFocused))
    }

    @ViewBuilder
    private var replyCard: some View {
        if sending {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("lulu 正在回复…")
            }
            .font(.footnote)
            .modifier(NoteReplySurface())
        } else if restored {
            Label("已恢复到更新前的笔记", systemImage: "checkmark")
                .font(.footnote)
                .modifier(NoteReplySurface())
        } else if let reply = noteStore.reply(in: note.id) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 9) {
                    Text("lulu").foregroundStyle(.secondary)
                    if reply.updated {
                        Label("已更新笔记", systemImage: "checkmark").foregroundStyle(.tint)
                    }
                    Spacer()
                    Button {
                        noteStore.dismissReply(in: note.id)
                    } label: {
                        Image(systemName: "xmark").padding(6).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("关闭笔记回复")
                }
                .font(.caption.weight(.medium))
                Text(reply.text).font(.subheadline)
            }
            .modifier(NoteReplySurface())
        }
    }

    private func openQuestion() {
        guard !questionExpanded, voiceTarget == nil, !sending else { return }
        questionOpening = true
        withAnimation(dockAnimation, completionCriteria: .logicallyComplete) {
            questionExpanded = true
        } completion: {
            questionOpening = false
            if questionExpanded, !editingNote { messageFocused = true }
        }
    }

    private func collapseQuestion() {
        messageFocused = false
        if questionExpanded { withAnimation(dockAnimation) { questionExpanded = false } }
    }

    private func send() {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, sendTask == nil, voiceTarget == nil else { return }
        let id = note.id
        collapseQuestion()
        restored = false
        sendTask = Task {
            defer { sendTask = nil }
            do {
                try await noteStore.ask(text, in: id)
                message = ""
            } catch {
                guard !Task.isCancelled else { return }
                if !editingNote, voiceTarget == nil { withAnimation(dockAnimation) { questionExpanded = true } }
                failure = Failure(title: "无法发送", message: error.localizedDescription)
            }
        }
    }

    private func toggleVoice() {
        guard !transcription.starting, !transcription.processing else { return }
        if let target = voiceTarget, transcription.recording {
            transcription.finish { text in
                voiceTarget = nil
                switch target {
                case .question:
                    message += message.isEmpty ? text : "\n" + text
                    if questionExpanded, !editingNote { messageFocused = true }
                case .body(let point):
                    insertDictation(text, at: point)
                }
            }
        } else if voiceTarget == nil {
            let asking = questionExpanded && !editingNote
            voiceTarget = asking ? .question : .body(dictationPoint)
            if asking { messageFocused = false }
            transcription.start(store)
        }
    }

    private func cancelVoice() {
        transcription.cancel()
        voiceTarget = nil
    }

    private var dictationPoint: DictationPoint {
        let block = note.blocks.first { $0.id == focusedBlock && $0.isText } ?? note.blocks.last
        guard let block, case .text(let text) = block.content else {
            return DictationPoint(block: nil, text: "", offsets: nil)
        }
        let offsets = selectionRange(for: block.id, in: text).map { range in
            text.distance(from: text.startIndex, to: range.lowerBound)..<text.distance(from: text.startIndex, to: range.upperBound)
        }
        return DictationPoint(block: block.id, text: text, offsets: offsets)
    }

    private func insertDictation(_ text: String, at point: DictationPoint) {
        guard let id = point.block, let index = note.blocks.firstIndex(where: { $0.id == id }),
              case .text(var current) = note.blocks[index].content else {
            note.blocks.append(.init(content: .text(text)))
            return
        }
        if current == point.text, let offsets = point.offsets {
            let start = current.index(current.startIndex, offsetBy: offsets.lowerBound)
            let end = current.index(current.startIndex, offsetBy: offsets.upperBound)
            let caretOffset = (String(current[..<start]) + text).count
            current.replaceSubrange(start..<end, with: text)
            note.blocks[index].content = .text(current)
            if focusedBlock == id {
                selections[id] = TextSelection(insertionPoint: current.index(current.startIndex, offsetBy: min(caretOffset, current.count)))
            }
        } else {
            note.blocks[index].content = .text(current.isEmpty ? text : current + "\n" + text)
        }
    }

    private struct InsertionPoint {
        let block: UUID?
        let offset: Int?
    }

    private func addChecklist() {
        let block = Note.Block(content: .check(.init()))
        let point = insertionPoint
        note.insert(block, after: point.block, splittingAt: point.offset)
        focusedBlock = block.id
    }

    private func chooseFile() {
        fileInsertion = insertionPoint
        showsFiles = true
    }

    private var insertionPoint: InsertionPoint {
        let block = focusedBlock ?? note.blocks.last?.id
        guard let focusedBlock,
              case .text(let text) = note.blocks.first(where: { $0.id == focusedBlock })?.content,
              let range = selectionRange(for: focusedBlock, in: text) else {
            return InsertionPoint(block: block, offset: nil)
        }
        return InsertionPoint(block: block, offset: text.distance(from: text.startIndex, to: range.upperBound))
    }

    private func selectionRange(for block: UUID, in text: String) -> Range<String.Index>? {
        guard let selection = selections[block], case .selection(let range) = selection.indices,
              range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex else { return nil }
        return range
    }

    @ViewBuilder
    private func editBlock(_ block: Note.Block) -> some View {
        switch block.content {
        case .text:
            TextField("开始记录…", text: textBinding(for: block.id), selection: selectionBinding(for: block.id), axis: .vertical)
                .lineSpacing(4)
                .focused($focusedBlock, equals: block.id)
                .accessibilityLabel("笔记正文")
        case .check(let check):
            HStack(spacing: 8) {
                Button {
                    var updated = check
                    updated.done.toggle()
                    updateBlock(block.id, content: .check(updated))
                } label: {
                    Image(systemName: check.done ? "checkmark.circle.fill" : "circle")
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .accessibilityLabel(check.done ? "取消勾选" : "勾选")
                .contextMenu {
                    Button("移除清单项", systemImage: "trash", role: .destructive) { removeBlock(block.id) }
                }
                TextField("清单项", text: textBinding(for: block.id))
                    .focused($focusedBlock, equals: block.id)
                    .onSubmit { continueChecklist(after: block.id) }
                if focusedBlock == block.id {
                    Button("移除清单项", systemImage: "minus.circle") { removeBlock(block.id) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
            }
        case .file(let id):
            if let file = files.first(where: { $0.id == id }) ?? NoteFile(reference: id) {
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
                .contextMenu {
                    Button("移除附件", systemImage: "trash", role: .destructive) { removeBlock(block.id) }
                }
            } else {
                Label("附件不可用", systemImage: "doc")
                    .foregroundStyle(.secondary)
                    .contextMenu {
                        Button("移除附件", systemImage: "trash", role: .destructive) { removeBlock(block.id) }
                    }
            }
        }
    }

    private func textBinding(for id: UUID) -> Binding<String> {
        Binding {
            switch note.blocks.first(where: { $0.id == id })?.content {
            case .text(let text): text
            case .check(let check): check.text
            default: ""
            }
        } set: { text in
            guard let index = note.blocks.firstIndex(where: { $0.id == id }) else { return }
            switch note.blocks[index].content {
            case .text:
                note.blocks[index].content = .text(text)
            case .check(var check):
                check.text = text
                note.blocks[index].content = .check(check)
            case .file:
                break
            }
        }
    }

    private func selectionBinding(for id: UUID) -> Binding<TextSelection?> {
        Binding { selections[id] } set: { selections[id] = $0 }
    }

    private func updateBlock(_ id: UUID, content: Note.Block.Content) {
        if let index = note.blocks.firstIndex(where: { $0.id == id }) {
            note.blocks[index].content = content
        }
    }

    private func removeBlock(_ id: UUID) {
        if focusedBlock == id { focusedBlock = nil }
        selections.removeValue(forKey: id)
        note.blocks.removeAll { $0.id == id }
    }

    private func continueChecklist(after id: UUID) {
        guard let index = note.blocks.firstIndex(where: { $0.id == id }),
              case .check(let check) = note.blocks[index].content else { return }
        if check.text.isEmpty {
            let next = index + 1
            if note.blocks.indices.contains(next), case .text = note.blocks[next].content {
                let nextID = note.blocks[next].id
                note.blocks.remove(at: index)
                focusedBlock = nextID
            } else {
                let paragraph = Note.Block(content: .text(""))
                note.blocks[index] = paragraph
                focusedBlock = paragraph.id
            }
        } else {
            let item = Note.Block(content: .check(.init()))
            note.insert(item, after: id)
            focusedBlock = item.id
        }
    }

    private func open(_ file: NoteFile) {
        if let address = file.address {
            openArtifact(address, "note-attachment-\(file.id)")
        } else if file.asset == nil {
            previewFile = file
        }
    }

    private var filePicker: some View {
        NavigationStack {
            List(files) { file in
                Button {
                    if !note.fileIDs.contains(file.id) {
                        note.insert(.init(content: .file(file.id)), after: fileInsertion?.block, splittingAt: fileInsertion?.offset)
                    }
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

private let noteToolbarButtonSize: CGFloat = 48

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
            if let address = file.address {
                AssetPage(address: address, botId: botId, api: api, scale: compact ? 0.36 : 0.8)
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
                        .font(.system(size: compact ? 8 : 12, weight: compact ? .semibold : .medium))
                        .padding(compact ? 7 : 14)
                }
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    Text(file.title).font(compact ? .system(size: 8, weight: .semibold) : .headline)
                    Text(file.summary ?? "").font(compact ? .system(size: 6) : .subheadline)
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
        case .note(let note): note.id.uuidString.lowercased()
        case .file(let file): file.address.map { "asset:" + $0.name } ?? file.id
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
