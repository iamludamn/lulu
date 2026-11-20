import PiStackKit
import SwiftUI
import UIKit.UIGestureRecognizerSubclass

struct PanelView: View {
    let widgets: [PanelWidget]
    let spaceUpdates: [String: SpaceUpdate]
    let botName: String
    let botId: String
    let api: Api
    let onPrompt: (String) -> Void
    let onDraft: (String) -> Void
    let onDrop: (String) -> Void
    let onCheck: (String, Int, Bool) -> Void
    let onCompose: () -> Void
    @Environment(\.topInset) private var topInset

    private static let ideas = ["今天 18:30 提醒我取快递", "做一份出发前的待办清单"]

    private var visibleWidgets: [PanelWidget] { widgets.filter { $0.pendingChecklistCount != 0 } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 19) {
                HomePageHeading(title: "四时风物", subtitle: "关注事项")
                    .frame(maxWidth: 740)
                    .padding(.horizontal, 18)
                    .frame(maxWidth: .infinity)
                if visibleWidgets.isEmpty {
                    empty
                } else {
                    LazyVStack(spacing: 12) {
                        ForEach(rows(visibleWidgets), id: \.first!.id) { row in
                            HStack(alignment: .top, spacing: 12) {
                                ForEach(row) { widget in
                                    WidgetCard(widget: widget, update: spaceUpdates[widget.id], botId: botId, api: api, onPrompt: onPrompt, onDrop: onDrop, onCheck: { onCheck(widget.id, $0, $1) })
                                }
                                if row.count == 1 && row[0].size == .s && !row[0].isSpace { Color.clear.frame(maxWidth: .infinity) }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 32)
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                    .animation(.snappy, value: visibleWidgets.map(\.id))
                }
            }
            .padding(.top, 7)
        }
        .contentMargins(.top, topInset, for: .scrollContent)
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    }

    private var composer: some View {
        Button(action: onCompose) {
            Text("给 \(botName) 发消息")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.vertical, 13)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .composerChrome()
    }

    private func rows(_ widgets: [PanelWidget]) -> [[PanelWidget]] {
        var result: [[PanelWidget]] = []
        for widget in widgets {
            if widget.size == .s, !widget.isSpace, let last = result.last, last.count == 1, last[0].size == .s, !last[0].isSpace {
                result[result.count - 1].append(widget)
            } else {
                result.append([widget])
            }
        }
        return result
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("在对话里告诉 \(botName) 想关注什么。它发来的组件卡片，左滑就能放到这里。")
                .font(.title3)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Self.ideas, id: \.self) { idea in
                    Button { onDraft(idea) } label: {
                        Label(idea, systemImage: "plus").font(.subheadline.weight(.medium)).padding(.horizontal, 4).padding(.vertical, 4)
                    }
                    .buttonStyle(.glass)
                    .tint(.primary)
                }
            }
        }
        .frame(maxWidth: 740, alignment: .leading)
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity)
    }
}

struct WidgetFace: View {
    let widget: PanelWidget
    let botId: String
    let api: Api
    var interactive = false
    var onPrompt: (String) -> Void = { _ in }
    var onCheck: (Int, Bool) -> Void = { _, _ in }

    /// Two rows of the 158pt cards and the gap between them.
    static let spaceHeight: CGFloat = 328

    private var checklistCount: Int? { interactive ? widget.pendingChecklistCount : nil }

    private var isSchedule: Bool {
        if case .schedules = widget.body { return true }
        return false
    }

    private var height: CGFloat? {
        if widget.isSpace { return Self.spaceHeight }
        if checklistCount != nil || isSchedule { return nil }
        return switch widget.size {
        case .s, .m: 158
        case .l: nil
        }
    }

    private var minHeight: CGFloat? {
        if widget.isSpace { return Self.spaceHeight }
        return widget.size == .l && checklistCount == nil && !isSchedule ? 300 : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !widget.isSpace && !isSchedule { header }
            WidgetBody(widget: widget, botId: botId, api: api, interactive: interactive, onPrompt: onPrompt, onCheck: onCheck)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .padding(widget.isSpace ? 0 : 14)
        .frame(maxWidth: .infinity, minHeight: minHeight, maxHeight: height, alignment: .topLeading)
        .clipShape(.rect(cornerRadius: 26, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 6) {
            if let icon = widget.icon ?? (widget.isSpace ? "square.stack.3d.up" : nil) {
                Image(systemName: icon).foregroundStyle(widget.tone?.color ?? .secondary)
            }
            Text(widget.title).lineLimit(1)
            Spacer(minLength: 4)
            if widget.isSpace {
                Text("Space")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.14), in: .capsule)
            }
            if let checklistCount {
                Text("还剩 \(checklistCount) 项").font(.caption.monospacedDigit())
            } else if widget.size != .s || widget.isSpace, let updatedAt = widget.updatedAt {
                Text(Date(timeIntervalSince1970: updatedAt / 1000), format: .relative(presentation: .named))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.secondary)
    }
}

