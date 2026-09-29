import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, helpText } from "../dist/claude-args.mjs";
import { CliUsageError } from "../dist/types.mjs";

// --- 正常系 ---

test("引数なし → run モード・デフォルト値", () => {
    const result = parseArgs([]);
    assert.equal(result.kind, "run");
    assert.equal(result.options.statusline, false);
    assert.equal(result.options.watch, false);
    assert.equal(result.options.intervalSeconds, 180);
    assert.equal(result.options.json, false);
    assert.equal(result.options.notifyMethod, "popup");
    assert.equal(result.options.notifyBelow, undefined);
    assert.equal(result.options.notifyEvery, undefined);
    assert.equal(result.options.notifyApiError, false);
    assert.equal(result.options.filter, undefined);
    assert.equal(result.options.source, "auto");
});

test("--source は auto / api / statusline を受け付ける", () => {
    for (const value of ["auto", "api", "statusline"]) {
        assert.equal(parseArgs(["--source", value]).options.source, value);
    }
});

test("--source の不正値・値なしはエラー", () => {
    assert.throws(() => parseArgs(["--source", "cache"]), CliUsageError);
    assert.throws(() => parseArgs(["--source"]), CliUsageError);
});

test("--statusline フラグが立つ", () => {
    const result = parseArgs(["--statusline"]);
    assert.equal(result.kind, "run");
    assert.equal(result.options.statusline, true);
});

test("--help", () => {
    const result = parseArgs(["--help"]);
    assert.equal(result.kind, "help");
});

test("--version", () => {
    const result = parseArgs(["--version"]);
    assert.equal(result.kind, "version");
});

test("--watch フラグが立つ", () => {
    const result = parseArgs(["--watch"]);
    assert.equal(result.options.watch, true);
});

test("--json フラグが立つ", () => {
    const result = parseArgs(["--json"]);
    assert.equal(result.options.json, true);
});

test("--interval 300 を受け付ける", () => {
    const result = parseArgs(["--interval", "300"]);
    assert.equal(result.options.intervalSeconds, 300);
});

test("--interval 60（最小値）を受け付ける", () => {
    const result = parseArgs(["--interval", "60"]);
    assert.equal(result.options.intervalSeconds, 60);
});

test("--filter テキストを受け付ける", () => {
    const result = parseArgs(["--filter", "five_hour"]);
    assert.equal(result.options.filter, "five_hour");
});

test("--notify-exclude を複数指定でき、既定は空配列", () => {
    assert.deepEqual(parseArgs([]).options.notifyExclude, []);
    const result = parseArgs(["--notify-exclude", "Claude / five_hour", "--notify-exclude", "fable"]);
    assert.deepEqual(result.options.notifyExclude, ["Claude / five_hour", "fable"]);
});

test("--notify-below 20 を受け付ける", () => {
    const result = parseArgs(["--notify-below", "20"]);
    assert.equal(result.options.notifyBelow, 20);
});

test("--notify-below 0 と 100 を受け付ける", () => {
    assert.equal(parseArgs(["--notify-below", "0"]).options.notifyBelow, 0);
    assert.equal(parseArgs(["--notify-below", "100"]).options.notifyBelow, 100);
});

test("--notify-every 10 を受け付ける", () => {
    const result = parseArgs(["--notify-every", "10"]);
    assert.equal(result.options.notifyEvery, 10);
});

test("--notify-method notification を受け付ける", () => {
    const result = parseArgs(["--notify-method", "notification"]);
    assert.equal(result.options.notifyMethod, "notification");
});

test("--notify-method popup を受け付ける", () => {
    const result = parseArgs(["--notify-method", "popup"]);
    assert.equal(result.options.notifyMethod, "popup");
});

test("--notify-api-error は指定時だけ有効になる", () => {
    assert.equal(parseArgs([]).options.notifyApiError, false);
    assert.equal(parseArgs(["--notify-api-error"]).options.notifyApiError, true);
    assert.match(helpText(), /--notify-api-error\s+利用量 API の取得エラーを通知する/);
});

test("複数オプションの組み合わせ", () => {
    const result = parseArgs([
        "--watch", "--json", "--interval", "120",
        "--notify-below", "30", "--notify-every", "20",
        "--notify-method", "notification", "--filter", "claude",
    ]);
    assert.equal(result.options.watch, true);
    assert.equal(result.options.json, true);
    assert.equal(result.options.intervalSeconds, 120);
    assert.equal(result.options.notifyBelow, 30);
    assert.equal(result.options.notifyEvery, 20);
    assert.equal(result.options.notifyMethod, "notification");
    assert.equal(result.options.filter, "claude");
});

// --- エラー系 ---

test("--interval 59 は 60 以上要求でエラー", () => {
    assert.throws(() => parseArgs(["--interval", "59"]), CliUsageError);
});

test("--interval 0 はエラー", () => {
    assert.throws(() => parseArgs(["--interval", "0"]), CliUsageError);
});

test("--interval に文字列はエラー", () => {
    assert.throws(() => parseArgs(["--interval", "abc"]), CliUsageError);
});

test("--notify-below 101 はエラー", () => {
    assert.throws(() => parseArgs(["--notify-below", "101"]), CliUsageError);
});

test("--notify-below に負数はエラー", () => {
    assert.throws(() => parseArgs(["--notify-below", "-1"]), CliUsageError);
});

test("--notify-every 0 はエラー", () => {
    assert.throws(() => parseArgs(["--notify-every", "0"]), CliUsageError);
});

test("--notify-every 100 はエラー", () => {
    assert.throws(() => parseArgs(["--notify-every", "100"]), CliUsageError);
});

test("--notify-method に不明な値はエラー", () => {
    assert.throws(() => parseArgs(["--notify-method", "toast"]), CliUsageError);
});

test("--codex-bin は不明オプションとしてエラー", () => {
    assert.throws(() => parseArgs(["--codex-bin", "codex"]), CliUsageError);
});

test("--timeout は不明オプションとしてエラー", () => {
    assert.throws(() => parseArgs(["--timeout", "15"]), CliUsageError);
});

test("不明なオプション → CliUsageError", () => {
    assert.throws(() => parseArgs(["--unknown"]), CliUsageError);
});

test("値が必要なオプションに値なしはエラー", () => {
    assert.throws(() => parseArgs(["--filter"]), CliUsageError);
    assert.throws(() => parseArgs(["--interval"]), CliUsageError);
    assert.throws(() => parseArgs(["--notify-below"]), CliUsageError);
    assert.throws(() => parseArgs(["--notify-every"]), CliUsageError);
    assert.throws(() => parseArgs(["--notify-method"]), CliUsageError);
    assert.throws(() => parseArgs(["--notify-exclude"]), CliUsageError);
});

// --- helpText ---

test("helpText に主要オプションが含まれる", () => {
    const text = helpText();
    assert.match(text, /--statusline/);
    assert.match(text, /--watch/);
    assert.match(text, /--interval/);
    assert.match(text, /--json/);
    assert.match(text, /--notify-below/);
    assert.match(text, /--notify-every/);
    assert.match(text, /--notify-method/);
    assert.match(text, /v2\.1\.251/);
    assert.match(text, /Pro または Max/);
});
