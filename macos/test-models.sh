#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
build_dir="$project_dir/.build/model-tests"
mkdir -p "$build_dir"
xcrun swiftc -module-cache-path "$build_dir/ModuleCache" \
    "$project_dir/macos/Shared/Models.swift" \
    "$project_dir/macos/Shared/Persistence.swift" \
    "$project_dir/macos/Tests/ModelChecks.swift" \
    -o "$build_dir/model-checks"
"$build_dir/model-checks" "$build_dir"
