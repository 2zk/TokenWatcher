import AppKit

private final class SceneDefaults: UserDefaults {
    private var values: [String: Data] = [:]
    override func data(forKey defaultName: String) -> Data? { values[defaultName] }
    override func set(_ value: Any?, forKey defaultName: String) { values[defaultName] = value as? Data }
}

// 専用バンドルで本番の Scene を起動し、画面更新中の再入を確認。
@MainActor
enum SceneChecks {
    private static var started = false
    static func start() {
        guard !started else { return }
        started = true
        Task { @MainActor in
            FileHandle.standardOutput.write(Data("画面チェック開始\n".utf8))
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !AppModel.shared.snapshot.demo,
                AppModel.shared.snapshot.services.allSatisfy({ $0.snapshot == nil }),
                !AppModel.shared.running else { fail("初回にサンプル表示または情報取得を開始した") }
            checkStartupRestoration()
            guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
                let expectedIcon = NSImage(contentsOf: iconURL),
                let expectedPNG = iconPNG(expectedIcon), let actualPNG = iconPNG(NSApp.applicationIconImage) else {
                fail("Dock アイコンの画像を読み込めなかった")
            }
            guard let iconDifference = iconDifference(actual: actualPNG, expected: expectedPNG) else {
                fail("Dock アイコンのピクセルを比較できなかった")
            }
            // AppKit の縮尺・色変換による差を、平均3階調まで許容。
            if iconDifference > 3 {
                let directory = Bundle.main.bundleURL.deletingLastPathComponent()
                try? actualPNG.write(to: directory.appendingPathComponent("actual-icon.png"))
                try? expectedPNG.write(to: directory.appendingPathComponent("expected-icon.png"))
                fail("起動時の Dock アイコンが同梱画像と一致しなかった（平均差: \(iconDifference)）")
            }
            guard let window = NSApp.windows.first(where: { $0.title == "TokenWatcher" && $0.isVisible }) else {
                fail("メイン画面が開かなかった")
            }
            for visible in [false, true, false, true, false] {
                AppModel.shared.settings.showMenuBarIcon = visible
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            window.performClose(nil)
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !window.isVisible else { fail("画面を閉じられなかった") }
            sendEvent(eventClass: 0x61657674, eventID: 0x72617070)
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard mainWindowIsVisible else { fail("Dock の再表示処理で画面が戻らなかった") }
            NSApp.windows.first(where: { $0.title == "TokenWatcher" })?.performClose(nil)
            try? await Task.sleep(nanoseconds: 200_000_000)
            sendEvent(eventClass: 0x4755524C, eventID: 0x4755524C, url: "tokenwatcher://dashboard")
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard mainWindowIsVisible else { fail("ウィジェット URL の処理で画面が戻らなかった") }
            guard let dashboard = NSApp.windows.first(where: { $0.title == "TokenWatcher" && $0.isVisible }) else {
                fail("通知チェック用のメイン画面が見つからなかった")
            }
            await checkMinimizedPopup(dashboard)
            FileHandle.standardOutput.write(Data("サンプル廃止・前回値復元・Dock アイコン設定・メニューバー表示切替・Dock/URL イベントによる再表示に成功\n".utf8))
            NSApp.terminate(nil)
        }
    }
    private static func checkMinimizedPopup(_ dashboard: NSWindow) async {
        let notifications = NotificationDispatcher()
        let title = "最小化通知チェック"
        dashboard.miniaturize(nil)
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if dashboard.isMiniaturized { break }
        }
        guard dashboard.isMiniaturized else { fail("通知チェック用のメイン画面を最小化できなかった") }
        NSApp.deactivate()
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if !NSApp.isActive { break }
        }
        guard !NSApp.isActive else { fail("通知チェック用アプリを非アクティブにできなかった") }
        notifications.send(title: title, message: "最小化中の通知表示を確認", method: .popup) { error in
            if let error { fail("ポップアップ表示に失敗: \(error)") }
        }
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard let popup = NSApp.windows.first(where: { $0.title == title }) else {
            fail("通知パネルが作成されなかった")
        }
        guard dashboard.isMiniaturized, !NSApp.isActive,
            popup.isVisible, popup.occlusionState.contains(.visible) else {
            fail("最小化・非アクティブ中に通知が画面へ表示されなかった")
        }
        popup.performClose(nil)
        try? await Task.sleep(nanoseconds: 200_000_000)
        guard !popup.isVisible else { fail("通知パネルを閉じられなかった") }
        dashboard.deminiaturize(nil)
        try? await Task.sleep(nanoseconds: 200_000_000)
        FileHandle.standardOutput.write(Data("最小化・非アクティブ中のポップアップ表示と閉じる操作に成功\n".utf8))
    }
    private static func checkStartupRestoration() {
        do {
            let settingsStore = SettingsStore(defaults: SceneDefaults())
            var settings = AppSettings()
            settings.hasStartedLiveData = true
            settings.config.demo = false
            try settingsStore.write(settings)
            let directory = Bundle.main.bundleURL.deletingLastPathComponent()
            let store = SnapshotStore(fileURL: directory.appendingPathComponent("restoration.json"))
            var live = SharedSnapshot.sample(at: Date().addingTimeInterval(-600))
            live.demo = false
            try store.write(live)
            let previous = try Data(contentsOf: store.fileURL)
            let model = AppModel(settingsStore: settingsStore, snapshotStore: store)
            guard !model.snapshot.demo, model.settings.hasStartedLiveData, !model.settings.config.demo,
                model.snapshot.state(for: .claude).snapshot?.primaryLimits(for: .claude)[0]?.remainingPercent == 54,
                model.snapshot.state(for: .claude).snapshot?.isStale(at: .now) == true,
                model.diagnosticHistory.entries.isEmpty, !model.running,
                try Data(contentsOf: store.fileURL) == previous else { fail("前回実データの復元に失敗") }
            try store.write(.sample())
            let empty = AppModel(settingsStore: SettingsStore(defaults: SceneDefaults()), snapshotStore: store)
            guard !empty.snapshot.demo, empty.snapshot.services.allSatisfy({ $0.snapshot == nil }),
                !empty.settings.hasStartedLiveData, !empty.running else { fail("旧サンプルを実データとして復元した") }
        } catch { fail("起動時データの復元チェックに失敗: \(error.localizedDescription)") }
    }
    private static func iconDifference(actual: Data, expected: Data) -> Double? {
        guard let actualBitmap = NSBitmapImageRep(data: actual),
            let expectedBitmap = NSBitmapImageRep(data: expected) else { return nil }
        var totalDifference = 0.0
        for row in 0..<128 {
            for column in 0..<128 {
                guard let actualColor = actualBitmap.colorAt(x: column, y: row)?.usingColorSpace(.deviceRGB),
                    let expectedColor = expectedBitmap.colorAt(x: column, y: row)?.usingColorSpace(.deviceRGB) else { return nil }
                totalDifference += abs(actualColor.redComponent - expectedColor.redComponent)
                totalDifference += abs(actualColor.greenComponent - expectedColor.greenComponent)
                totalDifference += abs(actualColor.blueComponent - expectedColor.blueComponent)
                totalDifference += abs(actualColor.alphaComponent - expectedColor.alphaComponent)
            }
        }
        return totalDifference * 255 / (128 * 128 * 4)
    }
    private static func iconPNG(_ image: NSImage) -> Data? {
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 128, pixelsHigh: 128,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
            let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        defer { NSGraphicsContext.restoreGraphicsState() }
        let bounds = NSRect(x: 0, y: 0, width: 128, height: 128)
        NSColor.clear.setFill()
        bounds.fill(using: .copy)
        image.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1)
        return bitmap.representation(using: .png, properties: [:])
    }
    private static func sendEvent(eventClass: UInt32, eventID: UInt32, url: String? = nil) {
        let event = NSAppleEventDescriptor(eventClass: eventClass, eventID: eventID,
            targetDescriptor: NSAppleEventDescriptor(processIdentifier: ProcessInfo.processInfo.processIdentifier),
            returnID: -1, transactionID: 0)
        if let url { event.setParam(NSAppleEventDescriptor(string: url), forKeyword: 0x2d2d2d2d) }
        do { _ = try event.sendEvent(options: .noReply, timeout: 5) }
        catch { fail("自身へのイベント送信に失敗: \(error.localizedDescription)") }
    }
    private static var mainWindowIsVisible: Bool {
        NSApp.windows.contains { $0.title == "TokenWatcher" && $0.isVisible }
    }
    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("画面チェック失敗: \(message)\n".utf8))
        exit(1)
    }
}
