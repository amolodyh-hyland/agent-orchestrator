import Foundation

@main
struct LocaleTests {
    static func main() {
        let locales = ["en_US", "en_GB", "fr_FR", "pt_BR", "ja_JP"]
        precondition(dictationLocaleIdentifier(requested: "en", supported: locales, preferred: "en_GB") == "en_GB")
        precondition(dictationLocaleIdentifier(requested: "en", supported: locales, preferred: "de_DE") == "en_GB")
        precondition(dictationLocaleIdentifier(requested: "ja", supported: locales, preferred: "en_US") == "ja_JP")
        precondition(dictationLocaleIdentifier(requested: "pt-BR", supported: locales, preferred: "en_US") == "pt_BR")
        precondition(dictationLocaleIdentifier(requested: "en-US", supported: locales, preferred: "en_GB") == "en_US")
        precondition(dictationLocaleIdentifier(requested: "en-CA", supported: locales, preferred: "en_US") == nil)
        precondition(dictationLocaleIdentifier(requested: "ko", supported: locales, preferred: "en_US") == nil)
        precondition(dictationLocaleIdentifier(requested: "en", supported: [], preferred: "en_US") == nil)
        print("8 dictation locale checks passed")
    }
}
