import Foundation

func dictationLocaleIdentifier(requested: String, supported: [String], preferred: String) -> String? {
    func normalized(_ value: String) -> String {
        Locale.canonicalIdentifier(from: value).replacingOccurrences(of: "_", with: "-").lowercased()
    }
    if let exact = supported.first(where: { normalized($0) == normalized(requested) }) { return exact }
    let locale = Locale(identifier: requested)
    guard locale.regionCode == nil, let language = locale.languageCode else { return nil }
    let candidates = supported.filter { Locale(identifier: $0).languageCode == language }.sorted()
    let region = Locale(identifier: preferred).regionCode
    return candidates.first(where: { Locale(identifier: $0).regionCode == region }) ?? candidates.first
}
