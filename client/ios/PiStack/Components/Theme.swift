import PiStackKit
import SwiftUI

extension Color {
    static let lift = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.28) : UIColor(white: 1, alpha: 0.95) })
    static let frost = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 1, alpha: 0.06) : UIColor(white: 1, alpha: 0.55) })
    static let paper = Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.15, alpha: 1) : .white })
}

extension View {
    func frosted(_ radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background {
            shape.fill(.ultraThinMaterial)
                .overlay { shape.fill(Color.frost) }
                .overlay { shape.strokeBorder(Color.white.opacity(0.45), lineWidth: 0.6) }
                .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        }
    }
}

extension Tone {
    var color: Color {
        switch self {
        case .neutral: .secondary
        case .good: .green
        case .warn: .orange
        case .bad: .red
        case .accent: .accentColor
        }
    }
}
