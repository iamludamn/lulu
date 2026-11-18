import PiStackKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var token = ""
    @State private var saveFailed = false

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
                SecureField("连接令牌", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(save)
            } header: {
                Text("服务器")
            } footer: {
                Text("PiStack 服务的地址，对话通过它的 WebSocket 连接。")
            }
            Section {
                Button("连接", action: save).disabled(!valid)
                if saveFailed {
                    Text("无法保存连接令牌到钥匙串").foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("服务器")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            text = model.server
            token = model.api.map { model.chatToken(for: $0.base) } ?? ""
        }
        .onChange(of: text) { previous, current in
            if Api.normalize(previous) != Api.normalize(current) {
                token = Api.normalize(current).map { model.chatToken(for: $0) } ?? ""
            }
        }
    }

    private var valid: Bool {
        guard let url = Api.normalize(text) else { return false }
        return token.isEmpty || url.scheme == "https"
    }

    private func save() {
        guard valid else { return }
        guard model.saveConnection(server: text, token: token.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            saveFailed = true
            return
        }
        dismiss()
    }
}
