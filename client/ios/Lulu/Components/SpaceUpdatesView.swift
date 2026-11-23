import LuluKit
import SwiftUI

struct SpaceUpdatesView: View {
    let bridge: SpaceBridge
    let status: SpaceUpdate?

    @Environment(\.dismiss) private var dismiss
    @State private var content: SpaceContent?
    @State private var value: String?
    @State private var issue: String?
    @State private var settings = false
    @State private var loading: UUID?
    @State private var pulls = 0

    private var current: SpaceUpdate? { status ?? content?.status }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let current {
                        if let checked = current.checkedAt {
                            LabeledContent("上次检查", value: formatted(checked))
                        }
                        if let next = current.nextAt, current.enabled {
                            LabeledContent("下次更新", value: formatted(next))
                        }
                        if let text = state(current) {
                            Text(text).foregroundStyle(current.error == nil ? Color.secondary : Color.orange)
                        }
                    }
                    if let issue { Text(issue).foregroundStyle(.orange) }
                    if loading != nil && pulls == 0 { ProgressView() }
                }
                if let content = content?.data {
                    if let time = content.updatedAt {
                        Section("内容更新于 \(formatted(time))") {
                            ForEach(content.findings) { finding in
                                Link(destination: finding.url) {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(finding.title)
                                        Text(finding.url.host() ?? finding.url.absoluteString).font(.caption).foregroundStyle(.secondary)
                                        if let detail = finding.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
                                        if finding.truncated == true { Text("差异已截断，请查看原文").font(.caption).foregroundStyle(.secondary) }
                                    }
                                }
                            }
                            if let value {
                                Text(value).font(.footnote.monospaced()).textSelection(.enabled)
                            }
                        }
                        .task(id: content.version) {
                            if content.version > (current?.seen ?? 0) {
                                try? await bridge.api.spaceAction(bridge.botId, space: bridge.space, action: "seen", version: content.version)
                            }
                        }
                    }
                }
            }
            .refreshable { await load(pull: true) }
            .navigationTitle("Space 更新")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("设置") { settings = true } }
            }
            .sheet(isPresented: $settings, onDismiss: { Task { await load() } }) {
                SpaceUpdateSettings(bridge: bridge, status: current, providers: content?.providers ?? ["perplexity"])
            }
            .task(id: status?.version) { await load() }
            .onDisappear { loading = nil }
        }
    }

    private func formatted(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }

    private func state(_ status: SpaceUpdate) -> String? {
        if let error = status.error { return error }
        switch status.phase {
        case "create": return "正在创建订阅"
        case "pause": return "正在暂停订阅"
        case "resume": return "正在恢复订阅"
        case "delete": return "正在移除订阅"
        case "deleted": return "订阅已移除"
        default:
            if status.mode.kind == "manual" { return "手动刷新" }
            if !status.enabled { return "已暂停" }
            if status.checkedAt == nil { return status.mode.source?.kind == "page" ? "正在建立网页基线" : "等待首次检查" }
            if status.mode.source?.kind == "page", status.updatedAt == nil { return "网页基线已建立" }
            return nil
        }
    }

    private func load(pull: Bool = false) async {
        guard !Task.isCancelled else { return }
        let request = UUID()
        loading = request
        issue = nil
        if pull { pulls += 1 }
        defer {
            if loading == request { loading = nil }
            if pull { pulls -= 1 }
        }
        do {
            let raw = try await bridge.api.spaceContent(bridge.botId, space: bridge.space)
            guard !Task.isCancelled, loading == request else { return }
            let content = try JSONDecoder().decode(SpaceContent.self, from: raw)
            let object = (try JSONSerialization.jsonObject(with: raw) as? [String: Any])?["data"] as? [String: Any]
            if let text = object?["value"] as? String {
                self.value = text
            } else if let snapshot = object?["value"], let bytes = try? JSONSerialization.data(withJSONObject: snapshot, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) {
                self.value = String(decoding: bytes, as: UTF8.self)
            } else {
                self.value = nil
            }
            self.content = content
            issue = nil
        } catch {
            guard !Task.isCancelled, loading == request else { return }
            issue = error.localizedDescription
        }
    }
}

struct SpaceUpdateSettings: View {
    let bridge: SpaceBridge
    let status: SpaceUpdate?
    let providers: [String]

    @Environment(\.dismiss) private var dismiss
    @State private var provider = "perplexity"
    @State private var kind = "manual"
    @State private var source = "search"
    @State private var target = ""
    @State private var goal = ""
    @State private var time = Date()
    @State private var zone = TimeZone.current
    @State private var notify = true
    @State private var issue: String?
    @State private var busy = false

    private var attached: Bool { status?.mode.kind == "subscription" && status?.phase != "deleted" }
    private var targets: [String] { target.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }

