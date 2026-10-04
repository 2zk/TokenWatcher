import Foundation

private final class MemoryDefaults: UserDefaults {
    private var values: [String: Data] = [:]
    override func data(forKey defaultName: String) -> Data? { values[defaultName] }
    override func set(_ value: Any?, forKey defaultName: String) { values[defaultName] = value as? Data }
}
@main
struct ModelChecks {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let sample = SharedSnapshot.sample(at: now)
        precondition(sample.isValid)
        let decoded = try JSONDecoder().decode(SharedSnapshot.self, from: JSONEncoder().encode(sample))
        precondition(decoded.state(for: .codex).snapshot?.primaryLimits(for: .codex).count == 2)
        precondition(decoded.state(for: .claude).snapshot?.primaryLimits(for: .claude)[0]?.remainingPercent == 54)
        let usage = sample.state(for: .codex).snapshot!
        precondition(!usage.isStale(at: now.addingTimeInterval(299)))
        precondition(usage.isStale(at: now.addingTimeInterval(300)))
        let weeklyPrimary = UsageLimit(limitId: "codex", limitName: nil, window: "primary", windowDurationMins: 10080,
            usedPercent: 70, remainingPercent: 30, resetsAtEpochSeconds: now.timeIntervalSince1970 - 1, resetsAt: nil)
        let weekly = UsageSnapshot(schemaVersion: 1, observedAt: ISO8601DateFormatter().string(from: now), limits: [weeklyPrimary], resetCredits: nil)
        precondition(weekly.primaryLimits(for: .codex)[0] == nil)
        precondition(weekly.primaryLimits(for: .codex)[1]?.period == "7日")
        precondition(weekly.isStale(at: now))

        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let store = SnapshotStore(fileURL: directory.appendingPathComponent("sample.json"))
        let missingStore = SnapshotStore(fileURL: directory.appendingPathComponent(UUID().uuidString + ".json"))
        precondition(!missingStore.readForStartup().demo)
        precondition(missingStore.readForStartup().services.allSatisfy { $0.snapshot == nil })
        try store.write(sample)
        precondition(store.readForStartup().services.allSatisfy { $0.snapshot == nil })
        let persisted = try store.read()
        precondition(persisted.isValid)
        let permissions = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)[.posixPermissions] as! NSNumber
        precondition(permissions.intValue == 0o600)
        try Data("{broken".utf8).write(to: store.fileURL)
        do { _ = try store.read(); fatalError("破損JSONを受け入れました") } catch StorageError.invalidSnapshot {}
        precondition(store.readForStartup().services.allSatisfy { $0.snapshot == nil })
        let brokenData = try Data(contentsOf: store.fileURL)
        precondition(brokenData == Data("{broken".utf8))
        var live = sample
        live.demo = false
        try store.write(live)
        let liveData = try Data(contentsOf: store.fileURL)
        let restoredLive = store.readForStartup()
        precondition(!restoredLive.demo)
        precondition(restoredLive.state(for: .claude).snapshot?.observedAt == sample.state(for: .claude).snapshot?.observedAt)
        precondition(restoredLive.state(for: .claude).snapshot?.isStale(at: now.addingTimeInterval(300)) == true)
        let afterRead = try Data(contentsOf: store.fileURL)
        precondition(afterRead == liveData)

        let defaults = MemoryDefaults()
        let settingsStore = SettingsStore(defaults: defaults)
        var settings = AppSettings()
        precondition(!settings.hasStartedLiveData)
        precondition(settingsStore.read().config.demo)
        precondition(settings.showMenuBarIcon)
        settings.showMenuBarIcon = false
        settings.config.demo = false
        settings.hasStartedLiveData = true
        settings.config.services.codex.notifyBelow = 0
        settings.config.services.codex.notifyEvery = 99
        settings.config.services.codex.notifyMethod = .notification
        settings.config.services.codex.notifyExclude = ["codex / primary"]
        try settingsStore.write(settings)
        let restored = settingsStore.read()
        precondition(!restored.config.demo)
        precondition(restored.hasStartedLiveData)
        precondition(!restored.showMenuBarIcon)
        precondition(restored.config.services == settings.config.services)
        var legacySettings = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as! [String: Any]
        legacySettings.removeValue(forKey: "showMenuBarIcon")
        legacySettings.removeValue(forKey: "hasStartedLiveData")
        defaults.set(try JSONSerialization.data(withJSONObject: legacySettings), forKey: "TokenWatcher.settings.v1")
        let migrated = settingsStore.read()
        precondition(migrated.showMenuBarIcon)
        precondition(migrated.hasStartedLiveData && !migrated.config.demo)
        precondition(migrated.nodePath == settings.nodePath)
        precondition(migrated.config.services == settings.config.services)
        var legacyConfig = legacySettings["config"] as! [String: Any]
        legacyConfig["demo"] = true
        legacySettings["config"] = legacyConfig
        defaults.set(try JSONSerialization.data(withJSONObject: legacySettings), forKey: "TokenWatcher.settings.v1")
        let notStarted = settingsStore.read()
        precondition(!notStarted.hasStartedLiveData && notStarted.config.demo)
        settings.config.services.claude.notifyEvery = 100
        do { try settingsStore.write(settings); fatalError("不正設定を保存しました") } catch StorageError.invalidSettings {}
        let config = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BridgeConfig())) as! [String: Any]
        let services = config["services"] as! [String: Any]
        let codex = services["codex"] as! [String: Any]
        precondition(codex["notifyBelow"] is NSNull)
        precondition(codex["notifyEvery"] is NSNull)
        let eventJSON = """
        {"type":"error","service":"claude","demo":false,"diagnostic":{"code":"api_rate_limit","occurredAt":"2026-10-04T02:20:00Z","source":"api","httpStatus":429,"retryAfterSeconds":600,"retryNotBefore":"2026-10-04T02:30:00Z","nextAttemptAt":"2026-10-04T02:32:00Z"}}
        """
        let event = try JSONDecoder().decode(BridgeEvent.self, from: Data(eventJSON.utf8))
        var history = DiagnosticHistory()
        history.record(service: event.service, detail: event.diagnostic!)
        precondition(history.text.contains("HTTP ステータス: 429"))
        precondition(history.text.contains("API の待機指定: 600秒"))
        precondition(history.text.contains("次の自動取得予定"))
        let success = BridgeDiagnostic(code: .success, occurredAt: "2026-10-04T02:32:00Z")
        history.record(service: .claude, detail: success)
        precondition(history.entries.count == 2)
        precondition(history.text.contains("呼び出し回数制限"))
        var unsafe = success
        unsafe.networkCode = "secret token"
        history.record(service: .claude, detail: unsafe)
        precondition(history.entries.count == 2)
        precondition(!history.text.contains("secret"))
        for _ in 0..<100 { history.record(service: .codex, detail: success) }
        precondition(history.entries.count == 100)
        precondition(history.entries.first?.service == .codex)
        // 詳細ログは共有JSONに追加しない。旧形式のイベントも読める。
        let sharedJSON = String(data: try JSONEncoder().encode(sample), encoding: .utf8)!
        precondition(!sharedJSON.contains("diagnostic"))
        let legacyEvent = try JSONDecoder().decode(BridgeEvent.self, from: Data("{\"type\":\"error\",\"service\":\"claude\"}".utf8))
        precondition(legacyEvent.diagnostic == nil)
        print("共有JSON・起動時復元・鮮度・期間判定・設定移行・詳細ログのチェックに成功")
    }
}
