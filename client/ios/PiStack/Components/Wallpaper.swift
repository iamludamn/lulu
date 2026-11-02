import SwiftUI

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
    @AppStorage("pistack.wallpaper") private var theme = WallpaperTheme.sky
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            WallpaperMesh(theme: theme)
            if scheme == .dark && theme.hasStars { Starfield() }
        }
        .ignoresSafeArea()
    }
}

private struct Star {
    let x: Double
    let y: Double
    let radius: Double
    let alpha: Double
    let phase: Double
    let speed: Double
    let glow: Bool

    static let field: [Star] = {
        var rng = SplitMix64(state: 7)
        return (0..<240).map { index in
            let bright = index % 12 == 0
            return Star(
                x: .random(in: 0...1, using: &rng),
                y: .random(in: 0...1, using: &rng),
                radius: bright ? .random(in: 1.3...2.0, using: &rng) : .random(in: 0.5...1.2, using: &rng),
                alpha: bright ? .random(in: 0.85...1, using: &rng) : .random(in: 0.45...0.9, using: &rng),
                phase: .random(in: 0...(2 * .pi), using: &rng),
                speed: .random(in: 0.4...1.6, using: &rng),
                glow: bright
            )
        }
    }()
}

private struct SplitMix64: RandomNumberGenerator {
    var state: UInt64

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

struct Starfield: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: reduceMotion)) { timeline in
            Canvas { context, size in
                let t = timeline.date.timeIntervalSinceReferenceDate
                for star in Star.field {
                    let twinkle = 0.65 + 0.35 * sin(t * star.speed + star.phase)
                    let alpha = star.alpha * twinkle * (1 - 0.45 * star.y)
                    let dot = CGRect(x: star.x * size.width - star.radius, y: star.y * size.height - star.radius, width: star.radius * 2, height: star.radius * 2)
                    context.fill(Path(ellipseIn: dot), with: .color(.white.opacity(alpha)))
                    if star.glow {
                        context.fill(Path(ellipseIn: dot.insetBy(dx: -star.radius * 2.5, dy: -star.radius * 2.5)), with: .color(.white.opacity(alpha * 0.18)))
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}
