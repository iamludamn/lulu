import PiStackKit
import SwiftUI

extension ScheduledTaskRow.State {
    var label: String {
        switch self {
        case .active: "已启用"
        case .paused: "已暂停"
        case .done: "已完成"
        case .missed: "已错过"
        case .deleted: "已删除"
        }
    }
}

struct ScheduleOverview: View {
    let rows: [ScheduledTaskRow]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(rows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    LabeledContent {
                        Text(row.state.label)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(row.state == .active ? Color.green : .secondary)
                    } label: {
                        Text(row.name).font(.subheadline.weight(.semibold))
                    }
                    switch row.schedule {
                    case .once(let at): Text("一次 · \(utc(at))")
                    case .daily(let time, let tz): Text("每天 \(time)（\(tz)）")
                    }
                    Text(row.nextRunAt.map { "下次 \(utc($0))" } ?? "无下次执行")
                        .font(.caption)
                    if let last = row.lastRunAt {
                        Text("上次触发 · \(utc(last))").font(.caption)
                    }
                }
                .font(.subheadline).foregroundStyle(.secondary)
                .padding(.vertical, 3)
            }
            .overlay { if rows.isEmpty { ContentUnavailableView("暂无定时任务", systemImage: "clock") } }
            .navigationTitle("定时任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }

    private func utc(_ ms: Double) -> String {
        let format = Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: TimeZone(secondsFromGMT: 0) ?? .gmt)
        return Date(timeIntervalSince1970: ms / 1000).formatted(format) + " UTC"
    }
}

struct ScheduleView: View {
    let botId: String
    let api: Api

    var body: some View {
        Loaded(load: { try await api.schedules(botId) }) { entries in
            List {
                Section {
                    ForEach(entries) { entry in row(entry) }
                } footer: {
                    Text("在对话里让 bot 定时做事，任务会出现在这里。")
                }
            }
            .overlay { if entries.isEmpty { ContentUnavailableView("暂无定时任务", systemImage: "clock") } }
        }
        .navigationTitle("定时任务")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ entry: ScheduleEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(entry.name)
                Spacer()
                Text(stateLabel(entry.state))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(entry.state == .active ? Color.green : .secondary)
            }
            Text(scheduleText(entry.schedule)).font(.subheadline).foregroundStyle(.secondary)
            if let next = entry.nextRunAt, entry.state == .active {
                Text("下次 \(time(next))").font(.caption).foregroundStyle(.secondary)
            }
            if let last = entry.lastRun {
                Text("上次 \(time(last.scheduledFor)) \(runLabel(last.status))")
                    .font(.caption)
                    .foregroundStyle(last.status == .failed ? Color.orange : .secondary)
            }
        }
        .padding(.vertical, 2)
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
