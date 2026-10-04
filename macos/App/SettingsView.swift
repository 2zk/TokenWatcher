import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var draft = AppSettings()
    @State private var saved = false
    var body: some View {
        VStack(spacing: 0) {
            TabView {
                Form {
                    Toggle("メニューバーにアイコンを表示", isOn: $draft.showMenuBarIcon)
                    Text("非表示でも Dock のアイコンやウィジェット全体のクリックでアプリを開けます。ウィンドウを閉じても、アプリを終了するまで取得と通知を続けます。")
                        .font(.caption).foregroundStyle(.secondary)
                }.formStyle(.grouped).tabItem { Text("一般") }
                ForEach(UsageService.allCases) { service in
                    NotificationSettingsView(settings: Binding(
                        get: { draft.config.services[service] }, set: { draft.config.services[service] = $0 }
                    )).tabItem { Text(service.title + " 通知") }
                }
                Form {
                    TextField("Node.js の絶対パス", text: $draft.nodePath)
                    TextField("Codex の実行パス", text: $draft.config.codexBin)
                    Stepper("取得間隔: \(draft.config.intervalSeconds)秒", value: $draft.config.intervalSeconds, in: 60...86400, step: 60)
                    Stepper("Codex 待機時間: \(draft.config.timeoutSeconds)秒", value: $draft.config.timeoutSeconds, in: 1...300)
                    Picker("Claude の取得元", selection: $draft.config.claudeSource) {
                        Text("auto: API、失敗時はキャッシュ").tag("auto")
                        Text("api: API のみ").tag("api")
                        Text("statusline: キャッシュのみ").tag("statusline")
                    }
                    Text("Node.js は同梱していません。Intel Mac などでは /usr/local/bin/node を指定してください。")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("初回の情報取得はメイン画面から開始します。開始後は、再起動時に前回の実データを表示して自動で取得します。")
                        .font(.caption).foregroundStyle(.secondary)
                }.formStyle(.grouped).tabItem { Text("取得") }
            }.padding(16)
            Divider()
            HStack {
                Text(saved ? "設定を保存しました。" : draft.isValid ? "変更は「保存」で反映します。" : "空の除外パターンや実行パスを確認してください。")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("保存") {
                    draft.hasStartedLiveData = model.settings.hasStartedLiveData
                    draft.config.demo = model.settings.config.demo
                    model.apply(draft)
                    saved = true
                }.buttonStyle(.borderedProminent).disabled(!draft.isValid)
            }.padding(16)
        }
        .onAppear { draft = model.settings }
        .onChange(of: draft) { _, _ in saved = false }
    }
}
private struct NotificationSettingsView: View {
    @Binding var settings: NotificationSettings
    var body: some View {
        Form {
            Section("通知方法") {
                Picker("表示方法", selection: $settings.notifyMethod) {
                    ForEach(NotificationMethod.allCases) { method in Text(method.title).tag(method) }
                }
                Text("通知センター方式では、macOS の通知許可と表示設定も適用されます。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("通知する条件") {
                Toggle("指定残量以下で通知", isOn: Binding(
                    get: { settings.notifyBelow != nil }, set: { settings.notifyBelow = $0 ? 20 : nil }
                ))
                if settings.notifyBelow != nil {
                    Stepper("残量 \(settings.notifyBelow ?? 20)％以下", value: Binding(
                        get: { settings.notifyBelow ?? 20 }, set: { settings.notifyBelow = $0 }
                    ), in: 0...100)
                }
                Toggle("残量が一定割合減るごとに通知", isOn: Binding(
                    get: { settings.notifyEvery != nil }, set: { settings.notifyEvery = $0 ? 20 : nil }
                ))
                if settings.notifyEvery != nil {
                    Stepper("\(settings.notifyEvery ?? 20)％減るごと", value: Binding(
                        get: { settings.notifyEvery ?? 20 }, set: { settings.notifyEvery = $0 }
                    ), in: 1...99)
                }
                Toggle("情報取得エラーを通知", isOn: $settings.notifyApiError)
                Text("残量通知が有効な場合は、リセット後の残量回復も通知します。条件変更時は現在値を基準にし、設定変更だけでは通知しません。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("通知から除外") {
                ForEach(settings.notifyExclude.indices, id: \.self) { index in
                    HStack {
                        TextField("例: claude / five_hour", text: Binding(
                            get: { settings.notifyExclude.indices.contains(index) ? settings.notifyExclude[index] : "" },
                            set: { if settings.notifyExclude.indices.contains(index) { settings.notifyExclude[index] = $0 } }
                        ))
                        Button {
                            if settings.notifyExclude.indices.contains(index) { settings.notifyExclude.remove(at: index) }
                        } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless).accessibilityLabel("除外を解除")
                    }
                }
                Button("除外パターンを追加") { settings.notifyExclude.append("") }
                Text("表示名と期間への部分一致。大文字・小文字は区別しません。除外した制限もウィジェットと詳細画面には表示します。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Text("通知対象は取得できた全制限です。ウィジェットに表示しないモデル別制限も含みます。CLI の通知設定は独立しており、併用すると二重通知になる場合があります。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
}
