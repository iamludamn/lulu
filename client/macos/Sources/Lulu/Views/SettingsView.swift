import PiStackKit
import SwiftUI

private enum Route: Hashable {
    case memory, file(String), schedules, model, subtasks, mcp, appearance, wallpaper, server
}

struct SettingsView: View {
    let store: BotStore
    let bot: BotSummary
    let api: Api
    let onClose: () -> Void
    @Environment(AppModel.self) private var model
    @AppStorage("pistack.wallpaper") private var wallpaper = WallpaperTheme.sky
    @AppStorage("lulu.appearance") private var appearance = Appearance.system
    @State private var path: [Route] = []
    @State private var forward = true

    static let column: CGFloat = 548

    private var snapshot: BotStore.Snapshot { store.snapshot }

    var body: some View {
        ZStack(alignment: .top) {
            Rectangle().fill(.ultraThinMaterial).overlay { Color.black.opacity(0.18) }.ignoresSafeArea()
            ScrollView {
                page(path.last)
                    .id(path.last)
                    .transition(.asymmetric(insertion: .offset(x: forward ? 40 : -40).combined(with: .opacity), removal: .opacity))
                    .frame(width: Self.column, alignment: .leading)
                    .padding(.top, 132)
                    .padding(.bottom, 60)
                    .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.never)
            HStack {
                Spacer()
                CircleButton(symbol: "xmark", help: "关闭设置", action: onClose).keyboardShortcut(.cancelAction)
            }
            .padding(.top, 14)
            .padding(.horizontal, 16)
        }
        .foregroundStyle(Color.ink)
        .ignoresSafeArea()
    }

    private func push(_ route: Route) {
        forward = true
        withAnimation(.snappy(duration: 0.3)) { path.append(route) }
    }

    private func back() {
        forward = false
        withAnimation(.snappy(duration: 0.3)) { _ = path.popLast() }
    }

    @ViewBuilder
    private func page(_ route: Route?) -> some View {
        switch route {
        case nil: root
        case .memory: MemoryPage(botId: bot.id, api: api, header: header("记忆"), onOpen: { push(.file($0)) })
        case .file(let name): MemoryFilePage(botId: bot.id, api: api, path: name, header: header((name as NSString).deletingPathExtension))
        case .schedules: SchedulePage(botId: bot.id, api: api, header: header("定时任务"))
        case .model: modelPage
        case .subtasks: subtaskPage
        case .mcp: mcpPage
        case .appearance: appearancePage
        case .wallpaper: wallpaperPage
        case .server: ServerPage(header: header("服务器"))
        }
    }

    private func header(_ title: String) -> some View {
        HStack(spacing: 24) {
            CircleButton(symbol: "chevron.left", help: "返回", action: back)
            Text(title).type(32, .medium, line: 40).tracking(-0.3).lineLimit(1)
        }
        .padding(.bottom, 26)
    }

