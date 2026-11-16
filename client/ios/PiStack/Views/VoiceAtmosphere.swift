import SwiftUI

/// A generated cloud texture preserves the reference's light distribution;
/// two GPU passes animate its flow and draw the translucent, integrated rings.
struct VoiceAtmosphere: View {
    let muted: Bool
    let audioLevel: (Date) -> Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var started = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let time = reduceMotion ? 0 : context.date.timeIntervalSince(started)
            let level = reduceMotion ? 0 : audioLevel(context.date)
            GeometryReader { proxy in
                ZStack {
                    Image("VoiceAtmosphere")
                        .resizable()
                        .colorMultiply(Color(red: 0.994, green: 0.968, blue: 0.971))
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .distortionEffect(
                            ShaderLibrary.voiceCloudFlow(.float2(proxy.size), .float(time), .float(level)),
                            maxSampleOffset: CGSize(width: 18, height: 18),
                            isEnabled: !reduceMotion
                        )
                    Rectangle()
                        .fill(.white)
                        .colorEffect(ShaderLibrary.voiceLightRings(.float2(proxy.size), .float(time), .float(level)))
                }
                .clipped()
            }
        }
        .accessibilityLabel(muted ? "已静音的语音柔光" : "随语音变化的柔光和波纹")
    }
}

/// Clear native glass retains the cloud texture; the soft rim gives the lens
/// the milky edge present in the reference without making the whole face opaque.
struct VoiceGlassCircle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .glassEffect(.clear.interactive(), in: .circle)
            .overlay {
                Circle()
                    .fill(LinearGradient(colors: [.white.opacity(0.10), .white.opacity(0.02), .white.opacity(0.24)], startPoint: .top, endPoint: .bottom))
                    .allowsHitTesting(false)
            }
            .overlay {
                Circle()
                    .stroke(LinearGradient(colors: [.white.opacity(0.85), .white.opacity(0.12), .white.opacity(0.65)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1)
                    .blur(radius: 0.35)
                    .allowsHitTesting(false)
            }
    }
}
