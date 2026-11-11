import SwiftUI

struct Backdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Wallpaper()
            if scheme == .light {
                LinearGradient(colors: [.white.opacity(0.28), .white.opacity(0.12)], startPoint: .top, endPoint: .bottom)
            }
        }
        .ignoresSafeArea()
    }
}
