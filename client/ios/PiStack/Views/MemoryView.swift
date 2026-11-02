import PiStackKit
import SwiftUI

struct MemoryView: View {
    let botId: String
    let api: Api

    var body: some View {
        Loaded(load: { try await api.memory(botId) }) { listing in
            List {
                Section {
                    if listing.files.isEmpty { Text("暂无记忆").foregroundStyle(.secondary) }
                    ForEach(listing.files, id: \.self) { file in
                        NavigationLink {
                            MarkdownDocument(title: (file as NSString).deletingPathExtension) { try await api.memoryFile(botId, path: file) }
                        } label: {
                            Label((file as NSString).deletingPathExtension, systemImage: "doc.text")
                        }
                    }
                } footer: {
                    Text("对话中值得记住的内容，会被定期整理到这些文件。")
                }
                if !listing.commits.isEmpty {
                    Section("最近整理") {
                        ForEach(listing.commits) { commit in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(commit.message.split(separator: "\n").first.map(String.init) ?? "")
                                Text(Date(timeIntervalSince1970: commit.at / 1000).formatted(.relative(presentation: .named)))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("记忆")
        .navigationBarTitleDisplayMode(.inline)
    }
}
