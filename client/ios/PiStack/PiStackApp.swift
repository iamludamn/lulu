import SwiftUI

@main
struct PiStackApp: App {
    @UIApplicationDelegateAdaptor(SpacePush.self) private var push
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
