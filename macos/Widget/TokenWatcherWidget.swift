import WidgetKit
import SwiftUI

struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: SharedSnapshot
    var storageIssue = false
}
struct UsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> UsageEntry { UsageEntry(date: .now, snapshot: SharedSnapshot(demo: false)) }
    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        completion(context.isPreview ? UsageEntry(date: .now, snapshot: .sample()) : read())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        let entry = read()
        // データが古くなる時刻もタイムラインに含め、残量を推測で更新しない。
        let transitions = entry.snapshot.services.flatMap { state -> [Date?] in
            guard let snapshot = state.snapshot else { return [] }
            return [snapshot.observedDate?.addingTimeInterval(300)] + snapshot.limits.map(\.resetDate)
        }.compactMap { $0 }.filter { $0 > entry.date && $0 <= entry.date.addingTimeInterval(900) }
        let dates = Set(transitions).sorted()
        let entries = [entry] + dates.map { UsageEntry(date: $0, snapshot: entry.snapshot, storageIssue: entry.storageIssue) }
        completion(Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(900))))
    }
    private func read() -> UsageEntry {
        do { return UsageEntry(date: .now, snapshot: try SnapshotStore.appGroup().readForStartup()) }
        catch { return UsageEntry(date: .now, snapshot: SharedSnapshot(demo: false), storageIssue: true) }
    }
}
struct TokenWatcherWidget: Widget {
    let kind = "TokenWatcherUsage"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UsageProvider()) { entry in
            UsageDashboard(snapshot: entry.snapshot, now: entry.date)
            .overlay(alignment: .topTrailing) {
                if entry.storageIssue { Text("アプリで共有設定を確認").font(.system(size: 9)).foregroundStyle(.secondary) }
            }
            .padding(12)
            .containerBackground(.background, for: .widget)
            .widgetURL(URL(string: "tokenwatcher://dashboard"))
        }
        .configurationDisplayName("TokenWatcher 残量")
        .description("Codex と Claude の短期・週次残量を横バーで確認")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}
@main
struct TokenWatcherWidgetBundle: WidgetBundle {
    var body: some Widget { TokenWatcherWidget() }
}
struct TokenWatcherWidget_Previews: PreviewProvider {
    static var previews: some View {
        UsageDashboard(snapshot: .sample(), now: .now)
            .padding()
            .previewContext(WidgetPreviewContext(family: .systemMedium))
    }
}