    private var root: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Avatar(size: 48)
                VStack(alignment: .leading, spacing: 0) {
                    Text(bot.name).type(30, .medium, line: 34).tracking(-0.4)
                    Text(api.base.host() ?? api.base.absoluteString).type(14, line: 18).foregroundStyle(Color.muted)
                }
            }
            .padding(.bottom, 14)
            RowGroup(items: [
                Row(symbol: "brain", title: "记忆") { push(.memory) },
                Row(symbol: "clock", title: "定时任务") { push(.schedules) },
            ])
            RowGroup(items: [
                Row(symbol: "cpu", title: "模型", value: snapshot.models?.model?.id ?? "未选择") { push(.model) },
                Row(symbol: "arrow.triangle.branch", title: "子任务", value: subtaskValue) { push(.subtasks) },
                Row(symbol: "point.3.connected.trianglepath.dotted", title: "MCP", value: snapshot.mcp.isEmpty ? "未配置" : "\(snapshot.mcp.count) 个") { push(.mcp) },
            ])
            RowGroup(items: [
                Row(symbol: "circle.lefthalf.filled", title: "外观", value: appearance.title) { push(.appearance) },
                Row(symbol: "paintpalette", title: "背景", value: wallpaper.title) { push(.wallpaper) },
                Row(symbol: "server.rack", title: "服务器", value: api.base.host() ?? "") { push(.server) },
            ])
        }
    }

    private var subtaskValue: String {
        let running = subtasks(of: snapshot.progress).filter(\.running).count
        return running > 0 ? "\(running) 个进行中" : "无进行中"
    }

    private var modelPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            header("模型")
            if let config = snapshot.models {
                if config.models.isEmpty {
                    Note("没有可用模型，请检查服务端的 API key 配置。")
                } else {
                    RowGroup(items: config.models.map { option in
                        Row(symbol: config.model == option ? "checkmark.circle.fill" : "circle", title: option.id, value: option.provider, chevron: false) {
                            if !config.overridden, config.model != option { store.selectModel(option) }
                        }
                    })
                    .disabled(config.overridden)
                    .opacity(config.overridden ? 0.6 : 1)
                }
                if config.overridden { Note("模型已由服务端环境变量固定，无法在这里切换。") }
            } else {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var subtaskPage: some View {
        let tasks = subtasks(of: snapshot.progress).sorted { $0.running && !$1.running }
        return VStack(alignment: .leading, spacing: 12) {
            header("子任务")
            if tasks.isEmpty {
                Note("还没有子任务。")
            } else {
                RowGroup(items: tasks.map { task in
                    Row(symbol: task.running ? "arrow.triangle.2.circlepath" : "checkmark.circle", title: task.description, value: task.running ? "进行中" : "已完成", chevron: false, spinning: task.running)
                })
            }
        }
    }

    private var mcpPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            header("MCP")
            if snapshot.mcp.isEmpty {
                Note("未配置 MCP 服务器。")
            } else {
                Card {
                    ForEach(Array(snapshot.mcp.enumerated()), id: \.element.id) { index, server in
                        if index > 0 { Separator() }
                        mcpRow(server)
                    }
                }
            }
        }
    }

    private func mcpRow(_ server: McpStatus) -> some View {
        let label = switch server.state {
        case .connected: "已连接"
        case .failed: "连接失败"
        case .needsAuth: "需要授权"
        }
        let ok = server.state == .connected
        return HStack(alignment: .top, spacing: 14) {
            Circle().fill(ok ? Color.success : Color.warning).frame(width: 8, height: 8).padding(.top, 6).frame(width: 20)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(server.name).type(15, .semibold, line: 19)
                    Text(server.source == .bot ? "自定义" : "平台").type(11, .medium, line: 14).padding(.horizontal, 7).padding(.vertical, 2).background(Color.veil, in: .capsule)
                }
                Text("\(label) · \(server.tools) 个工具 · 检查于 \(Date(timeIntervalSince1970: server.checkedAt / 1000).formatted(date: .omitted, time: .shortened))")
                    .type(13, line: 18)
                    .foregroundStyle(ok ? Color.muted : Color.warning)
                if let error = server.error { Text(error).type(13, line: 18).foregroundStyle(Color.muted) }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 18)
    }

    private var appearancePage: some View {
        VStack(alignment: .leading, spacing: 12) {
            header("外观")
            RowGroup(items: Appearance.allCases.map { option in
                Row(symbol: appearance == option ? "checkmark.circle.fill" : "circle", title: option.title, chevron: false) { appearance = option }
            })
            Note("「自动」跟随系统的浅色和深色外观。")
        }
    }

    private var wallpaperPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            header("背景")
            Card {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 18) {
                    ForEach(WallpaperTheme.allCases) { theme in
                        let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
                        Button { withAnimation(.snappy) { wallpaper = theme } } label: {
                            VStack(spacing: 8) {
                                WallpaperMesh(theme: theme)
                                    .frame(height: 104)
                                    .clipShape(shape)
                                    .overlay { shape.strokeBorder(wallpaper == theme ? Color.ink : Color.line, lineWidth: wallpaper == theme ? 2 : 0.5) }
                                Text(theme.title).type(13, .medium, line: 18).foregroundStyle(wallpaper == theme ? Color.ink : Color.muted)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 20)
            }
            Note("每套背景都有浅色和深色两种，跟随外观切换。")
        }
    }
}

private struct Row: Identifiable {
    let symbol: String
    let title: String
    var value: String?
    var chevron = true
    var spinning = false
    var action: (() -> Void)?

    var id: String { title + symbol }

    init(symbol: String, title: String, value: String? = nil, chevron: Bool = true, spinning: Bool = false, action: (() -> Void)? = nil) {
        self.symbol = symbol
        self.title = title
        self.value = value
        self.chevron = chevron && action != nil
        self.spinning = spinning
        self.action = action
    }
}

private struct RowView: View {
    let row: Row
    @State private var hovering = false

    var body: some View {
        let line = HStack(spacing: 12) {
            Image(systemName: row.symbol)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(row.symbol == "checkmark.circle.fill" ? Color.info : Color.ink)
                .symbolEffect(.rotate, isActive: row.spinning)
                .frame(width: 22)
            Text(row.title).type(15, .semibold, line: 19).lineLimit(1)
            Spacer(minLength: 12)
            if let value = row.value {
                Text(value).type(15, line: 19).foregroundStyle(Color.muted).lineLimit(1)
            }
            if row.chevron {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).padding(.leading, 4)
            }
        }
        .frame(height: 57)
        .contentShape(.rect)
        if let action = row.action {
            Button(action: action) { line }
                .buttonStyle(.plain)
                .background { Color.veil.opacity(hovering ? 1 : 0).padding(.horizontal, -20) }
                .onHover { hovering = $0 }
        } else {
            line
        }
    }
}

private struct RowGroup: View {
    let items: [Row]

    var body: some View {
        Card {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 { Separator() }
                RowView(row: item)
            }
        }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .padding(.horizontal, 20)
            .clipShape(.rect(cornerRadius: 28, style: .continuous))
            .pane(28)
    }
}

struct Separator: View {
    var body: some View { Rectangle().fill(Color.line.opacity(0.7)).frame(height: 1) }
}

struct Note: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text).type(13, line: 18).foregroundStyle(Color.muted).padding(.horizontal, 2)
    }
}

