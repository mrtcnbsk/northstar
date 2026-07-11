import Foundation

func computeGreeting(name: String) -> String {
    let computed = name.uppercased()
    let interpolated = "\(computed)"
    return interpolated
}