private struct WidgetCard: View {
    let widget: PanelWidget
    let update: SpaceUpdate?
    let botId: String
    let api: Api
    let onPrompt: (String) -> Void
    let onDrop: (String) -> Void
    let onCheck: (Int, Bool) -> Void
    @Environment(\.openSpace) private var openSpace

    var body: some View {
        let card = WidgetFace(widget: widget, botId: botId, api: api, interactive: true, onPrompt: onPrompt, onCheck: onCheck)
            .frosted(26)
            .overlay(alignment: .topTrailing) {
                if update?.hasNewContent == true {
                    Circle().fill(Color.accentColor)
                        .frame(width: 10, height: 10)
                        .padding(15)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(.rect(cornerRadius: 26, style: .continuous))
            .contextMenu {
                if widget.isSpace && (update == nil || update?.mode.kind == "manual") {
                    Button("刷新", systemImage: "arrow.clockwise") { NotificationCenter.default.post(name: .spaceRefresh, object: widget.id) }
                }
                if let origin = widget.origin {
                    Button("删除小组件", systemImage: "trash", role: .destructive) { onDrop(origin) }
                }
            }
        if let (page, refresh) = space {
            Button { openSpace(page, SpaceOpening(id: widget.id, title: widget.title, refresh: refresh), "space-\(widget.id)") } label: { card }
                .accessibilityLabel(widget.title)
                .accessibilityValue(update?.hasNewContent == true ? "有新内容" : "")
                .buttonStyle(.plain)
                .overlay {
                    SpacePressFeedback()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                .artifactSource("space-\(widget.id)", radius: 26)
        } else {
            card
        }
    }

    private var space: (ArtifactAddress, SpaceRefresh)? {
        guard case .space(let src, _, let refresh, _) = widget.body, let page = ArtifactAddress(src) else { return nil }
        return (page, refresh)
    }
}


private struct SpacePressFeedback: UIViewRepresentable {
    func makeUIView(context: Context) -> Surface { Surface(frame: .zero) }
    func updateUIView(_ view: Surface, context: Context) {}
    static func dismantleUIView(_ view: Surface, coordinator: ()) { view.detach() }

    final class Surface: UIView {
        private lazy var observer = TouchObserver(self)

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            backgroundColor = UIColor.label.withAlphaComponent(0.12)
            layer.cornerRadius = 26
            layer.cornerCurve = .continuous
            alpha = 0
        }

        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            attach()
        }

        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            attach()
        }

        private func attach() {
            var ancestor = superview
            while let view = ancestor, !(view is UIScrollView) {
                ancestor = view.superview
            }
            let target = window == nil ? nil : ancestor ?? window
            guard observer.view !== target else { return }
            detach()
            target?.addGestureRecognizer(observer)
        }

        func detach() {
            observer.view?.removeGestureRecognizer(observer)
            setPressed(false)
        }

        func setPressed(_ pressed: Bool, animated: Bool = false) {
            if animated && !UIAccessibility.isReduceMotionEnabled {
                UIView.animate(withDuration: 0.09, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseOut]) {
                    self.alpha = 0
                }
            } else {
                layer.removeAllAnimations()
                alpha = pressed ? 1 : 0
            }
        }
    }

    final class TouchObserver: UIGestureRecognizer {
        private weak var surface: Surface?
        private var origin: CGPoint?

        init(_ surface: Surface) {
            self.surface = surface
            super.init(target: nil, action: nil)
            cancelsTouchesInView = false
            delaysTouchesBegan = false
            delaysTouchesEnded = false
        }

        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard origin == nil, let surface, let touch = touches.first,
                  surface.window === touch.window, view?.bounds.contains(touch.location(in: view)) == true else {
                finish()
                return
            }
            let point = touch.location(in: surface)
            guard surface.bounds.contains(point) else {
                finish()
                return
            }
            origin = point
            surface.setPressed(true)
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let surface, let origin, let point = touches.first?.location(in: surface) else { return }
            if !surface.bounds.contains(point) || hypot(point.x - origin.x, point.y - origin.y) >= 10 { finish() }
        }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { finish(released: true) }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { finish() }

        override func reset() {
            clear()
            super.reset()
        }

        private func finish(released: Bool = false) {
            clear(released: released)
            state = .failed
        }

        private func clear(released: Bool = false) {
            guard origin != nil else { return }
            origin = nil
            surface?.setPressed(false, animated: released)
        }
    }
}
