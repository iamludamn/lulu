import PiStackKit
import SwiftUI

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
