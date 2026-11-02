import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var keepTargets: [Page: CGPoint] = [:]
    @Entry var keepPull: (Page, CGFloat) -> Void = { _, _ in }
    @Entry var topInset: CGFloat = 0
}

private let swipeThreshold: CGFloat = 90

private func swipeOffset(_ x: CGFloat, direction: CGFloat) -> CGFloat {
    let along = max(0, x * direction)
    return (along > swipeThreshold ? swipeThreshold + (along - swipeThreshold) * 0.3 : along) * direction
}

struct SwipeToAct<Content: View>: View {
    let enabled: Bool
    let onTrigger: () -> Void
    @ViewBuilder let content: Content
    @State private var drag: CGFloat = 0

    private var armed: Bool { abs(drag) >= swipeThreshold }

    var body: some View {
        content
            .offset(x: drag)
            .zIndex(drag == 0 ? 0 : 1)
            .gesture(KeepPan(direction: -1, enabled: enabled, changed: { drag = swipeOffset($0, direction: -1) }, ended: { _ in
                let fire = armed
                withAnimation(.spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
                if fire { onTrigger() }
            }))
            .sensoryFeedback(.impact(weight: .medium), trigger: armed) { _, now in now }
    }
}

struct SwipeToKeep<Content: View>: View {
    let destination: Page
    let onLand: () -> Void
    let onKeep: () -> Void
    @ViewBuilder let content: (_ send: @escaping () -> Void) -> Content
    @Environment(\.keepTargets) private var targets
    @Environment(\.keepPull) private var pull
    @State private var drag: CGFloat = 0
    @State private var center: CGPoint = .zero
    @State private var flight: CGSize = .zero
    @State private var phase = Phase.resting
    @State private var height: CGFloat?
    @State private var collapsed = false

    private enum Phase { case resting, flying, fading, gone }

    private var direction: CGFloat { destination == .panel ? -1 : 1 }
    private var progress: CGFloat { min(abs(drag) / swipeThreshold, 1) }
    private var armed: Bool { abs(drag) >= swipeThreshold }

    private var scale: CGFloat {
        switch phase {
        case .resting: 1 - 0.04 * progress
        case .flying: 0.1
        case .fading: 0.86
        case .gone: 0.1
        }
    }

    var body: some View {
        content(sendInPlace)
            .rotationEffect(.degrees(Double(drag) / 36))
            .scaleEffect(scale)
            .opacity(phase == .resting ? 1 : 0)
            .offset(x: drag + flight.width, y: flight.height)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if !collapsed { height = $0 } }
            .frame(height: collapsed ? 0 : height, alignment: .top)
            .zIndex(phase == .resting && drag == 0 ? 0 : 1)
            .onGeometryChange(for: CGPoint.self) { proxy in
                let frame = proxy.frame(in: .global)
                return CGPoint(x: frame.midX, y: frame.midY)
            } action: { center = $0 }
            .gesture(KeepPan(direction: direction, enabled: phase == .resting, changed: change, ended: end))
            .sensoryFeedback(.impact(weight: .medium), trigger: armed) { _, now in now }
    }

    private func change(_ x: CGFloat) {
        drag = swipeOffset(x, direction: direction)
        pull(destination, progress)
    }

    private func end(_ velocity: CGFloat) {
        guard armed || velocity * direction > 900 else {
            pull(destination, 0)
            withAnimation(.spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
            return
        }
        let target = targets[destination] ?? CGPoint(x: center.x + direction * 200, y: 0)
        withAnimation(.easeIn(duration: 0.34)) {
            flight = CGSize(width: target.x - center.x - drag, height: target.y - center.y)
            phase = .flying
        }
        Task {
            try? await Task.sleep(for: .milliseconds(340))
            pull(destination, 0)
            phase = .gone
            await settle()
        }
    }

    private func sendInPlace() {
        guard phase == .resting else { return }
        withAnimation(.easeOut(duration: 0.28)) { phase = .fading }
        Task {
            try? await Task.sleep(for: .milliseconds(280))
            await settle()
        }
    }

    private func settle() async {
        onLand()
        try? await Task.sleep(for: .milliseconds(200))
        withAnimation(.spring(duration: 0.55, bounce: 0.28)) { collapsed = true }
        try? await Task.sleep(for: .milliseconds(520))
        onKeep()
    }
}

private struct KeepPan: UIGestureRecognizerRepresentable {
    let direction: CGFloat
    let enabled: Bool
    let changed: (CGFloat) -> Void
    let ended: (CGFloat) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator(direction: direction, enabled: enabled)
    }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ recognizer: UIPanGestureRecognizer, context: Context) {
        context.coordinator.direction = direction
        context.coordinator.enabled = enabled
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        switch recognizer.state {
        case .changed: changed(recognizer.translation(in: recognizer.view).x)
        case .ended, .cancelled, .failed: ended(recognizer.velocity(in: recognizer.view).x)
        default: break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var direction: CGFloat
        var enabled: Bool

        init(direction: CGFloat, enabled: Bool) {
            self.direction = direction
            self.enabled = enabled
        }

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard enabled, let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y) && velocity.x * direction > 0
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other.view is UIScrollView
        }
    }
}
