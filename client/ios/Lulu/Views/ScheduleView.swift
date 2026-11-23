import LuluKit
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

private extension ScheduledTaskRow {
    var modeLabel: String { mode == .reminder ? "提醒" : "任务" }

    var summaryLabel: String {
        switch schedule {
        case .once: "一次性\(modeLabel)"
        case .daily: "每日\(modeLabel)"
        }
    }
}

private func scheduleDay(_ date: Date) -> String {
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "今天" }
    if calendar.isDateInTomorrow(date) { return "明天" }
    return date.formatted(.dateTime.month().day())
}

struct ScheduleSummary: View {
    let rows: [ScheduledTaskRow]
    let expandsInline: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    private var showsDetails: Bool { !expandsInline || expanded }

    var body: some View {
        let sorted = ScheduledTaskRow.upcomingFirst(rows)
        VStack(alignment: .leading, spacing: 12) {
            summary(next: sorted.first)
            if expandsInline && expanded {
                ForEach(sorted) { row in
                    Divider().opacity(0.45)
                    ScheduleDetailRow(row: row)
                }
            }
        }
    }

    private func summary(next: ScheduledTaskRow?) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label("定时任务", systemImage: "clock").font(.subheadline.weight(.semibold))
                Spacer()
                if expandsInline && !rows.isEmpty {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) { expanded.toggle() }
                    } label: {
                        disclosure
                            .padding(.leading, 12)
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                } else if !expandsInline {
                    disclosure
                }
            }
            if let row = next, let next = row.upcomingAt {
                let date = Date(timeIntervalSince1970: next / 1000)
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .bottom) {
                        time(date)
                        Spacer(minLength: 12)
                        event(row, alignment: .trailing)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        time(date)
                        event(row, alignment: .leading)
                    }
                }
                .accessibilityElement(children: .combine)
            } else {
                Text("暂无即将触发的定时任务")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var disclosure: some View {
        HStack(spacing: 5) {
            if expanded {
                Text("收起")
            } else {
                Text("全部 \(rows.count) 项")
            }
            Image(systemName: expandsInline ? (expanded ? "chevron.up" : "chevron.down") : "chevron.right")
                .imageScale(.small)
                .accessibilityHidden(true)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func time(_ date: Date) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(showsDetails ? "下一次 · \(scheduleDay(date))" : scheduleDay(date))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(date.formatted(.dateTime.hour().minute()))
                .font(.largeTitle.weight(.semibold).monospacedDigit())
        }
    }

    private func event(_ row: ScheduledTaskRow, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(row.name).font(.headline)
            if showsDetails {
                Text(row.summaryLabel).font(.caption).foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
    }
}

private struct ScheduleDetailRow: View {
    let row: ScheduledTaskRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(row.name).font(.subheadline.weight(.semibold))
                Text(row.summaryLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(row.upcomingAt.map(nextLabel) ?? row.state.label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private func nextLabel(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        return "\(scheduleDay(date)) \(date.formatted(.dateTime.hour().minute()))"
    }
}

struct ScheduleOverview: View {
    let rows: [ScheduledTaskRow]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(ScheduledTaskRow.upcomingFirst(rows)) { row in
                ScheduleDetailRow(row: row)
            }
            .overlay { if rows.isEmpty { ContentUnavailableView("暂无定时任务", systemImage: "clock") } }
            .navigationTitle("定时任务")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
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
