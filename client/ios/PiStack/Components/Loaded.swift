import SwiftUI

struct Loaded<Value, Content: View>: View {
    var cached: () -> Value? = { nil }
    let load: () async throws -> Value
    @ViewBuilder let content: (Value) -> Content
    @State private var value: Value?
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        Group {
            if let value {
                content(value)
            } else if let error {
                ContentUnavailableView {
                    Label("加载失败", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("重试") { attempt += 1 }
                }
            } else {
                ProgressView()
            }
        }
        .task(id: attempt) {
            error = nil
            if value == nil { value = cached() }
            do {
                value = try await load()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
