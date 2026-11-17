import SwiftUI
import UIKit

struct ChatEdgeBackdrop: View {
    let edge: VerticalEdge
    let fade: CGFloat
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { proxy in
            let fraction = min(1, fade / max(1, proxy.size.height))
            Group {
                if reduceTransparency {
                    Rectangle().fill(Color(uiColor: .systemBackground))
                } else {
                    Rectangle().fill(.regularMaterial)
                }
            }
            .mask {
                LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black.opacity(0.2), location: fraction * 0.25),
                    .init(color: .black.opacity(0.65), location: fraction * 0.65),
                    .init(color: .black, location: fraction),
                    .init(color: .black, location: 1)
                ], startPoint: edge == .top ? .bottom : .top,
                   endPoint: edge == .top ? .top : .bottom)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct ChatInputShield: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}
}
