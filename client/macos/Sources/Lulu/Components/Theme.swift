import AppKit
import PiStackKit
import SwiftUI

private func rgba(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

extension Color {
    static func scheme(dark: NSColor, light: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }

    static let ink = scheme(dark: rgba(0xF5F5F7), light: rgba(0x1D1D1F))
    static let muted = scheme(dark: rgba(0xF5F5F7, 0.5), light: rgba(0x1D1D1F, 0.5))
    static let faint = scheme(dark: rgba(0xF5F5F7, 0.3), light: rgba(0x1D1D1F, 0.3))
    static let line = scheme(dark: rgba(0xF5F5F7, 0.14), light: rgba(0x1D1D1F, 0.14))
    static let veil = scheme(dark: rgba(0xF5F5F7, 0.06), light: rgba(0x1D1D1F, 0.05))
    static let pane = scheme(dark: rgba(0x1D1D1F, 0.618), light: rgba(0xFFFFFF, 0.55))
    static let reply = scheme(dark: rgba(0x1D1D1F, 0.7), light: rgba(0xFFFFFF, 0.98))
    static let mine = scheme(dark: rgba(0x1D1D1F, 0.36), light: rgba(0xFFFFFF, 0.42))
    static let sheet = rgba(0xF5F5F7).swiftUI
    static let chip = scheme(dark: rgba(0xF5F5F7), light: rgba(0xFFFFFF))
    static let sheetInk = rgba(0x1D1D1F).swiftUI
    static let paper = scheme(dark: rgba(0x26262A), light: rgba(0xFFFFFF))
    static let info = scheme(dark: rgba(0xA1D0FF), light: rgba(0x005AD7))
    static let success = scheme(dark: rgba(0x96F0B0), light: rgba(0x0F9D58))
    static let warning = scheme(dark: rgba(0xFFC832), light: rgba(0xB45309))
    static let failure = scheme(dark: rgba(0xFF6464), light: rgba(0xD64545))
    static let knob = scheme(dark: rgba(0xF5F5F7), light: rgba(0x1D1D1F))
    static let knobInk = scheme(dark: rgba(0x1D1D1F), light: rgba(0xF5F5F7))
}

private extension NSColor {
    var swiftUI: Color { Color(nsColor: self) }
}

extension Font {
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}

extension View {
    func type(_ size: CGFloat, _ weight: Font.Weight = .regular, line: CGFloat? = nil) -> some View {
        font(.ui(size, weight))
            .lineHeight(.exact(points: line ?? (size * 1.3).rounded()))
    }

    func pane(_ radius: CGFloat, tint: Color = .pane, interactive: Bool = false) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background { shape.fill(tint) }
            .glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    }
}

extension Tone {
    var color: Color {
        switch self {
        case .neutral: .muted
        case .good: .success
        case .warn: .warning
        case .bad: .failure
        case .accent: .info
        }
    }
}
