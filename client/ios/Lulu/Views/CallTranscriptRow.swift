import SwiftUI

struct CallTranscriptRow: View {
    let mine: Bool
    let text: String

    private let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if mine { Spacer(minLength: 64) }
            VStack(alignment: mine ? .trailing : .leading, spacing: 5) {
                Text(mine ? "你" : "lu")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(red: 0.20, green: 0.32, blue: 0.42).opacity(0.8))
                    .padding(.horizontal, 4)
                Text(text)
                    .font(.callout)
                    .lineSpacing(3)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(mine ? Color.white : Color(red: 0.13, green: 0.23, blue: 0.32))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background {
                        if mine {
                            shape.fill(Color(red: 0.27, green: 0.46, blue: 0.66).opacity(0.92))
                        } else {
                            shape.fill(.ultraThinMaterial)
                        }
                    }
                    .overlay { shape.strokeBorder(.white.opacity(mine ? 0.25 : 0.45), lineWidth: 0.5) }
            }
            if !mine { Spacer(minLength: 64) }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(mine ? "你" : "lu")：\(text)")
    }
}
