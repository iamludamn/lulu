import SwiftUI

struct MarkdownDocument: View {
    let title: String
    let load: () async throws -> String

    var body: some View {
        Loaded(load: load) { text in
            ScrollView {
                MarkdownText(text: text, selectable: true, document: true)
                    .lineSpacing(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 24)
                    .background {
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(.clear)
                            .glassEffect(.regular, in: .rect(cornerRadius: 28, style: .continuous))
                    }
                    .frame(maxWidth: 720)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 40)
                    .frame(maxWidth: .infinity)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) { ShareLink(item: text, subject: Text(title)) }
            }
        }
        .background { Wallpaper() }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}
