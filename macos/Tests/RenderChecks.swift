import AppKit
import SwiftUI

@main
struct RenderChecks {
    @MainActor static func main() throws {
        let now = Date()
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let base = SharedSnapshot.sample(at: now)
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(base)) as! [String: Any]
        var services = object["services"] as! [[String: Any]]
        for index in services.indices {
            var snapshot = services[index]["snapshot"] as! [String: Any]
            var limits = snapshot["limits"] as! [[String: Any]]
            let values: [Double] = index == 0 ? [75, 25] : [10, 0]
            for limitIndex in limits.indices {
                limits[limitIndex]["remainingPercent"] = values[limitIndex]
                limits[limitIndex]["usedPercent"] = 100 - values[limitIndex]
            }
            snapshot["limits"] = limits
            services[index]["snapshot"] = snapshot
        }
        object["services"] = services
        let low = try JSONDecoder().decode(SharedSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
        let cases: [(String, SharedSnapshot, ColorScheme)] = [
            ("normal", base, .light), ("low", low, .light), ("dark", low, .dark),
            ("stale", .sample(at: now.addingTimeInterval(-301)), .light),
            ("missing", SharedSnapshot(demo: false), .light),
        ]
        for (name, snapshot, scheme) in cases {
            let view = UsageDashboard(snapshot: snapshot, now: now)
                .padding(12).frame(width: 344, height: 170)
                .background(scheme == .dark ? Color(red: 0.10, green: 0.10, blue: 0.12) : .white)
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let cgImage = renderer.cgImage else { fatalError("プレビューを描画できません") }
            let bitmap = NSBitmapImageRep(cgImage: cgImage)
            guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNGを生成できません") }
            try data.write(to: directory.appendingPathComponent("\(name).png"))
        }
        print("5種類のウィジェット表示を描画")
    }
}
