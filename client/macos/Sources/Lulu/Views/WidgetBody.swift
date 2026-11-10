import Charts
import PiStackKit
import SwiftUI

struct WidgetBody: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    let interactive: Bool
    let onPrompt: (String) -> Void
    let onCheck: (Int, Bool) -> Void

    private var compact: Bool { widget.size == .s }
    private var rowLimit: Int { widget.size == .l ? 8 : compact ? 2 : 3 }

    var body: some View {
        switch widget.body {
        case .stat(let value, let unit, let at, let delta, let spark):
            stat(value, unit: unit, at: at, delta: delta, spark: spark)
        case .gauge(let meters):
            gauge(meters)
        case .chart(let bars, let x, let series):
            chart(bars: bars, x: x, series: series)
        case .list(let items):
            list(items)
        case .timeline(let events):
            timeline(events)
        case .note(let markdown):
            MarkdownText(text: markdown, size: compact ? 12 : 13, line: compact ? 17 : 19)
                
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .mask(LinearGradient(stops: [.init(color: .black, location: 0.75), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom))
        case .media(let src, let caption):
            media(src, caption: caption)
        case .web:
            web
        case .weather(let city):
            WeatherBody(city: city, size: widget.size)
        case .actions(let buttons):
            actions(buttons)
        case .unknown:
            Text("客户端暂不支持这种组件").type(12, line: 16).foregroundStyle(Color.muted)
        }
    }

    private func stat(_ value: PanelWidget.Value, unit: String?, at: Double?, delta: PanelWidget.Delta?, spark: [Double]) -> some View {
        HStack(alignment: .bottom, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Spacer(minLength: 0)
                Group {
                    if let at {
                        let date = Date(timeIntervalSince1970: at / 1000)
                        Text(date, style: date > .now ? .relative : .date)
                            .font(.system(size: compact ? 24 : 30, weight: .bold, design: .rounded))
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 3) {
                            Text(display(value)).font(.system(size: compact ? 34 : 40, weight: .bold, design: .rounded))
                            if let unit { Text(unit).type(15, .semibold, line: 19).foregroundStyle(Color.muted) }
                        }
                    }
                }
                .foregroundStyle(widget.tone.map { $0 == .neutral ? Color.ink : $0.color } ?? Color.ink)
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .contentTransition(.numericText())
                if let delta {
                    Text(delta.text).type(12, .semibold, line: 16).foregroundStyle(delta.tone.color).lineLimit(1)
                }
            }
            if !compact && spark.count > 1 {
                Chart(Array(spark.enumerated()), id: \.offset) { index, point in
                    AreaMark(x: .value("i", index), y: .value("v", point))
                        .foregroundStyle(.linearGradient(colors: [tint.opacity(0.3), tint.opacity(0)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("i", index), y: .value("v", point))
                        .foregroundStyle(tint)
                        .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .chartYScale(domain: .automatic(includesZero: false))
                .frame(maxWidth: .infinity, maxHeight: 70)
            }
        }
    }

    private var tint: Color { widget.tone?.color ?? Color.info }

    private func display(_ value: PanelWidget.Value) -> String {
        switch value {
        case .number(let number): number.formatted(.number.precision(.fractionLength(0...2)))
        case .text(let text): text
        }
    }

    @ViewBuilder
    private func gauge(_ meters: [PanelWidget.Meter]) -> some View {
        if compact {
            HStack {
                Spacer()
                ZStack {
                    ForEach(Array(meters.prefix(3).enumerated()), id: \.offset) { index, meter in
                        let inset = CGFloat(index) * 15
                        Circle().stroke(Color.veil, lineWidth: 11).padding(inset)
                        Circle()
                            .trim(from: 0, to: fraction(meter))
                            .stroke((meter.tone ?? .accent).color, style: StrokeStyle(lineWidth: 11, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                            .padding(inset)
                    }
                    if meters.count == 1 {
                        Text(fraction(meters[0]), format: .percent.precision(.fractionLength(0)))
                            .font(.system(size: 14, weight: .bold, design: .rounded))
                    }
                }
                .frame(width: 92, height: 92)
                Spacer()
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(meters.enumerated()), id: \.offset) { _, meter in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(meter.label).type(13, .medium, line: 18)
                            Spacer()
                            Text("\(display(.number(meter.value))) / \(display(.number(meter.max)))")
                                .font(.ui(12).monospacedDigit())
                                .foregroundStyle(Color.muted)
                        }
                        Meter(value: fraction(meter), tint: (meter.tone ?? .accent).color)
                    }
                }
            }
        }
    }

    private func fraction(_ meter: PanelWidget.Meter) -> Double {
        meter.max > 0 ? min(max(meter.value / meter.max, 0), 1) : 0
    }

    private func chart(bars: Bool, x: [String], series: [PanelWidget.Series]) -> some View {
        let points = series.flatMap { line in
            line.values.prefix(x.count).enumerated().map { index, value in (line: line.name, tone: line.tone, x: x[index], y: value) }
        }
        return Chart(Array(points.enumerated()), id: \.offset) { _, point in
            if bars {
                BarMark(x: .value("x", point.x), y: .value("y", point.y))
                    .foregroundStyle(by: .value("series", point.line))
                    .cornerRadius(4)
            } else {
                LineMark(x: .value("x", point.x), y: .value("y", point.y))
                    .foregroundStyle(by: .value("series", point.line))
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.catmullRom)
            }
        }
        .chartForegroundStyleScale(domain: series.map(\.name), range: series.enumerated().map { index, line in line.tone?.color ?? defaultSeries[index % defaultSeries.count] })
        .chartLegend(series.count > 1 ? .visible : .hidden)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel().font(.ui(11)) }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(Color.line)
                AxisValueLabel().font(.ui(11))
            }
        }
        .frame(minHeight: 80)
    }

    private var defaultSeries: [Color] { [Color.info, .orange, .green] }

    private func list(_ items: [PanelWidget.Item]) -> some View {
        ViewThatFits(in: .vertical) {
            ForEach(Array(stride(from: min(items.count, rowLimit), through: 1, by: -1)), id: \.self) { rows in
                listRows(items, rows: rows)
            }
        }
    }

    private func listRows(_ items: [PanelWidget.Item], rows: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.prefix(rows).enumerated()), id: \.offset) { index, item in
                if index > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                if let done = item.done {
                    Button { onCheck(index, !done) } label: { listRow(item) }
                        .buttonStyle(.plain)
                        .disabled(!interactive)
                } else {
                    listRow(item)
                }
            }
            if items.count > rows {
                Text("还有 \(items.count - rows) 项").type(12, line: 16).foregroundStyle(Color.muted).padding(.top, widget.size == .l ? 4 : 2)
            }
        }
        .animation(.snappy, value: items.compactMap(\.done))
    }

    private func listRow(_ item: PanelWidget.Item) -> some View {
        HStack(spacing: 10) {
            if let done = item.done {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(done ? Color.info : Color.muted)
            } else if let tone = item.tone {
                Circle().fill(tone.color).frame(width: 8, height: 8)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .type(13, .medium, line: 18)
                    .strikethrough(item.done == true)
                    .foregroundStyle(item.done == true ? Color.muted : Color.ink)
                    .lineLimit(1)
                if let subtitle = item.subtitle, !compact {
                    Text(subtitle).type(12, line: 16).foregroundStyle(Color.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if let value = item.value {
                Text(value).font(.ui(13).monospacedDigit()).foregroundStyle(item.tone == .bad || item.tone == .warn ? item.tone!.color : Color.muted).lineLimit(1)
            }
        }
        .padding(.vertical, widget.size == .l ? 6 : 4)
        .contentShape(.rect)
    }

    private func timeline(_ events: [PanelWidget.Event]) -> some View {
        let sorted = events.sorted { $0.at < $1.at }
        let now = Date.now.timeIntervalSince1970 * 1000
        let upcoming = sorted.firstIndex { ($0.end ?? $0.at) >= now } ?? sorted.count
        let shown = widget.size == .l ? Array(sorted) : Array(sorted[upcoming...].prefix(compact ? 1 : 2))
        return VStack(alignment: .leading, spacing: 8) {
            if shown.isEmpty {
                Text("今天没有更多安排").type(13, line: 18).foregroundStyle(Color.muted)
            }
            ForEach(Array(shown.enumerated()), id: \.offset) { index, event in
                if widget.size == .l && index == upcoming - (sorted.count - shown.count) && index > 0 {
                    HStack(spacing: 6) {
                        Text("现在").type(11, .bold, line: 14).foregroundStyle(.red)
                        Rectangle().fill(.red).frame(height: 1)
                    }
                }
                let date = Date(timeIntervalSince1970: event.at / 1000)
                HStack(alignment: .top, spacing: 10) {
                    Text(date, format: .dateTime.hour().minute())
                        .font(.ui(12).monospacedDigit())
                        .foregroundStyle(Color.muted)
                        .frame(width: 42, alignment: .leading)
                        .padding(.top, 1)
                    RoundedRectangle(cornerRadius: 2).fill((event.tone ?? .accent).color).frame(width: 3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(event.title).type(13, .semibold, line: 18).lineLimit(1)
                        Text(event.detail ?? date.formatted(.relative(presentation: .named)))
                            .type(12, line: 16)
                            .foregroundStyle(Color.muted)
                            .lineLimit(1)
                    }
                }
                .opacity((event.end ?? event.at) < now ? 0.55 : 1)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func media(_ src: String, caption: String?) -> some View {
        Color.clear
            .overlay {
                AsyncImage(url: resolve(src)) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    case .failure: Image(systemName: "photo").font(.ui(28)).foregroundStyle(Color.muted)
                    default: ProgressView()
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .frame(height: widget.size == .l ? 240 : nil)
            .clipShape(.rect(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .bottomLeading) {
                if let caption {
                    Text(caption)
                        .type(12, .semibold, line: 16)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .glassEffect(.regular, in: .capsule)
                        .padding(8)
                }
            }
    }

    private var web: some View {
        VStack(spacing: 6) {
            Image(systemName: "safari").font(.system(size: 34, weight: .light)).foregroundStyle(Color.info)
            Text("点开查看").type(12, line: 16).foregroundStyle(Color.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func resolve(_ src: String) -> URL? {
        ArtifactAddress(src).map { api.artifactURL(botId, $0) } ?? URL(string: src)
    }

    private func actions(_ buttons: [PanelWidget.Button]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: compact ? 1 : 2), spacing: 8) {
            ForEach(Array(buttons.prefix(compact ? 1 : 4).enumerated()), id: \.offset) { _, button in
                Button { onPrompt(button.prompt) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: button.icon ?? "sparkles").font(.ui(15, .semibold)).foregroundStyle(Color.info)
                        Text(button.label).type(13, .semibold, line: 18).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.veil, in: .rect(cornerRadius: 16, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!interactive)
            }
        }
    }
}

private struct Meter: View {
    let value: Double
    let tint: Color

    var body: some View {
        Capsule()
            .fill(Color.veil)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule().fill(tint).frame(width: max(6, proxy.size.width * value))
                }
            }
            .frame(height: 6)
    }
}
