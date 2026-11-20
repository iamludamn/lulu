import Foundation
import Testing
@testable import LuluKit

@Test func voiceEventsPreservePayload() throws {
    let data = Data(#"{"type":"voice","event":{"type":"response.output_audio.delta","delta":"AQI="}}"#.utf8)
    guard case .voice(let event) = try JSONDecoder().decode(ServerMessage.self, from: data) else {
        Issue.record("Expected voice event")
        return
    }
    #expect(event["type"]?.string == "response.output_audio.delta")
    #expect(event["delta"]?.string == "AQI=")
}
