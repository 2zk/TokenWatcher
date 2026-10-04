#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
build_dir="$project_dir/.build/previews"
mkdir -p "$build_dir"
xcrun swiftc -module-cache-path "$build_dir/ModuleCache" \
    "$project_dir/macos/Shared/Models.swift" \
    "$project_dir/macos/Shared/UsageBars.swift" \
    "$project_dir/macos/Tests/RenderChecks.swift" \
    -o "$build_dir/render-checks"
"$build_dir/render-checks" "$build_dir"
