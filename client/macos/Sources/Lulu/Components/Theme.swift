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
    static let pane = scheme(dark: rgba(0x1D1D1F, 0.3), light: rgba(0xFFFFFF, 0.16))
    static let frost = scheme(dark: rgba(0xF5F5F7, 0.06), light: rgba(0xFFFFFF, 0.55))
    static let sheet = rgba(0xF5F5F7).swiftUI
    static let chip = scheme(dark: rgba(0xF5F5F7), light: rgba(0xFFFFFF))
    static let sheetInk = rgba(0x1D1D1F).swiftUI
    static let paper = scheme(dark: rgba(0x26262A), light: rgba(0xFFFFFF))
    static let info = scheme(dark: rgba(0xA1D0FF), light: rgba(0x005AD7))
    static let success = scheme(dark: rgba(0x96F0B0), light: rgba(0x0F9D58))
    static let warning = scheme(dark: rgba(0xFFC832), light: rgba(0xB45309))
    static let failure = scheme(dark: rgba(0xFF6464), light: rgba(0xD64545))
    static let thumb = scheme(dark: rgba(0xF5F5F7), light: rgba(0xFFFFFF))
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

    func pane(_ radius: CGFloat, tint: Color? = .pane) -> some View {
        glass(RoundedRectangle(cornerRadius: radius, style: .continuous), tint: tint)
    }

    func clearGlass(_ radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background {
            Color.clear.glassEffect(.clear, in: shape).allowsHitTesting(false)
        }
    }

    func frosted(_ radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background {
            shape.fill(.ultraThinMaterial)
                .overlay { shape.fill(Color.frost) }
                .overlay { shape.strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6) }
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
                .allowsHitTesting(false)
        }
    }

    func glass(_ shape: some Shape, tint: Color? = nil) -> some View {
        background {
            ZStack {
                Color.clear.glassEffect(.regular, in: shape)
                if let tint { shape.fill(tint) }
            }
            .allowsHitTesting(false)
        }
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

struct Glassy<S: Shape>: ButtonStyle {
    let shape: S
    var tint: Color?

    func makeBody(configuration: Configuration) -> some View {
        GlassyBody(configuration: configuration, shape: shape, tint: tint)
    }
}

private struct GlassyBody<S: Shape>: View {
    let configuration: ButtonStyleConfiguration
    let shape: S
    let tint: Color?
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        configuration.label
            .contentShape(shape)
            .glass(shape, tint: tint)
            .overlay { shape.fill(Color.ink.opacity(hovering && enabled ? 0.05 : 0)).allowsHitTesting(false) }
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .opacity(enabled ? 1 : 0.5)
            .onHover { hovering = $0 }
            .animation(.snappy(duration: 0.16), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.15), value: hovering)
    }
}
