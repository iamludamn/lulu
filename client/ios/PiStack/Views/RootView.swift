import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let api = model.api {
                if let bot = model.bot {
                    HomeView(bot: bot, api: api)
                        .id(bot.id)
                } else if let error = model.error {
                    ContentUnavailableView {
                        Label("连接失败", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("重试") { Task { await model.resolve() } }
                        NavigationLink("修改服务器") { SettingsView() }
                    }
                    .navigationStackWrapped()
                } else {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background { Wallpaper() }
                }
            } else {
                NavigationStack { SettingsView() }
            }
        }
        .task(id: model.server) { await model.resolve() }
    }
}

private extension View {
    func navigationStackWrapped() -> some View {
        NavigationStack { self }
    }
}
