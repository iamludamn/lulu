import SwiftUI

struct Avatar: View {
    let name: String
    let id: String
    var size: CGFloat = 44

    private var hue: Double {
        Double(id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) % 360 }) / 360
    }

    var body: some View {
        Text(name.first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(
                LinearGradient(
                    colors: [Color(hue: hue, saturation: 0.45, brightness: 0.78), Color(hue: hue, saturation: 0.6, brightness: 0.62)],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                in: Circle()
            )
    }
}
