import AppKit
import Combine
import WidgetKit

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()
    @Published var settings: AppSettings
    @Published var snapshot = SharedSnapshot(demo: false)
    @Published var status = "情報取得を開始してください"
    @Published var storageError: String?
    @Published var notificationError: String?
    @Published var running = false
    @Published var diagnosticHistory = DiagnosticHistory()
    private let settingsStore: SettingsStore
    private var snapshotStore: SnapshotStore?
    private var process: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var generation = UUID()
    private var wantsRunning = false
    private var wakeObserver: Any?
    private let notifications = NotificationDispatcher()

    init(settingsStore: SettingsStore = SettingsStore(defaults: .standard), snapshotStore: SnapshotStore? = nil) {
        self.settingsStore = settingsStore
        var loaded = settingsStore.read()
        if !FileManager.default.isExecutableFile(atPath: loaded.nodePath),
            FileManager.default.isExecutableFile(atPath: "/usr/local/bin/node") {
            loaded.nodePath = "/usr/local/bin/node"
        }
        settings = loaded
        do {
            let store = try snapshotStore ?? SnapshotStore.appGroup()
            self.snapshotStore = store
            snapshot = store.readForStartup()
        }
        catch { storageError = error.localizedDescription }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }
    func start() {
        guard settings.hasStartedLiveData else { return }
        guard process == nil else { return }
        wantsRunning = true
        status = snapshot.services.contains { $0.snapshot != nil } ? "前回取得値を表示・更新中" : "情報を取得中"
        guard settings.isValid, FileManager.default.isExecutableFile(atPath: settings.nodePath),
            let bridge = Bundle.main.url(forResource: "widget-bridge", withExtension: "mjs", subdirectory: "dist")
        else {
            status = "Node.js の実行パスまたはブリッジを確認してください。"
            recordDiagnostic(.process_start_failed)
            return
        }
        let child = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let identifier = UUID()
        generation = identifier
        outputBuffer.removeAll()
        child.executableURL = URL(fileURLWithPath: settings.nodePath)
        child.arguments = [bridge.path]
        var environment = ProcessInfo.processInfo.environment
        let nodeDirectory = URL(fileURLWithPath: settings.nodePath).deletingLastPathComponent().path
        environment["PATH"] = "\(nodeDirectory):\(FileManager.default.homeDirectoryForCurrentUser.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        child.environment = environment
        child.standardInput = stdinPipe
        child.standardOutput = stdoutPipe
        child.standardError = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            Task { @MainActor in
                guard let self, self.generation == identifier else { return }
                self.consume(data)
            }
        }
        child.terminationHandler = { [weak self] terminated in
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            Task { @MainActor in
                guard let self, self.generation == identifier else { return }
                self.process = nil
                self.input = nil
                self.running = false
                self.recordDiagnostic(.process_exit, exitStatus: terminated.terminationStatus)
                guard self.wantsRunning else { return }
                self.status = "取得プロセスが停止しました。3秒後に再接続します。"
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if self.wantsRunning && self.generation == identifier { self.start() }
            }
        }
        do {
            try child.run()
            process = child
            input = stdinPipe.fileHandleForWriting
            running = true
            sendConfiguration()
        } catch {
            status = "Node.js を起動できません。実行パスを確認してください。"
            recordDiagnostic(.process_start_failed)
        }
    }
    func refresh() { send(["type": "refresh"]) }
    func apply(_ updated: AppSettings) {
        do {
            try settingsStore.write(updated)
            let restart = updated.nodePath != settings.nodePath
            let configurationChanged = updated.config != settings.config
            settings = updated
            notifications.requestPermissionIfNeeded(updated.config.services) { [weak self] error in
                self?.notificationError = error
            }
            if restart {
                Task { await stop(); start() }
            } else if process == nil { start() }
            else if configurationChanged { sendConfiguration() }
        } catch { status = error.localizedDescription }
    }
    func startLiveData() {
        var updated = settings
        updated.hasStartedLiveData = true
        updated.config.demo = false
        apply(updated)
    }
    func stop() async {
        wantsRunning = false
        let child = process
        generation = UUID()
        send(["type": "stop"])
        try? input?.close()
        process = nil
        input = nil
        running = false
        guard let child else { return }
        // 停止コマンドで子プロセスも終了。応答しなければシグナルで停止。
        for _ in 0..<40 {
            if !child.isRunning { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        if child.isRunning { child.terminate() }
    }
    private func send(_ object: [String: Any]) {
        guard let input, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        do { try input.write(contentsOf: data + Data([10])) }
        catch {
            status = "取得プロセスと通信できません。"
            recordDiagnostic(.bridge_protocol)
        }
    }
    private func sendConfiguration() {
        guard let data = try? JSONEncoder().encode(settings.config),
            let config = try? JSONSerialization.jsonObject(with: data) else { return }
        send(["type": "configure", "config": config])
    }
    private func consume(_ data: Data) {
        outputBuffer.append(data)
        guard outputBuffer.count <= 1_048_576 else {
            outputBuffer.removeAll()
            status = "取得データが大きすぎます。"
            recordDiagnostic(.bridge_protocol)
            return
        }
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard let event = try? JSONDecoder().decode(BridgeEvent.self, from: Data(line)) else {
                status = "取得データの形式が不正です。"
                recordDiagnostic(.bridge_protocol)
                continue
            }
            switch event.type {
            case "configured":
                guard event.demo == false, settings.hasStartedLiveData else { continue }
                status = "実データを取得中・更新間隔 \(settings.config.intervalSeconds)秒"
            case "snapshot":
                guard event.demo == settings.config.demo else { continue }
                guard let service = event.service, let usage = event.snapshot, usage.isValid else { continue }
                snapshot.update(service: service, snapshot: usage)
                if let diagnostic = event.diagnostic { diagnosticHistory.record(service: service, detail: diagnostic) }
                persistSnapshot()
            case "error":
                guard event.demo == settings.config.demo else { continue }
                guard let service = event.service else { continue }
                snapshot.update(service: service, error: event.message ?? "取得に失敗しました。")
                if let diagnostic = event.diagnostic { diagnosticHistory.record(service: service, detail: diagnostic) }
                else { recordDiagnostic(.unknown_error, service: service) }
                persistSnapshot()
            case "diagnostic":
                guard event.demo == settings.config.demo, let diagnostic = event.diagnostic else { continue }
                diagnosticHistory.record(service: event.service, detail: diagnostic)
            case "notification":
                guard !settings.config.demo, event.demo == false else { continue }
                guard let message = event.message, let method = event.method else { continue }
                notifications.send(title: event.title ?? "TokenWatcher", message: message, method: method) { [weak self] error in
                    self?.notificationError = error
                }
            case "protocolError":
                status = event.message ?? "設定を送信できません。"
                recordDiagnostic(.bridge_protocol)
            default: break
            }
        }
    }
    private func recordDiagnostic(_ code: DiagnosticCode, service: UsageService? = nil, exitStatus: Int32? = nil) {
        diagnosticHistory.record(service: service, detail: BridgeDiagnostic(code: code,
            occurredAt: ISO8601DateFormatter().string(from: Date()), exitStatus: exitStatus.map(Int.init)))
    }
    private func persistSnapshot() {
        guard !snapshot.demo, snapshot.services.contains(where: { $0.snapshot != nil }) else { return }
        guard let snapshotStore else { return }
        do {
            try snapshotStore.write(snapshot)
            storageError = nil
            WidgetCenter.shared.reloadTimelines(ofKind: "TokenWatcherUsage")
        } catch { storageError = error.localizedDescription }
    }
}
