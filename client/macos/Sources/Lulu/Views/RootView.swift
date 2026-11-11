import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let api = model.api {
            HomeView(bot: model.bot, api: api).id(api.base)
        } else {
            ZStack {
                Backdrop()
                ServerPage(header: Text("服务器").type(32, .medium, line: 40).padding(.bottom, 26))
                    .frame(width: SettingsView.column)
            }
        }
    }
}
