import SwiftUI

@main
struct LuluApp: App {
    @UIApplicationDelegateAdaptor(SpacePush.self) private var push
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
