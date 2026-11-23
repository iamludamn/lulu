import SwiftUI
import UIKit

extension EnvironmentValues {
    @Entry var keepTargets: [Page: CGPoint] = [:]
    @Entry var keepPull: (Page, CGFloat) -> Void = { _, _ in }
    @Entry var topInset: CGFloat = 0
}

struct SwipeToKeep<Content: View>: View {
    let destination: Page
    let onLand: () -> Void
    let onKeep: () -> Void
    var holdRow: (Bool) -> Void = { _ in }
    var sending = false
    var confirmed = false
    var horizontalExit = false
    var failed = false
    var pendingLabel = "正在收藏…"
    var enabled = true
    @ViewBuilder let content: (_ send: @escaping () -> Void, _ armed: Bool) -> Content
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
    private var swipeThreshold: CGFloat { horizontalExit ? 84 : 90 }
    private var progress: CGFloat { min(abs(drag) / swipeThreshold, 1) }
    private var armed: Bool { abs(drag) >= swipeThreshold }
    private var showsPending: Bool {
        guard !confirmed else { return false }
        return (phase == .waiting && (horizontalExit || sending)) || (phase == .resting && sending)
    }

    private var scale: CGFloat {
        if horizontalExit { return 1 }
        return switch phase {
        case .resting: reduceMotion ? 1 : 1 - 0.04 * progress
        case .flying: 0.1
        case .fading: reduceMotion ? 1 : 0.86
        case .waiting, .collapsing: 1
        }
    }

    var body: some View {
        content(sendInPlace, armed)
            .rotationEffect(.degrees(horizontalExit || reduceMotion ? 0 : Double(drag) / 36))
            .scaleEffect(scale)
            .opacity(phase == .resting ? 1 : 0)
            .offset(x: drag + flight.width, y: flight.height)
            .allowsHitTesting(phase == .resting)
            .accessibilityHidden(phase != .resting)
            .overlay {
                if showsPending {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(pendingLabel)
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
            .onChange(of: failed) { settle() }
            .onChange(of: enabled) {
                if !enabled && phase == .resting && drag != 0 { reset() }
            }
            .onDisappear {
                if !horizontalExit && phase == .resting && drag != 0 { pull(destination, 0) }
                if phase != .resting && phase != .collapsing { holdRow(false) }
                animationID = nil
                phase = .resting
                drag = 0
                flight = .zero
            }
            .sensoryFeedback(.impact(weight: horizontalExit ? .light : .medium), trigger: armed) { _, now in now }
    }

    private func swipeOffset(_ x: CGFloat) -> CGFloat {
        let distance = max(0, x * direction)
        let resistance = horizontalExit ? 0.22 : 0.3
        return (min(distance, swipeThreshold) + max(0, distance - swipeThreshold) * resistance) * direction
    }

    private func change(_ x: CGFloat) {
        guard enabled, phase == .resting else { return }
        drag = swipeOffset(x)
        if !horizontalExit && !reduceMotion { pull(destination, progress) }
    }

    private func reset() {
        guard phase == .resting else { return }
        if !horizontalExit { pull(destination, 0) }
        let rebound: Animation = horizontalExit ? .spring(duration: 0.22, bounce: 0.18) : .spring(duration: 0.35, bounce: 0.3)
        withAnimation(reduceMotion ? nil : rebound) { drag = 0 }
    }

    private func end(_ translation: CGFloat, velocity: CGFloat) {
        guard enabled, phase == .resting else { return }
        drag = swipeOffset(translation)
        guard armed || (!horizontalExit && velocity * direction > 900) else {
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
        let slides = horizontalExit && fromSwipe && !reduceMotion
        let flies = !horizontalExit && fromSwipe && !reduceMotion
        let next: Phase = flies ? .flying : .fading
        let animation: Animation
        if slides { animation = .timingCurve(0.18, 0.55, 0.5, 1, duration: 0.19) }
        else if flies { animation = .easeIn(duration: 0.34) }
        else { animation = .easeOut(duration: reduceMotion ? 0.15 : 0.28) }
        let id = UUID()
        animationID = id
        if !horizontalExit { pull(destination, 0) }
        holdRow(true)
        onKeep()
        withAnimation(animation, completionCriteria: .logicallyComplete) {
            if slides {
                flight = CGSize(width: direction * 84, height: 0)
            } else if flies {
                let target = targets[destination] ?? CGPoint(x: center.x + direction * 200, y: 0)
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
            withAnimation(reduceMotion ? nil : .easeOut(duration: horizontalExit ? 0.19 : 0.25)) { holdRow(false) }
        } else if failed || (!horizontalExit && !sending) {
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
