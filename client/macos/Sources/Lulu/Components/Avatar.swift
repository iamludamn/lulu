import SwiftUI

struct LogoMark: View {
    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            let unit = size / 1024
            ZStack {
                RadialGradient(stops: [
                    .init(color: .white, location: 0),
                    .init(color: Color(red: 0.827, green: 0.910, blue: 1), location: 0.32),
                    .init(color: Color(red: 0.357, green: 0.612, blue: 0.910), location: 1),
                ], center: .center, startRadius: 0, endRadius: size * 0.72)
                ForEach(0..<5, id: \.self) { ring in
                    let side = (330 + 105 * CGFloat(ring)) * unit
                    RoundedRectangle(cornerRadius: side * 0.22, style: .continuous)
                        .stroke(.white.opacity(0.95 - 0.17 * Double(ring)), lineWidth: (20 - 2.4 * CGFloat(ring)) * unit)
                        .frame(width: side, height: side)
                        .rotationEffect(.degrees(11 * Double(ring)))
                }
                Circle()
                    .fill(RadialGradient(colors: [.white, Color(red: 0.918, green: 0.957, blue: 1)], center: UnitPoint(x: 0.5, y: 0.42), startRadius: 0, endRadius: 160 * unit))
                    .frame(width: 260 * unit, height: 260 * unit)
                    .shadow(color: Color(red: 0.247, green: 0.498, blue: 0.816).opacity(0.35), radius: 22 * unit, y: 10 * unit)
            }
            .frame(width: size, height: size)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct Avatar: View {
    var size: CGFloat = 42

    var body: some View {
        LogoMark()
            .scaleEffect(1.5)
            .frame(width: size, height: size)
            .clipShape(.circle)
            .overlay { Circle().strokeBorder(.white.opacity(0.7), lineWidth: 1) }
            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
    }
}
