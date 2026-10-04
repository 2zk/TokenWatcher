import Foundation

enum UsageService: String, Codable, CaseIterable, Identifiable {
    case codex, claude
    var id: String { rawValue }
    var title: String { self == .codex ? "Codex" : "Claude" }
}

func usageDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

struct UsageLimit: Codable, Identifiable {
    let limitId: String
    let limitName: String?
    let window: String
    let windowDurationMins: Int?
    let usedPercent: Double
    let remainingPercent: Double
    let resetsAtEpochSeconds: Double?
    let resetsAt: String?
    var id: String { "\(limitId):\(window)" }
    var title: String { limitName ?? limitId }
    var period: String {
        switch windowDurationMins {
        case 300: return "5時間"
        case 10_080: return "7日"
        case let minutes?: return minutes % 60 == 0 ? "\(minutes / 60)時間" : "\(minutes)分"
        case nil: return window
        }
    }
    var resetDate: Date? { resetsAtEpochSeconds.map { Date(timeIntervalSince1970: $0) } }
    var isValid: Bool {
        !limitId.isEmpty && !window.isEmpty && usedPercent.isFinite && remainingPercent.isFinite &&
        (0...100).contains(usedPercent) && (0...100).contains(remainingPercent) &&
        (resetsAtEpochSeconds?.isFinite ?? true)
    }
}

struct ResetCredit: Codable {
    let title: String?
    let resetType: String?
    let status: String?
    let expiresAt: String?
}
struct ResetCredits: Codable {
    let availableCount: Int?
    let credits: [ResetCredit]
}
struct UsageSnapshot: Codable {
    let schemaVersion: Int
    let observedAt: String
    let limits: [UsageLimit]
    let resetCredits: ResetCredits?
    var observedDate: Date? { usageDate(observedAt) }
    var isValid: Bool { schemaVersion == 1 && observedDate != nil && limits.allSatisfy(\.isValid) }
    func isStale(at now: Date) -> Bool {
        guard let observed = observedDate else { return true }
        return now.timeIntervalSince(observed) >= 300 || limits.contains { limit in
            limit.resetDate.map { now >= $0 } ?? false
        }
    }
    func primaryLimits(for service: UsageService) -> [UsageLimit?] {
        let base = limits.filter { limit in
            service == .claude ? limit.limitId == "claude" :
                limit.limitId == "codex" || limit.limitId == "default" || limit.title.lowercased() == "codex"
        }
        return [300, 10_080].map { duration in base.first { $0.windowDurationMins == duration } }
    }
}
struct ServiceState: Codable, Identifiable {
    let service: UsageService
    var snapshot: UsageSnapshot?
    var lastError: String?
    var id: UsageService { service }
}
struct SharedSnapshot: Codable {
    var schemaVersion = 1
    var demo = true
    var services: [ServiceState] = UsageService.allCases.map { ServiceState(service: $0) }
    func state(for service: UsageService) -> ServiceState {
        services.first { $0.service == service } ?? ServiceState(service: service)
    }
    var isValid: Bool {
        schemaVersion == 1 && Set(services.map(\.service)).count == services.count &&
        services.allSatisfy { $0.snapshot?.isValid ?? true }
    }
    mutating func update(service: UsageService, snapshot: UsageSnapshot? = nil, error: String? = nil) {
        let index = services.firstIndex { $0.service == service }
        var state = index.map { services[$0] } ?? ServiceState(service: service)
        if let snapshot { state.snapshot = snapshot }
        state.lastError = error
        if let index { services[index] = state } else { services.append(state) }
    }
    static func sample(at now: Date = Date()) -> SharedSnapshot {
        var shared = SharedSnapshot()
        for service in UsageService.allCases {
            let values: [Double] = service == .codex ? [75, 42] : [54, 77]
            let limits = values.enumerated().map { index, remaining in
                let reset = now.addingTimeInterval(index == 0 ? 7200 : 259200)
                return UsageLimit(limitId: service.rawValue, limitName: service.title,
                    window: service == .codex ? (index == 0 ? "primary" : "secondary") : (index == 0 ? "five_hour" : "seven_day"),
                    windowDurationMins: index == 0 ? 300 : 10_080, usedPercent: 100 - remaining,
                    remainingPercent: remaining, resetsAtEpochSeconds: reset.timeIntervalSince1970,
                    resetsAt: ISO8601DateFormatter().string(from: reset))
            }
            shared.update(service: service, snapshot: UsageSnapshot(schemaVersion: 1,
                observedAt: ISO8601DateFormatter().string(from: now), limits: limits, resetCredits: nil))
        }
        return shared
    }
}

