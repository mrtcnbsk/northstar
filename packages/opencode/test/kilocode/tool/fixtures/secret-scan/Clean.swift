import Foundation

struct UserProfile {
    let displayName: String
    let avatarURL: URL?

    func greeting() -> String {
        "Hello, \(displayName)!"
    }
}

enum Environment {
    static let baseURL = "https://api.example.com"
    static let requestTimeout: TimeInterval = 30
}
