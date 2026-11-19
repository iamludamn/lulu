import SwiftUI
import UIKit

struct VoicePresentation<Atmosphere: View, Controls: View>: UIViewControllerRepresentable {
    let isPresented: Bool
    let duration: TimeInterval
    let atmosphere: Atmosphere?
    let controls: Controls?

    func makeUIViewController(context: Context) -> Controller {
        Controller()
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.update(isPresented: isPresented, duration: duration, atmosphere: atmosphere, controls: controls)
    }

    final class Controller: UIViewController {
        private let atmosphere = UIHostingController<Atmosphere?>(rootView: nil)
        private let controls = UIHostingController<Controls?>(rootView: nil)
        private var isPresented = false
        private var revision = 0
        private let fadeKey = "voiceOpacity"

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .clear
            view.isUserInteractionEnabled = false
            view.accessibilityElementsHidden = true
            embed(atmosphere, top: view.topAnchor)
            embed(controls, top: view.safeAreaLayoutGuide.topAnchor)
            atmosphere.view.isUserInteractionEnabled = false
        }

        func update(isPresented: Bool, duration: TimeInterval, atmosphere: Atmosphere?, controls: Controls?) {
            if isPresented {
                self.atmosphere.rootView = atmosphere
                self.controls.rootView = controls
            }
            guard isPresented != self.isPresented else { return }
            self.isPresented = isPresented
            revision += 1
            let revision = revision
            view.isUserInteractionEnabled = isPresented
            view.accessibilityElementsHidden = !isPresented
            if isPresented {
                self.atmosphere.view.layer.removeAnimation(forKey: fadeKey)
                setOpacity(1, of: self.atmosphere.view.layer)
                fade(self.controls.view.layer, from: 0, to: 1, duration: duration)
            } else {
                self.controls.view.layer.removeAnimation(forKey: fadeKey)
                setOpacity(0, of: self.controls.view.layer)
                self.controls.rootView = nil
                fade(self.atmosphere.view.layer, from: 1, to: 0, duration: duration) { [weak self] in
                    Task { @MainActor [weak self] in
                        guard let self, self.revision == revision else { return }
                        self.atmosphere.rootView = nil
                    }
                }
            }
        }

        private func embed(_ child: UIHostingController<some View>, top: NSLayoutYAxisAnchor) {
            addChild(child)
            child.safeAreaRegions = []
            child.view.backgroundColor = .clear
            child.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child.view)
            NSLayoutConstraint.activate([
                child.view.topAnchor.constraint(equalTo: top),
                child.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                child.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                child.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            child.didMove(toParent: self)
        }

        private func setOpacity(_ opacity: Float, of layer: CALayer) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.opacity = opacity
            CATransaction.commit()
        }

        private func fade(_ layer: CALayer, from: Float, to: Float, duration: TimeInterval, completion: (() -> Void)? = nil) {
            let animation = CABasicAnimation(keyPath: "opacity")
            animation.fromValue = from
            animation.toValue = to
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            CATransaction.setCompletionBlock(completion)
            layer.opacity = to
            layer.add(animation, forKey: fadeKey)
            CATransaction.commit()
        }
    }
}
