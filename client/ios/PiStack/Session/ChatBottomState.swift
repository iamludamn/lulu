import Foundation

struct ChatBottomState: Equatable {
    var pinned = true
    var showJump = false

    mutating func update(distance: CGFloat, userScrolling: Bool) {
        let nearBottom = distance <= 24
        if userScrolling || nearBottom { pinned = nearBottom }
        showJump = distance > 120
    }
}
