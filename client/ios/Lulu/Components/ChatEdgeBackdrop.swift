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
                    Rectangle().fill(.ultraThinMaterial)
                }
            }
            .mask {
                LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black.opacity(0.05), location: fraction * 0.14),
                    .init(color: .black.opacity(0.25), location: fraction * 0.35),
                    .init(color: .black.opacity(0.65), location: fraction * 0.62),
                    .init(color: .black.opacity(0.92), location: fraction * 0.86),
                    .init(color: .black, location: fraction),
                    .init(color: .black, location: 1)
                ], startPoint: edge == .top ? .bottom : .top,
                   endPoint: edge == .top ? .top : .bottom)
                .opacity(reduceTransparency ? 1 : 0.6)
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
