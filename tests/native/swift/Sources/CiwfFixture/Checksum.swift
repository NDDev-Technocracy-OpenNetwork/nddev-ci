/// Sums the bytes of `text` modulo 256.
public func checksum(_ text: String) -> Int {
    Array(text.utf8).reduce(0) { ($0 + Int($1)) } % 256
}