enum NotificationMethod: String, Codable, CaseIterable, Identifiable {
    case popup, notification
    var id: String { rawValue }
    var title: String { self == .popup ? "ポップアップ" : "Mac 通知センター" }
}
struct NotificationSettings: Codable, Equatable {
    var notifyBelow: Int?
    var notifyEvery: Int?
    var notifyMethod: NotificationMethod = .popup
    var notifyApiError = false
    var notifyExclude: [String] = []
    var isValid: Bool {
        (notifyBelow.map { (0...100).contains($0) } ?? true) &&
        (notifyEvery.map { (1...99).contains($0) } ?? true) &&
        notifyExclude.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    enum CodingKeys: String, CodingKey { case notifyBelow, notifyEvery, notifyMethod, notifyApiError, notifyExclude }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // ブリッジの無効値は省略ではなく null を使う。
        try container.encode(notifyBelow, forKey: .notifyBelow)
        try container.encode(notifyEvery, forKey: .notifyEvery)
        try container.encode(notifyMethod, forKey: .notifyMethod)
        try container.encode(notifyApiError, forKey: .notifyApiError)
        try container.encode(notifyExclude, forKey: .notifyExclude)
    }
}
struct ServiceSettings: Codable, Equatable {
    var codex = NotificationSettings()
    var claude = NotificationSettings()
    subscript(service: UsageService) -> NotificationSettings {
        get { service == .codex ? codex : claude }
        set { if service == .codex { codex = newValue } else { claude = newValue } }
    }
}
struct BridgeConfig: Codable, Equatable {
    var demo = true
    var intervalSeconds = 180
    var codexBin = "codex"
    var timeoutSeconds = 15
    var claudeSource = "auto"
    var services = ServiceSettings()
    var isValid: Bool {
        (60...86400).contains(intervalSeconds) && (1...300).contains(timeoutSeconds) &&
        !codexBin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        ["auto", "api", "statusline"].contains(claudeSource) && services.codex.isValid && services.claude.isValid
    }
}
struct AppSettings: Codable, Equatable {
    var nodePath = "/opt/homebrew/bin/node"
    var config = BridgeConfig()
    var showMenuBarIcon = true
    var hasStartedLiveData = false
    var isValid: Bool { nodePath.hasPrefix("/") && config.isValid }

    enum CodingKeys: String, CodingKey { case nodePath, config, showMenuBarIcon, hasStartedLiveData }
}
extension AppSettings {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nodePath = try values.decode(String.self, forKey: .nodePath)
        config = try values.decode(BridgeConfig.self, forKey: .config)
        showMenuBarIcon = try values.decodeIfPresent(Bool.self, forKey: .showMenuBarIcon) ?? true
        hasStartedLiveData = try values.decodeIfPresent(Bool.self, forKey: .hasStartedLiveData) ?? !config.demo
    }
}

struct BridgeEvent: Decodable {
    let type: String
    let service: UsageService?
    let snapshot: UsageSnapshot?
    let message: String?
    let title: String?
    let method: NotificationMethod?
    let demo: Bool?
    let diagnostic: BridgeDiagnostic?
}

enum DiagnosticCode: String, Decodable {
    case success, stale_value, cache_fallback, retry_wait, unknown_error
    case keychain_timeout, keychain_access, credentials_invalid, credentials_missing, credentials_expired
    case api_timeout, api_network, api_auth, api_rate_limit, api_http, api_invalid_json, api_missing_limits
    case cache_unavailable, codex_start, codex_timeout, codex_auth, codex_exit, codex_server
    case process_start_failed, process_exit, bridge_protocol

