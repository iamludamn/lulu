import SwiftUI

@main
struct PiStackApp: App {
    #if !(DEBUG && targetEnvironment(simulator) && LULU_NOTE_PROTOTYPE)
    @UIApplicationDelegateAdaptor(SpacePush.self) private var push
    @State private var model = AppModel()
    #endif

    var body: some Scene {
        WindowGroup {
            #if DEBUG && targetEnvironment(simulator) && LULU_NOTE_PROTOTYPE
            NotePrototypeView()
            #else
            RootView()
                .environment(model)
            #endif
        }
    }
}
