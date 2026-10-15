#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
build_dir="$project_dir/.build/scene-tests"
bundle_dir="$build_dir/TokenWatcherSceneCheck.app/Contents"
mkdir -p "$bundle_dir/MacOS"
cp "$project_dir/macos/Tests/SceneCheckInfo.plist" "$bundle_dir/Info.plist"
iconset_dir="$build_dir/AppIcon.iconset"
icon_source="$project_dir/macos/App/Assets.xcassets/AppIcon.appiconset"
mkdir -p "$iconset_dir" "$bundle_dir/Resources"
for size in 16 32 128 256 512; do
    retina_size=$((size * 2))
    cp "$icon_source/icon$size.png" "$iconset_dir/icon_${size}x${size}.png"
    cp "$icon_source/icon$retina_size.png" "$iconset_dir/icon_${size}x${size}@2x.png"
done
iconutil --convert icns --output "$bundle_dir/Resources/AppIcon.icns" "$iconset_dir"
xcrun swiftc -g -parse-as-library -D SCENE_CHECK -module-cache-path "$build_dir/ModuleCache" \
    "$project_dir/macos/Shared/Models.swift" \
    "$project_dir/macos/Shared/Persistence.swift" \
    "$project_dir/macos/Shared/UsageBars.swift" \
    "$project_dir/macos/App/AppModel.swift" \
    "$project_dir/macos/App/NotificationDispatcher.swift" \
    "$project_dir/macos/App/SettingsView.swift" \
    "$project_dir/macos/App/TokenWatcherApp.swift" \
    "$project_dir/macos/Tests/SceneChecks.swift" \
    -o "$bundle_dir/MacOS/TokenWatcherSceneCheck"
# ブリッジ・App Group・URL スキームを含めず、認証情報と実データを扱わない。
: > "$build_dir/stdout.log"
: > "$build_dir/stderr.log"
open -n -W --stdout "$build_dir/stdout.log" --stderr "$build_dir/stderr.log" "$bundle_dir/.." \
    --args -ApplePersistenceIgnoreState YES &
launcher_pid=$!
(sleep 20
    pkill -TERM -f "^$bundle_dir/MacOS/TokenWatcherSceneCheck([[:space:]]|$)" 2>/dev/null || true
    kill -TERM "$launcher_pid" 2>/dev/null || true
) &
watchdog_pid=$!
scene_status=0
wait "$launcher_pid" || scene_status=$?
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
cat "$build_dir/stdout.log" "$build_dir/stderr.log" > "$build_dir/runtime.log"
cat "$build_dir/runtime.log"
if [ "$scene_status" -ne 0 ]; then exit "$scene_status"; fi
if rg -q 'Publishing changes from within view updates|Modifying state during view update' "$build_dir/runtime.log"; then
    echo "画面更新中の状態変更を検出" >&2
    exit 1
fi
rg -q '再表示に成功' "$build_dir/runtime.log"
