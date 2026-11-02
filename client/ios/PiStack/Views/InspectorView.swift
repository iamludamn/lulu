import PiStackKit
import SwiftUI

struct InspectorView: View {
    let store: BotStore
    let botId: String
    let api: Api
    @Environment(\.dismiss) private var dismiss
    @AppStorage("pistack.wallpaper") private var wallpaper = WallpaperTheme.sky

    private var snapshot: BotStore.Snapshot { store.snapshot }

    var body: some View {
        let tasks = subtasks(of: snapshot.progress).sorted { $0.running && !$1.running }
        NavigationStack {
            List {
                Section {
                    NavigationLink { MemoryView(botId: botId, api: api) } label: { Label("记忆", systemImage: "brain") }
                    NavigationLink { ScheduleView(botId: botId, api: api) } label: { Label("定时任务", systemImage: "clock") }
                }
                Section("模型") { model }
                Section("子任务") {
                    if tasks.isEmpty { Text("暂无子任务").foregroundStyle(.secondary) }
                    ForEach(tasks) { task in
                        HStack(spacing: 10) {
                            if task.running { ProgressView().controlSize(.small) } else { Image(systemName: "checkmark.circle").foregroundStyle(.secondary) }
                            Text(task.description)
                        }
                    }
                }
                Section("MCP") {
                    if snapshot.mcp.isEmpty { Text("未配置 MCP 服务器").foregroundStyle(.secondary) }
                    ForEach(snapshot.mcp) { server in mcpRow(server) }
                }
                Section("背景") { wallpaperPicker }
                Section {
                    NavigationLink { SettingsView() } label: { Label("服务器", systemImage: "server.rack") }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var wallpaperPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(WallpaperTheme.allCases) { theme in
                    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
                    Button { wallpaper = theme } label: {
                        VStack(spacing: 6) {
                            WallpaperMesh(theme: theme)
                                .frame(width: 64, height: 88)
                                .clipShape(shape)
                                .overlay { shape.strokeBorder(wallpaper == theme ? Color.accentColor : .clear, lineWidth: 2.5) }
                            Text(theme.title).font(.caption).foregroundStyle(wallpaper == theme ? .primary : .secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 6)
        }
        .sensoryFeedback(.selection, trigger: wallpaper)
    }

    @ViewBuilder
    private var model: some View {
        if let config = snapshot.models {
            Picker("模型", selection: Binding(get: { config.model }, set: { if let next = $0 { store.selectModel(next) } })) {
                if config.model == nil { Text("选择模型").tag(ModelRef?.none) }
                ForEach(config.models, id: \.self) { Text("\($0.provider)/\($0.id)").tag(Optional($0)) }
            }
            .disabled(config.overridden || config.models.isEmpty)
            if config.overridden {
                Text("模型已由服务端环境变量固定，无法在这里切换").font(.footnote).foregroundStyle(.secondary)
            } else if config.models.isEmpty {
                Text("没有可用模型，请检查服务端的 API key 配置").font(.footnote).foregroundStyle(.secondary)
            }
        } else {
            ProgressView()
        }
    }

    private func mcpRow(_ server: McpStatus) -> some View {
        let label: String
        switch server.state {
        case .connected: label = "已连接"
        case .failed: label = "连接失败"
        case .needsAuth: label = "需要授权"
        }
        return HStack(spacing: 10) {
            Circle().fill(server.state == .connected ? Color.green : Color.orange).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(server.name)
                    Text(server.source == .bot ? "自定义" : "平台").font(.caption2).padding(.horizontal, 6).background(.quaternary, in: Capsule())
                }
                Text("\(label) · \(server.tools) 个工具 · 检查于 \(Date(timeIntervalSince1970: server.checkedAt / 1000).formatted(date: .omitted, time: .shortened))")
                    .font(.caption).foregroundStyle(server.state == .connected ? Color.secondary : Color.orange)
                if let error = server.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
}
