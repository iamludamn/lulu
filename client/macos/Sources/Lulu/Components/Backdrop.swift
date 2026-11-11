import SwiftUI

struct Backdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Wallpaper()
            if scheme == .light {
                LinearGradient(colors: [.white.opacity(0.28), .white.opacity(0.12)], startPoint: .top, endPoint: .bottom)
            }
            GeometryReader { proxy in
                let w = proxy.size.width
                let h = proxy.size.height
                let light = scheme == .light
                ZStack {
                    disc(light ? Color(red: 1, green: 0.78, blue: 0.88) : Color(red: 0.45, green: 0.5, blue: 1), 0.75, d: h * 0.4).position(x: w * 0.27, y: h * 0.27)
                    disc(light ? Color(red: 0.66, green: 0.93, blue: 1) : Color(red: 0.3, green: 0.7, blue: 0.9), 0.7, d: h * 0.34).position(x: w * 0.05, y: h * 0.8)
                    disc(light ? Color(red: 0.84, green: 0.79, blue: 1) : Color(red: 0.6, green: 0.45, blue: 0.95), 0.7, d: h * 0.46).position(x: w * 0.74, y: h * 0.72)
                }
            }
        }
        .ignoresSafeArea()
    }

    private func disc(_ tone: Color, _ opacity: Double, d: CGFloat) -> some View {
        Circle()
            .fill(LinearGradient(colors: [tone.opacity(opacity), tone.opacity(opacity * 0.35)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: d, height: d)
    }
}
