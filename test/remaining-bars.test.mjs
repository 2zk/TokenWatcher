import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { formatRemainingBar, terminalDisplayOptions } from "../dist/remaining-bars.mjs";
import { formatSnapshot } from "../dist/codex-format.mjs";
import { formatClaudeSnapshot, formatStatusLine } from "../dist/claude-format.mjs";

test("端末だけバーを表示し、NO_COLOR と簡易端末では色を付けない", () => {
    assert.deepEqual(terminalDisplayOptions({ isTTY: true, columns: 48 }, {}), {
        bars: true, color: true, columns: 48,
    });
    assert.deepEqual(terminalDisplayOptions({}, {}), {
        bars: false, color: false, columns: 80,
    });
    assert.equal(terminalDisplayOptions({ isTTY: true }, { NO_COLOR: "1" }).color, false);
    assert.equal(terminalDisplayOptions({ isTTY: true }, { NO_COLOR: "" }).color, true);
    assert.equal(terminalDisplayOptions({ isTTY: true }, { TERM: "dumb" }).color, false);
});

test("横バーは残量に比例し、0〜100%に収まり、狭い端末に合わせて短くなる", () => {
    const options = { columns: 22 };
    assert.equal(formatRemainingBar(0, options), "░".repeat(20));
    assert.equal(formatRemainingBar(50, options), "█".repeat(10) + "░".repeat(10));
    assert.equal(formatRemainingBar(100, options), "█".repeat(20));
    assert.equal(formatRemainingBar(-10, options), formatRemainingBar(0, options));
    assert.equal(formatRemainingBar(110, options), formatRemainingBar(100, options));
    assert.equal(formatRemainingBar(54.5, { columns: 12 }), "█████░░░░░");
    assert.equal(formatRemainingBar(50, { columns: 0 }), "█");
    assert.equal(formatRemainingBar(50).length, 32);
});

test("GUI と同じ境界で緑・オレンジ・赤にし、古いデータはグレーにする", () => {
    for (const [remaining, shade] of [[100, "32"], [30.1, "32"], [30, "38;5;208"], [10.1, "38;5;208"], [10, "31"], [5, "31"]]) {
        const output = formatRemainingBar(remaining, { color: true, columns: 102 });
        assert.ok(output.startsWith(`\x1B[${shade}m`), `${remaining}% の色`);
        assert.equal(stripVTControlCharacters(output), formatRemainingBar(remaining));
    }
    const stale = formatRemainingBar(80, { color: true, stale: true });
    assert.ok(stale.startsWith("\x1B[90m"));
    assert.doesNotMatch(stale, /\x1B\[(32|31|38;5;208)m/);
});

function snapshot() {
    return {
        schemaVersion: 1,
        observedAt: "2026-10-15T00:00:00.000Z",
        limits: [
            { limitId: "codex", limitName: "Codex", window: "primary", windowDurationMins: 300, remainingPercent: 50, resetsAt: "2026-10-15T05:00:00.000Z" },
            { limitId: "claude-fable", limitName: null, window: "seven_day", windowDurationMins: 10080, remainingPercent: 10, resetsAt: null },
        ],
        resetCredits: { availableCount: 0, credits: [] },
    };
}

test("両 CLI の端末表示は名前・期間・小数1桁の残量、バー、リセット日時を並べる", () => {
    const data = snapshot();
    const display = { bars: true, color: false, columns: 22 };
    const codex = formatSnapshot(data, 20, "popup", undefined, [], false, display);
    const claude = formatClaudeSnapshot(data, false, 20, "popup", undefined, [], false, display);
    for (const output of [codex, claude]) {
        assert.match(output.split("\n")[0], /通知設定: 残量 20% 以下/);
        assert.match(output, /Codex \/ primary \/ 5時間: 残量 50\.0%\n  █{10}░{10}\n  リセット \d{4}-\d{2}-\d{2} /);
        assert.match(output, /\n\nclaude-fable \/ seven_day \/ 7日（週次）: 残量 10\.0%\n  ██░{18}\n  リセット 不明/);
        assert.doesNotMatch(output, /\x1B/);
    }
    assert.match(codex.split("\n").at(-1), /^リセットクレジット: 利用可能 0件$/);
});

test("Claude の古いキャッシュはグレーのバーと既存の注記を表示する", () => {
    const output = formatClaudeSnapshot(snapshot(), true, undefined, "popup", undefined, [], false, { bars: true, color: true });
    assert.match(output, /\x1B\[90m█/);
    assert.doesNotMatch(output, /\x1B\[(32|31|38;5;208)m/);
    assert.equal(output.split("\n").at(-1), "※ 最新データが取得できていません");
});

test("制限がない場合はバーを作らず、非端末表示と statusLine の既存形式を保つ", () => {
    const data = snapshot();
    for (const output of [formatSnapshot(data), formatClaudeSnapshot(data, false)]) {
        assert.match(output, /残量 50\.0%\s+\/ リセット/);
        assert.doesNotMatch(output, /[█░\x1B]/);
    }
    assert.equal(formatStatusLine(data), "Claude primary:50% 7d:10%");
    data.limits = [];
    for (const output of [
        formatSnapshot(data, undefined, "popup", undefined, [], false, { bars: true }),
        formatClaudeSnapshot(data, false, undefined, "popup", undefined, [], false, { bars: true }),
    ]) {
        assert.match(output, /表示可能な利用制限/);
        assert.doesNotMatch(output, /[█░\x1B]/);
    }
});
