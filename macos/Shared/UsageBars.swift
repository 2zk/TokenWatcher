import SwiftUI

struct RemainingBar: View {
    let remaining: Double?
    var stale = false
    private var color: Color {
        guard let remaining, !stale else { return .secondary }
        return remaining > 30 ? .green : remaining > 10 ? .orange : .red
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                if let remaining {
                    Capsule().fill(color).frame(width: geometry.size.width * min(100, max(0, remaining)) / 100)
                }
            }
        }
        .frame(height: 7)
        .accessibilityLabel("残量")
        .accessibilityValue(remaining.map { String(format: "%.1fパーセント", $0) } ?? "未取得")
    }
}
struct ServiceBars: View {
    let state: ServiceState
    let now: Date
    private var stale: Bool { state.snapshot?.isStale(at: now) ?? false }
    private var slots: [UsageLimit?] { state.snapshot?.primaryLimits(for: state.service) ?? [nil, nil] }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(state.service.title).font(.headline)
                Spacer(minLength: 0)
                if state.lastError != nil { Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange).accessibilityLabel("取得エラー") }
            }
            ForEach(0..<2, id: \.self) { index in
                let limit = slots[index]
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(limit?.period ?? (index == 0 ? "短期" : "週次"))
                        Spacer(minLength: 2)
                        Text(limit.map { String(format: "%.1f%%", $0.remainingPercent) } ?? "—")
                            .monospacedDigit().fontWeight(.semibold)
                    }.font(.caption)
                    RemainingBar(remaining: limit?.remainingPercent, stale: stale)
                    if let reset = limit?.resetDate {
                        Text("リセット \(reset.formatted(.dateTime.month().day().hour().minute()))")
                            .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    } else {
                        Text("リセット —").font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
            }
            HStack(spacing: 3) {
                if stale { Text("更新待ち").foregroundStyle(.orange) }
                if let observed = state.snapshot?.observedDate {
                    Text("取得 \(observed.formatted(.dateTime.hour().minute()))").foregroundStyle(.secondary)
                } else { Text("未取得").foregroundStyle(.secondary) }
            }.font(.system(size: 9)).lineLimit(1)
        }
    }
}
struct UsageDashboard: View {
    let snapshot: SharedSnapshot
    let now: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("TokenWatcher").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if snapshot.demo { Text("サンプル").font(.caption2).foregroundStyle(.secondary) }
            }
            HStack(alignment: .top, spacing: 14) {
                ServiceBars(state: snapshot.state(for: .codex), now: now)
                Divider()
                ServiceBars(state: snapshot.state(for: .claude), now: now)
            }
        }
    }
}
