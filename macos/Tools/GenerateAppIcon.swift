import AppKit

// ターコイズの角丸背景と、メニューバーと同じ3本の残量バー。
func renderIcon(size: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw NSError(domain: "AppIcon", code: 1)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    let transform = AffineTransform(scale: CGFloat(size) / 1024)
    (transform as NSAffineTransform).concat()

    let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824),
        xRadius: 184, yRadius: 184)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
    shadow.shadowBlurRadius = 24
    shadow.shadowOffset = NSSize(width: 0, height: -8)
    shadow.set()
    NSColor(calibratedRed: 0.02, green: 0.56, blue: 0.65, alpha: 1).setFill()
    tile.fill()
    NSGraphicsContext.restoreGraphicsState()
    let gradient = NSGradient(starting: NSColor(calibratedRed: 0.02, green: 0.56, blue: 0.65, alpha: 1),
        ending: NSColor(calibratedRed: 0.23, green: 0.82, blue: 0.85, alpha: 1))!
    gradient.draw(in: tile, angle: 90)

    NSColor.white.setFill()
    for (index, height) in [220.0, 330.0, 440.0].enumerated() {
        NSBezierPath(roundedRect: NSRect(x: 278 + Double(index) * 178, y: 292, width: 112, height: height),
            xRadius: 24, yRadius: 24).fill()
    }
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "AppIcon", code: 2)
    }
    return png
}

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    try renderIcon(size: size).write(to: output.appendingPathComponent("icon\(size).png"), options: .atomic)
}
print("Dock 用アイコン7サイズを生成")
