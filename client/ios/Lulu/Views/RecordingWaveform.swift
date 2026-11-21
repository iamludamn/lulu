import SwiftUI

/// Shows the recent microphone levels in the same footprint as the tab switcher.
struct RecordingWaveform: View {
    let levels: [CGFloat]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .frame(width: 2, height: 3 + 25 * levels[index])
            }
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.linear(duration: 0.08), value: levels)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("正在录音")
    }
}
