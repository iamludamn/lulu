import PiStackKit
import SwiftUI

struct WeatherBody: View {
    let city: String
    let size: PanelWidget.Size
    @State private var forecast: Forecast?
    @State private var failed = false

    private var compact: Bool { size == .s }

    var body: some View {
        Group {
            if let forecast {
                content(forecast)
            } else if failed {
                Text("暂时拿不到「\(city)」的天气").font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: city) {
            forecast = await Weather.forecast(city: city)
            failed = forecast == nil
        }
    }

    private func content(_ forecast: Forecast) -> some View {
        let today = forecast.days.first
        let look = Self.look(forecast.code)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Spacer(minLength: 0)
                    Text(degrees(forecast.temperature)).font(.system(size: compact ? 38 : 44, weight: .bold, design: .rounded))
                    Text(look.text).font(.subheadline.weight(.medium))
                    if let today {
                        Text(compact ? "\(degrees(today.high)) / \(degrees(today.low))" : "最高 \(degrees(today.high))  最低 \(degrees(today.low))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
            }
            if size == .l {
                VStack(spacing: 0) {
                    ForEach(Array(forecast.days.dropFirst().enumerated()), id: \.offset) { index, day in
                        if index > 0 { Divider().opacity(0.6) }
                        HStack(spacing: 10) {
                            Text(day.date, format: .dateTime.weekday(.abbreviated)).font(.subheadline.weight(.medium)).frame(width: 44, alignment: .leading)
                            Image(systemName: Self.look(day.code).symbol).symbolRenderingMode(.multicolor)
                            Spacer()
                            Text(degrees(day.low)).foregroundStyle(.secondary)
                            Text(degrees(day.high)).fontWeight(.medium)
                        }
                        .font(.subheadline.monospacedDigit())
                        .padding(.vertical, 6)
                    }
                }
            }
        }
    }

    private func degrees(_ value: Double) -> String { "\(Int(value.rounded()))°" }

    private static func look(_ code: Int) -> (symbol: String, text: String) {
        switch code {
        case 0: ("sun.max.fill", "晴")
        case 1: ("sun.max.fill", "大部晴朗")
        case 2: ("cloud.sun.fill", "多云")
        case 3: ("cloud.fill", "阴")
        case 45, 48: ("cloud.fog.fill", "雾")
        case 51...57: ("cloud.drizzle.fill", "毛毛雨")
        case 61, 63, 65: ("cloud.rain.fill", "雨")
        case 66, 67: ("cloud.sleet.fill", "冻雨")
        case 71...77, 85, 86: ("cloud.snow.fill", "雪")
        case 80...82: ("cloud.heavyrain.fill", "阵雨")
        case 95...99: ("cloud.bolt.rain.fill", "雷暴")
        default: ("cloud.fill", "未知")
        }
    }
}
