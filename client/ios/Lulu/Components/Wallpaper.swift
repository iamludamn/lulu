import SwiftUI
import LuluKit

enum WallpaperTheme: String, CaseIterable, Identifiable {
    case sky, dusk, mint, peach, graphite, aurora

    var id: String { rawValue }

    var title: String {
        switch self {
        case .sky: "晴空"
        case .dusk: "暮光"
        case .mint: "薄荷"
        case .peach: "蜜桃"
        case .graphite: "石墨"
        case .aurora: "极光"
        }
    }

    var hasStars: Bool { self == .sky }

    func palette(dark: Bool) -> [Color] {
        (dark ? night : day).map { Color(red: Double($0 >> 16 & 0xFF) / 255, green: Double($0 >> 8 & 0xFF) / 255, blue: Double($0 & 0xFF) / 255) }
    }

    private var day: [UInt32] {
        switch self {
        case .sky: [0x4578B3, 0x5487BF, 0x4D80BD, 0x85B0DB, 0xB8D1EB, 0x8CB8E3, 0xBDCCDB, 0xCCD6E0, 0xADC4DE]
        case .dusk: [0x6A5AA8, 0x7B63B0, 0x8A6BB5, 0xB59AD0, 0xE3C3DE, 0xD7A9C8, 0xE6B9B5, 0xF1CBB8, 0xE0AFC0]
        case .mint: [0x2F8F83, 0x3A9C8E, 0x35958A, 0x7FCBBE, 0xBDE8DF, 0x8DD3C5, 0xB7D9D0, 0xCDE6DE, 0xA9D2C8]
        case .peach: [0xC9704F, 0xD5805C, 0xCE7653, 0xF0B08F, 0xFADCC7, 0xF3BE9F, 0xEBCDBD, 0xF2DBCF, 0xE8C5B3]
        case .graphite: [0x6F7580, 0x7A808B, 0x747A85, 0xB5BAC3, 0xDADDE3, 0xBFC4CC, 0xC9CCD2, 0xD6D9DE, 0xC3C7CE]
        case .aurora: [0x4A5FB5, 0x5C74C2, 0x6A63BD, 0x86C4D4, 0xB9E0E6, 0xA7A4DC, 0xA9D8D0, 0xC3E3E0, 0xB9B4E0]
        }
    }

    private var night: [UInt32] {
        switch self {
        case .sky: [0x080D1C, 0x0D1429, 0x0A0F24, 0x142140, 0x243357, 0x172445, 0x1F2133, 0x292B3D, 0x1A1F33]
        case .dusk: [0x120B26, 0x1A0F33, 0x160D2C, 0x2B1A4A, 0x45275F, 0x331E50, 0x2A1830, 0x3A2038, 0x2D1B3A]
        case .mint: [0x04161A, 0x061E22, 0x05191D, 0x0B3236, 0x14494B, 0x0D3A3C, 0x112A2A, 0x193535, 0x112E2E]
        case .peach: [0x240D08, 0x2E120B, 0x280F09, 0x4A2216, 0x65301F, 0x512719, 0x33201A, 0x402A22, 0x351F19]
        case .graphite: [0x0A0B0D, 0x0E1013, 0x0C0D10, 0x1A1D22, 0x262A31, 0x1E2127, 0x181A1E, 0x20232A, 0x1B1D22]
        case .aurora: [0x070C26, 0x0B1233, 0x0A0D2E, 0x0F3040, 0x16505A, 0x1E2A5A, 0x0F2A33, 0x173B44, 0x1A2650]
        }
    }
}

struct WallpaperMesh: View {
    let theme: WallpaperTheme
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        MeshGradient(width: 3, height: 3, points: [
            [0, 0], [0.5, 0], [1, 0],
            [0, 0.45], [0.62, 0.52], [1, 0.4],
            [0, 1], [0.5, 1], [1, 1],
        ], colors: theme.palette(dark: scheme == .dark))
    }
}

struct Wallpaper: View {
    @AppStorage(AppPreferences.wallpaper) private var theme = WallpaperTheme.sky
    @AppStorage("lulu.sky.city") private var city = ""
    @State private var weather: SkyWeather?
    @Environment(\.scenePhase) private var phase

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { tick in
            if theme == .sky {
                let current = weather.flatMap { $0.usable(at: tick.date) ? $0 : nil }
                CloudSky(mood: previewMood ?? current?.mood(at: tick.date) ?? fallback(tick.date),
                         cover: current?.cloudCover ?? 35)
            } else {
                WallpaperMesh(theme: theme)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .task(id: "\(city)-\(phase == .active)-\(theme.rawValue)") {
            weather = nil
            guard phase == .active, theme == .sky, !city.isEmpty else { return }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            while !Task.isCancelled {
                let next = await SkyWeather.load(city: city)
                guard !Task.isCancelled else { return }
                weather = next
                do { try await Task.sleep(for: .seconds(1200)) } catch { return }
            }
        }
    }

    private var previewMood: SkyWeather.Mood? {
        #if DEBUG
        SkyWeather.Mood(rawValue: UserDefaults.standard.string(forKey: "lulu.sky.preview") ?? "")
        #else
        nil
        #endif
    }

    private func fallback(_ date: Date) -> SkyWeather.Mood {
        let hour = Calendar.current.component(.hour, from: date)
        return (7..<18).contains(hour) ? .day : .night
    }
}

private struct CloudSky: View {
    let mood: SkyWeather.Mood
    let cover: Double
    @Environment(\.colorScheme) private var scheme

    private var moodValue: Float {
        switch mood {
        case .day: 0
        case .dusk: 1
        case .rain: 2
        case .night: 3
        }
    }

    var body: some View {
        GeometryReader { proxy in
            Rectangle().fill(.white)
                .colorEffect(ShaderLibrary.skyClouds(
                    .float2(proxy.size), .float(moodValue),
                    .float(Float(min(100, max(0, cover)))), .float(scheme == .dark ? 1 : 0)
                ))
        }
    }
}
