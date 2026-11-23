import SwiftUI

@main
struct LuluApp: App {
    @UIApplicationDelegateAdaptor(SpacePush.self) private var push
    @State private var model = AppModel(mockData: Self.mockData)

    private static var mockData: Bool {
        #if DEBUG && targetEnvironment(simulator) && LULU_NOTE_MOCK_DATA
        true
        #else
        false
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}
