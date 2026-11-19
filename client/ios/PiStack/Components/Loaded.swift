import SwiftUI

struct Loaded<Value, Content: View>: View {
    var cached: () async -> Value? = { nil }
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
            if value == nil {
                let cachedValue = await cached()
                guard !Task.isCancelled else { return }
                value = cachedValue
            }
            do {
                let loaded = try await load()
                guard !Task.isCancelled else { return }
                value = loaded
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }
}