private struct MemoryPage<Header: View>: View {
    let botId: String
    let api: Api
    let header: Header
    let onOpen: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Loaded(load: { try await api.memory(botId) }) { listing in
                VStack(alignment: .leading, spacing: 12) {
                    if listing.files.isEmpty {
                        Note("还没有记忆。")
                    } else {
                        RowGroup(items: listing.files.map { file in
                            Row(symbol: "doc.text", title: (file as NSString).deletingPathExtension) { onOpen(file) }
                        })
                    }
                    Note("对话中值得记住的内容，会被定期整理到这些文件。")
                    if !listing.commits.isEmpty {
                        Text("最近整理").type(13, .semibold, line: 18).foregroundStyle(Color.muted).padding(.top, 18).padding(.horizontal, 2)
                        Card {
                            ForEach(Array(listing.commits.enumerated()), id: \.element.id) { index, commit in
                                if index > 0 { Separator() }
                                HStack {
                                    Text(commit.message.split(separator: "\n").first.map(String.init) ?? "").type(15, .medium, line: 19).lineLimit(1)
                                    Spacer()
                                    Text(Date(timeIntervalSince1970: commit.at / 1000).formatted(.relative(presentation: .named))).type(13, line: 18).foregroundStyle(Color.muted)
                                }
                                .frame(height: 57)
                            }
                        }
                    }
                }
            }
        }
    }
}

private struct MemoryFilePage<Header: View>: View {
    let botId: String
    let api: Api
    let path: String
    let header: Header

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Loaded(load: { try await api.memoryFile(botId, path: path) }) { text in
                MarkdownText(text: text, size: 15, line: 24, selectable: true, document: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(28)
                    .pane(28)
            }
        }
    }
}

private struct SchedulePage<Header: View>: View {
    let botId: String
    let api: Api
    let header: Header

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Loaded(load: { try await api.schedules(botId) }) { entries in
                VStack(alignment: .leading, spacing: 12) {
                    if entries.isEmpty {
                        Note("还没有定时任务。")
                    } else {
                        Card {
                            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                                if index > 0 { Separator() }
                                row(entry)
                            }
                        }
                    }
                    Note("在对话里让 bot 定时做事，任务会出现在这里。")
                }
            }
        }
    }

    private func row(_ entry: ScheduleEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: entry.state == .active ? "clock" : "clock.badge.xmark").font(.system(size: 16)).frame(width: 22).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.name).type(15, .semibold, line: 19)
                Text(scheduleText(entry.schedule)).type(13, line: 18).foregroundStyle(Color.muted)
                if let next = entry.nextRunAt, entry.state == .active {
                    Text("下次 \(time(next))").type(12, line: 16).foregroundStyle(Color.muted)
                }
                if let last = entry.lastRun {
                    Text("上次 \(time(last.scheduledFor)) \(runLabel(last.status))")
                        .type(12, line: 16)
                        .foregroundStyle(last.status == .failed ? Color.warning : Color.muted)
                }
            }
            Spacer()
            Text(stateLabel(entry.state))
                .type(12, .semibold, line: 16)
                .foregroundStyle(entry.state == .active ? Color.success : Color.muted)
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(Color.veil, in: .capsule)
        }
        .padding(.vertical, 18)
    }

    private func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private func scheduleText(_ schedule: Schedule) -> String {
        switch schedule {
        case .once(let at): "一次 · \(time(at))"
        case .daily(let time, let tz): "每天 \(time)（\(tz)）"
        }
    }

    private func stateLabel(_ state: ScheduleEntry.State) -> String {
        switch state {
        case .active: "运行中"
        case .paused: "已暂停"
        case .done: "已完成"
        case .missed: "已错过"
        }
    }

    private func runLabel(_ status: ScheduleEntry.Run.Status) -> String {
        switch status {
        case .running: "执行中"
        case .done: "成功"
        case .failed: "失败"
        case .closed: "已关闭"
        }
    }
}

struct ServerPage<Header: View>: View {
    let header: Header
    @Environment(AppModel.self) private var model
    @State private var text = ""

    private var valid: Bool { Api.normalize(text) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Card {
                HStack(spacing: 12) {
                    Image(systemName: "link").font(.system(size: 16)).frame(width: 22)
                    TextField(AppModel.defaultServer, text: $text)
                        .textFieldStyle(.plain)
                        .font(.ui(15))
                        .autocorrectionDisabled()
                        .onSubmit(save)
                    Button("连接", action: save)
                        .buttonStyle(.plain)
                        .type(13, .semibold, line: 18)
                        .foregroundStyle(Color.knobInk)
                        .padding(.horizontal, 16)
                        .frame(height: 32)
                        .background(Color.knob.opacity(valid ? 1 : 0.4), in: .capsule)
                        .disabled(!valid || text == model.server)
                }
                .frame(height: 57)
            }
            Note("lulu 服务的地址，对话通过它的 WebSocket 连接。地址即凭证，保存在系统钥匙串里。")
        }
        .onAppear { text = model.server }
    }

    private func save() {
        guard valid else { return }
        model.server = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
