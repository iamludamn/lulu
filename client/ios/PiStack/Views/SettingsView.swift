import PiStackKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        Form {
            Section {
                TextField("https://example.com", text: $text)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(save)
            } header: {
                Text("服务器")
            } footer: {
                Text("PiStack 服务的地址，对话通过它的 WebSocket 连接。")
            }
            Section {
                Button("连接", action: save).disabled(!valid)
            }
        }
        .navigationTitle("服务器")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { text = model.server }
    }

    private var valid: Bool { Api.normalize(text) != nil }

    private func save() {
        guard valid else { return }
        model.server = text
        dismiss()
    }
}