    var body: some View {
        NavigationStack {
            Form {
                Section("数据来源") {
                    if attached {
                        LabeledContent("刷新方式", value: "自动订阅")
                    } else {
                        Picker("刷新方式", selection: $kind) {
                            Text("手动刷新").tag("manual")
                            Text("定时刷新").tag("scheduled")
                            if !providers.isEmpty { Text("自动订阅").tag("subscription") }
                        }
                    }
                    if kind == "scheduled" {
                        TextField("HTTPS 数据地址", text: $target)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        DatePicker("每天", selection: $time, displayedComponents: .hourAndMinute)
                            .environment(\.timeZone, zone)
                        LabeledContent("时区", value: zone.identifier)
                    }
                    if kind == "subscription" {
                        if providers.count > 1 && !attached {
                            Picker("监控服务", selection: $provider) {
                                ForEach(providers, id: \.self) { Text(providerName($0)).tag($0) }
                            }
                        } else {
                            LabeledContent("监控服务", value: providerName(provider))
                        }
                        Picker("监控类型", selection: $source) {
                            Text("主题").tag("search")
                            Text("指定网页").tag("page")
                            if source == "extract" { Text("结构化网页数据").tag("extract") }
                        }
                        TextField(source == "search" ? "搜索主题" : provider == "context" ? "网页地址" : "网页地址，每行一个", text: $target, axis: .vertical)
                            .textInputAutocapitalization(.never)
                        TextField("什么变化值得记录？", text: $goal, axis: .vertical)
                        LabeledContent("检查频率", value: "每天")
                        if source != "extract" { Text(provider == "context"
                             ? (source == "search" ? "每次成功检查使用 2 credits" : "每次成功检查使用 1 credit")
                             : (source == "search" ? "每次成功检查 US$0.001" : "每次成功检查按网页计费，每个 US$0.001"))
                            .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(attached)
                if kind != "manual" {
                    Section { Toggle("有新内容时通知我", isOn: $notify) }
                }
                if let status, status.mode.kind != "manual", status.phase != "deleted", status.phase != "delete" {
                    Section {
                        Button(status.enabled ? "暂停更新" : "恢复更新") { send(status.enabled ? "pause" : "resume") }
                        if status.mode.kind == "subscription" {
                            Button("移除订阅", role: .destructive) { send("remove") }
                        }
                    }
                }
                if let issue { Section { Text(issue).foregroundStyle(.orange) } }
            }
            .disabled(busy)
            .navigationTitle("更新设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(kind == "subscription" && !attached ? "启用订阅" : "保存") { send("configure") }
                        .disabled(busy || (kind != "manual" && target.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ||
                                  (kind == "subscription" && (goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                                   (provider == "context" && source == "page" && targets.count != 1))))
                }
            }
            .onAppear(perform: populate)
        }
    }

    private func providerName(_ name: String) -> String {
        name == "context" ? "Context.dev" : "Perplexity"
    }

    private func populate() {
        provider = attached ? status?.mode.provider ?? "perplexity" : providers.first ?? "perplexity"
        if let status, status.phase != "deleted" {
            kind = status.mode.kind
            notify = status.notify
            source = status.mode.source?.kind ?? "search"
            target = status.mode.url ?? status.mode.source?.url ?? status.mode.source?.query ?? status.mode.source?.urls?.joined(separator: "\n") ?? ""
            goal = status.mode.goal ?? ""
            zone = status.mode.tz.flatMap(TimeZone.init(identifier:)) ?? .current
        }
        var calendar = Calendar.current
        calendar.timeZone = zone
        let pieces = status?.mode.time?.split(separator: ":").compactMap { Int($0) } ?? [9, 0]
        if pieces.count == 2 { time = calendar.date(bySettingHour: pieces[0], minute: pieces[1], second: 0, of: Date()) ?? Date() }
    }

    private var configuration: SpaceUpdate.Mode? {
        switch kind {
        case "scheduled":
            var calendar = Calendar.current
            calendar.timeZone = zone
            let parts = calendar.dateComponents([.hour, .minute], from: time)
            return .init(kind: kind, url: target, time: String(format: "%02d:%02d", parts.hour ?? 9, parts.minute ?? 0), tz: zone.identifier)
        case "subscription":
            if attached && source == "extract" { return nil }
            if attached, let mode = status?.mode { return mode }
            return .init(kind: kind, provider: provider, goal: goal, source: source == "search" ? .init(kind: source, query: target) : .init(kind: source, urls: targets))
        default: return .init(kind: "manual")
        }
    }

    private func send(_ action: String) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await bridge.api.spaceAction(bridge.botId, space: bridge.space, action: action, mode: action == "configure" ? configuration : nil, notify: notify)
                if notify && action == "configure" && kind != "manual" { await SpacePush.shared.enable(api: bridge.api, botId: bridge.botId) }
                dismiss()
            } catch {
                issue = error.localizedDescription
            }
        }
    }
}
