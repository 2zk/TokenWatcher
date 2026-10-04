import Foundation

enum StorageError: LocalizedError {
    case missingGroup, invalidSnapshot, invalidSettings
    var errorDescription: String? {
        switch self {
        case .missingGroup: return "App Group を利用できません。Xcode で両ターゲットの署名 Team と App Group を設定してください。"
        case .invalidSnapshot: return "共有データを読み取れません。アプリで情報を更新してください。"
        case .invalidSettings: return "設定値が不正です。入力範囲と実行パスを確認してください。"
        }
    }
}
struct SnapshotStore {
    let fileURL: URL
    static func appGroup() throws -> SnapshotStore {
        guard let identifier = Bundle.main.object(forInfoDictionaryKey: "TokenWatcherAppGroup") as? String,
            !identifier.hasPrefix("."), !identifier.contains("$("),
            let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
        else { throw StorageError.missingGroup }
        return SnapshotStore(fileURL: directory.appendingPathComponent("usage-v1.json"))
    }
    func read() throws -> SharedSnapshot {
        do {
            let snapshot = try JSONDecoder().decode(SharedSnapshot.self, from: Data(contentsOf: fileURL))
            guard snapshot.isValid else { throw StorageError.invalidSnapshot }
            return snapshot
        } catch { throw StorageError.invalidSnapshot }
    }
    func write(_ snapshot: SharedSnapshot) throws {
        guard snapshot.isValid else { throw StorageError.invalidSnapshot }
        let data = try JSONEncoder().encode(snapshot)
        try data.write(to: fileURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
    func readForStartup() -> SharedSnapshot {
        guard let snapshot = try? read(), !snapshot.demo else { return SharedSnapshot(demo: false) }
        return snapshot
    }
}
struct SettingsStore {
    let defaults: UserDefaults
    private let key = "TokenWatcher.settings.v1"
    func read() -> AppSettings {
        guard let data = defaults.data(forKey: key),
            var settings = try? JSONDecoder().decode(AppSettings.self, from: data), settings.isValid
        else { return AppSettings() }
        // 初回の取得開始の選択を引き継ぎ、未開始では認証情報へアクセスしない。
        settings.config.demo = !settings.hasStartedLiveData
        return settings
    }
    func write(_ settings: AppSettings) throws {
        guard settings.isValid else { throw StorageError.invalidSettings }
        defaults.set(try JSONEncoder().encode(settings), forKey: key)
    }
}
