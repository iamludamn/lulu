import Foundation

struct ChatBottomState: Equatable {
    private(set) var pinned = true

    var showJump: Bool { !pinned }

    mutating func update(distance: CGFloat, userScrolling: Bool) {
        guard userScrolling else { return }
        if distance > 64 {
            pinned = false
        } else if distance <= 24 {
            pinned = true
        }
    }

    mutating func followLatest() {
        pinned = true
    }
}
