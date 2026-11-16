import CenterCore
import SwiftUI

/// Interface language: "System language" or one of the supported languages,
/// each in its own name. Changing it switches the app at once, no restart.
struct LanguagePicker: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Picker(L.t("Dil"), selection: Binding<String>(
            get: { model.settings.language ?? "system" },
            set: { model.setLanguage($0 == "system" ? nil : $0) })) {
            Text(L.f("Sistem dili ({0})", L.languages.first { $0.code == L.resolve(nil) }?.name ?? "English")).tag("system")
            Divider()
            ForEach(L.languages, id: \.code) { Text($0.name).tag($0.code) }
        }
    }
}
