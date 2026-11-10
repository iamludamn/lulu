import SwiftUI

struct Avatar: View {
    let name: String
    var size: CGFloat = 42

    var body: some View {
        Text(String(name.prefix(2)).capitalized)
            .font(.system(size: size * 0.48, weight: .medium))
            .tracking(-0.4)
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(red: 0.62, green: 0.3, blue: 0.78), in: Circle())
    }
}