    var summary: String {
        switch self {
        case .success: return "取得に成功"
        case .stale_value: return "古い取得値を表示"
        case .cache_fallback: return "API 取得に失敗し、キャッシュを表示"
        case .retry_wait: return "API の待機指定に従い、更新要求を見送り"
        case .keychain_timeout: return "キーチェーンの読み取りが30秒以内に完了しなかった"
        case .keychain_access: return "キーチェーンから認証情報を読めなかった"
        case .credentials_invalid: return "認証情報の形式を解釈できなかった"
        case .credentials_missing: return "認証情報に OAuth トークンがなかった"
        case .credentials_expired: return "OAuth トークンの有効期限が切れている"
        case .api_timeout: return "利用量 API との通信がタイムアウトした"
        case .api_network: return "利用量 API との通信に失敗"
        case .api_auth: return "利用量 API が認証を拒否した"
        case .api_rate_limit: return "利用量 API の呼び出し回数制限に達した"
        case .api_http: return "利用量 API が HTTP エラーを返した"
        case .api_invalid_json: return "利用量 API の応答を JSON として読めなかった"
        case .api_missing_limits: return "利用量 API の応答に利用制限がなかった"
        case .cache_unavailable: return "利用量キャッシュがない、または形式が不正"
        case .codex_start: return "Codex app-server を起動できなかった"
        case .codex_timeout: return "Codex app-server の応答がタイムアウトした"
        case .codex_auth: return "Codex の認証状態・認証方式を確認する必要がある"
        case .codex_exit: return "Codex app-server が途中で終了した"
        case .codex_server: return "Codex app-server との通信・応答でエラー"
        case .process_start_failed: return "取得プロセスを起動できなかった。Node.js の実行パスを確認"
        case .process_exit: return "取得プロセスが終了した"
        case .bridge_protocol: return "取得プロセスとのデータ形式・設定のエラー"
        case .unknown_error: return "取得に失敗。安全に表示できる詳細情報はない"
        }
    }
    var isError: Bool {
        ![.success, .stale_value, .cache_fallback, .retry_wait].contains(self)
    }
    var guidance: String? {
        switch self {
        case .keychain_access, .keychain_timeout:
            return "ターミナル版 Claude Code のログイン状態と、キーチェーンアクセスの確認ダイアログを確認してください。"
        case .credentials_expired, .credentials_missing, .api_auth:
            return "ターミナル版 Claude Code を起動し、ログイン状態を確認してください。TokenWatcher はトークンを更新しません。"
        case .api_network, .api_timeout:
            return "接続・VPN・プロキシなどを確認してください。通常の取得周期で再試行します。"
        case .api_rate_limit, .retry_wait:
            return "CLI や他の監視との並行取得を確認してください。待機指定がある間は手動更新も見送ります。"
        case .api_http:
            return "HTTP ステータスを確認してください。通常の取得周期で再試行します。"
        default: return nil
        }
    }
}
enum DiagnosticSource: String, Decodable {
    case api, cache, app_server
    var title: String {
        switch self {
        case .api: return "利用量 API"
        case .cache: return "利用量キャッシュ"
        case .app_server: return "Codex app-server"
        }
    }
}
struct BridgeDiagnostic: Decodable {
    let code: DiagnosticCode
    let occurredAt: String
    var source: DiagnosticSource? = nil
    var httpStatus: Int? = nil
    var networkCode: String? = nil
    var exitStatus: Int? = nil
    var retryAfterSeconds: Int? = nil
    var retryNotBefore: String? = nil
    var nextAttemptAt: String? = nil
    var isValid: Bool {
        let safeCodes = ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
            "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
            "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "ENOENT", "EACCES", "ENOEXEC"]
        return usageDate(occurredAt) != nil &&
            (httpStatus.map { (100...599).contains($0) } ?? true) &&
            (exitStatus.map { (0...255).contains($0) } ?? true) &&
            (retryAfterSeconds.map { (0...31_536_000).contains($0) } ?? true) &&
            (networkCode.map { safeCodes.contains($0) } ?? true) &&
            (retryNotBefore.map { usageDate($0) != nil } ?? true) &&
            (nextAttemptAt.map { usageDate($0) != nil } ?? true)
    }
}
struct DiagnosticEntry: Identifiable {
    let id = UUID()
    let service: UsageService?
    let detail: BridgeDiagnostic
    var text: String {
        var lines = ["\(usageDate(detail.occurredAt)?.formatted(date: .numeric, time: .standard) ?? detail.occurredAt)　\(service?.title ?? "アプリ")",
            "\(detail.code.summary)（\(detail.code.rawValue)）"]
        if let source = detail.source { lines.append("取得元: \(source.title)") }
        if let status = detail.httpStatus { lines.append("HTTP ステータス: \(status)") }
        if let code = detail.networkCode { lines.append("システムエラーコード: \(code)") }
        if let status = detail.exitStatus { lines.append("プロセス終了コード: \(status)") }
        if let seconds = detail.retryAfterSeconds { lines.append("API の待機指定: \(seconds)秒") }
        if let date = detail.retryNotBefore.flatMap(usageDate) {
            lines.append("手動更新も待機: \(date.formatted(date: .numeric, time: .standard)) まで")
        }
        if let date = detail.nextAttemptAt.flatMap(usageDate) {
            lines.append("次の自動取得予定: \(date.formatted(date: .numeric, time: .standard))（目安）")
        }
        if let guidance = detail.code.guidance { lines.append(guidance) }
        return lines.joined(separator: "\n")
    }
}
struct DiagnosticHistory {
    private(set) var entries: [DiagnosticEntry] = []
    mutating func record(service: UsageService?, detail: BridgeDiagnostic) {
        guard detail.isValid else { return }
        entries.append(DiagnosticEntry(service: service, detail: detail))
        if entries.count > 100 { entries.removeFirst(entries.count - 100) }
    }
    var text: String { entries.reversed().map(\.text).joined(separator: "\n\n") }
}
