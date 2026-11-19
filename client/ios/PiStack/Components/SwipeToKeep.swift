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

struct SwipeToKeep<Content: View>: View {
    let destination: Page
    let onLand: () -> Void
    let onKeep: () -> Void
    var holdRow: (Bool) -> Void = { _ in }
    var sending = false
    var confirmed = false
    var retainsCard = false
    var enabled = true
    @ViewBuilder let content: (_ send: @escaping () -> Void) -> Content
    @Environment(\.keepTargets) private var targets
    @Environment(\.keepPull) private var pull
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0
    @State private var center: CGPoint = .zero
    @State private var flight: CGSize = .zero
    @State private var phase = Phase.resting
    @State private var animationID: UUID?

    private enum Phase { case resting, flying, fading, waiting, collapsing }

    private var direction: CGFloat { destination == .panel ? -1 : 1 }
    private var progress: CGFloat { min(abs(drag) / swipeThreshold, 1) }
    private var armed: Bool { abs(drag) >= swipeThreshold }

    private var scale: CGFloat {
        switch phase {
        case .resting: reduceMotion ? 1 : 1 - 0.04 * progress
        case .flying: 0.1
        case .fading: reduceMotion ? 1 : 0.86
        case .waiting, .collapsing: 1
        }
    }

    var body: some View {
        content(sendInPlace)
            .rotationEffect(.degrees(reduceMotion ? 0 : Double(drag) / 36))
            .scaleEffect(scale)
            .opacity(phase == .resting ? 1 : 0)
            .offset(x: drag + flight.width, y: flight.height)
            .allowsHitTesting(phase == .resting)
            .accessibilityHidden(phase != .resting)
            .overlay {
                if (phase == .waiting || phase == .resting) && sending && !confirmed {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("正在收藏…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .background(.regularMaterial, in: .capsule)
                    .allowsHitTesting(false)
                }
            }
            .zIndex(phase == .resting && drag == 0 ? 0 : 1)
            .onGeometryChange(for: CGPoint.self) { proxy in
                let frame = proxy.frame(in: .global)
                return CGPoint(x: frame.midX, y: frame.midY)
            } action: { center = $0 }
            .gesture(KeepPan(direction: direction, enabled: enabled && phase == .resting, changed: change, ended: end, cancelled: reset))
            .onChange(of: phase) { settle() }
            .onChange(of: sending) { settle() }
            .onChange(of: confirmed) { settle() }
            .onChange(of: enabled) {
                if !enabled && phase == .resting && drag != 0 { reset() }
            }
            .onDisappear {
                if phase == .resting && drag != 0 { pull(destination, 0) }
                if phase != .resting && phase != .collapsing { holdRow(false) }
                animationID = nil
                phase = .resting
                drag = 0
                flight = .zero
            }
            .sensoryFeedback(.impact(weight: .medium), trigger: armed) { _, now in now }
    }

    private func change(_ x: CGFloat) {
        guard enabled, phase == .resting else { return }
        drag = swipeOffset(x, direction: direction)
        if !reduceMotion { pull(destination, progress) }
    }

    private func reset() {
        guard phase == .resting else { return }
        pull(destination, 0)
        withAnimation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
    }

    private func end(_ translation: CGFloat, velocity: CGFloat) {
        guard enabled, phase == .resting else { return }
        drag = swipeOffset(translation, direction: direction)
        guard armed || velocity * direction > 900 else {
            reset()
            return
        }
        submit(fromSwipe: true)
    }

    private func sendInPlace() {
        submit(fromSwipe: false)
    }

    private func submit(fromSwipe: Bool) {
        guard enabled, phase == .resting, animationID == nil else { return }
        if retainsCard {
            reset()
            onKeep()
            return
        }

        let flies = fromSwipe && !reduceMotion
        let target = targets[destination] ?? CGPoint(x: center.x + direction * 200, y: 0)
        let next: Phase = flies ? .flying : .fading
        let animation: Animation = flies ? .easeIn(duration: 0.34) : .easeOut(duration: reduceMotion ? 0.15 : 0.28)
        let id = UUID()
        animationID = id
        pull(destination, 0)
        holdRow(true)
        onKeep()
        withAnimation(animation, completionCriteria: .logicallyComplete) {
            if flies {
                flight = CGSize(width: target.x - center.x - drag, height: target.y - center.y)
            }
            phase = next
        } completion: {
            guard animationID == id else { return }
            animationID = nil
            drag = 0
            flight = .zero
            phase = .waiting
        }
    }

    private func settle() {
        if phase == .collapsing && !confirmed {
            phase = .resting
            return
        }
        guard phase == .waiting else { return }
        if confirmed {
            onLand()
            phase = .collapsing
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { holdRow(false) }
        } else if !sending {
            withAnimation(.easeOut(duration: 0.18)) { phase = .resting }
            holdRow(false)
        }
    }
}

private struct KeepPan: UIGestureRecognizerRepresentable {
    let direction: CGFloat
    let enabled: Bool
    let changed: (CGFloat) -> Void
    let ended: (CGFloat, CGFloat) -> Void
    let cancelled: () -> Void

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
        case .changed: changed(recognizer.translation(in: nil).x)
        case .ended: ended(recognizer.translation(in: nil).x, recognizer.velocity(in: nil).x)
        case .cancelled, .failed: cancelled()
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
