import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createFakeCodex, readCapturedEvents, waitUntil } from "./helpers/fake-codex.mjs";
import { WidgetBridge, createCollectors, defaultBridgeConfig, demoSnapshot, runBridge, snapshotIsStale, validateBridgeConfig } from "../dist/widget-bridge.mjs";
import { UsageApiError } from "../dist/claude-usage-api.mjs";

function setup(context, { remaining = 90, old = false } = {}) {
    const events = [];
    let clock = Date.parse("2026-10-04T10:00:00Z");
    const state = { remaining, old, failCodex: false, failClaude: false, retry: undefined, calls: { codex: 0, claude: 0 } };
    const collectors = {
        async codex() {
            state.calls.codex++;
            if (state.failCodex) throw new Error("secret upstream text must not be emitted");
            return makeSnapshot("codex");
        },
        async claude() {
            state.calls.claude++;
            if (state.failClaude) throw Object.assign(new Error("secret token must not be emitted"), { retryAfterSeconds: state.retry });
            return makeSnapshot("claude");
        },
        async close() {},
    };
    function makeSnapshot(service) {
        const snapshot = demoSnapshot(service, new Date(clock - (state.old ? 301000 : 0)));
        snapshot.limits[0].remainingPercent = state.remaining;
        snapshot.limits[0].usedPercent = 100 - state.remaining;
        return snapshot;
    }
    const bridge = new WidgetBridge((event) => events.push(event), collectors, () => clock, () => collectors);
    const config = defaultBridgeConfig();
    config.demo = false;
    context.after(() => bridge.stop());
    return { bridge, config, state, events, advance: (ms) => { clock += ms; }, notifications: () => events.filter((event) => event.type === "notification") };
}

test("設定値の境界と無効値を検証する", () => {
    const config = defaultBridgeConfig();
    config.services.codex.notifyBelow = 0;
    config.services.claude.notifyBelow = 100;
    config.services.codex.notifyEvery = 1;
    config.services.claude.notifyEvery = 99;
    assert.deepEqual(validateBridgeConfig(config), config);
    for (const mutate of [
        (value) => { value.services.codex.notifyBelow = 101; },
        (value) => { value.services.codex.notifyEvery = 0; },
        (value) => { value.services.codex.notifyEvery = 100; },
        (value) => { value.services.codex.notifyExclude = [""]; },
        (value) => { value.services.codex.notifyMethod = "invalid"; },
        (value) => { value.intervalSeconds = 59; },
        (value) => { value.codexBin = " "; },
    ]) {
        const invalid = structuredClone(config);
        mutate(invalid);
        assert.throws(() => validateBridgeConfig(invalid));
    }
});
test("通知方法だけの変更は閾値到達履歴を保つ", async (context) => {
    const { bridge, config, state, notifications } = setup(context);
    config.services.codex.notifyEvery = 20;
    await bridge.configure(config);
    await bridge.refresh("codex");
    state.remaining = 79;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
    config.services.codex.notifyMethod = "notification";
    await bridge.configure(config);
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
    state.remaining = 59;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 2);
    assert.equal(notifications()[1].method, "notification");
});
test("閾値や除外の変更は現在値を基準にし、表示は維持する", async (context) => {
    const { bridge, config, state, events, notifications } = setup(context, { remaining: 25 });
    await bridge.configure(config);
    await bridge.refresh("codex");
    config.services.codex.notifyBelow = 30;
    await bridge.configure(config);
    await bridge.refresh("codex");
    assert.equal(notifications().length, 0);
    state.remaining = 40;
    await bridge.refresh("codex");
    state.remaining = 29;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
    config.services.codex.notifyExclude = ["CODEX / PRIMARY"];
    await bridge.configure(config);
    state.remaining = 1;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
    assert.equal(events.filter((event) => event.type === "snapshot").at(-1).snapshot.limits.length, 2);
    config.services.codex.notifyExclude = [];
    await bridge.configure(config);
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
});
test("取得失敗は成功値を保ち、他サービスの更新とエラー重複抑制を維持する", async (context) => {
    const { bridge, config, state, events, notifications } = setup(context);
    config.services.codex.notifyApiError = true;
    await bridge.configure(config);
    await bridge.refresh();
    const lastSuccess = bridge.states.get("codex");
    state.failCodex = true;
    await bridge.refresh();
    await bridge.refresh();
    assert.equal(bridge.states.get("codex"), lastSuccess);
    assert.equal(notifications().length, 1);
    assert.equal(state.calls.claude, 3);
    assert.doesNotMatch(JSON.stringify(events), /secret/);
    state.failCodex = false;
    await bridge.refresh("codex");
    state.failCodex = true;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 2);
});
test("エラー通知を有効にするだけでは継続中の失敗を通知しない", async (context) => {
    const { bridge, config, state, notifications } = setup(context);
    state.failCodex = true;
    await bridge.configure(config);
    await bridge.refresh("codex");
    config.services.codex.notifyApiError = true;
    await bridge.configure(config);
    await bridge.refresh("codex");
    assert.equal(notifications().length, 0);
    state.failCodex = false;
    await bridge.refresh("codex");
    state.failCodex = true;
    await bridge.refresh("codex");
    assert.equal(notifications().length, 1);
});
test("古い値とリセット済みの値から残量通知を出さない", async (context) => {
    const { bridge, config, events, notifications } = setup(context, { remaining: 5, old: true });
    config.services.codex.notifyBelow = 20;
    await bridge.configure(config);
    await bridge.refresh("codex");
    assert.equal(events.at(-1).stale, true);
    assert.equal(notifications().length, 0);
    const snapshot = demoSnapshot("codex");
    snapshot.limits[0].resetsAtEpochSeconds = Math.floor(Date.now() / 1000) - 1;
    assert.equal(snapshotIsStale(snapshot), true);
});
test("429の待機時間中は手動更新でも再取得せず、Codexは継続する", async (context) => {
    const { bridge, config, state, advance } = setup(context);
    state.failClaude = true;
    state.retry = 600;
    await bridge.configure(config);
    await bridge.refresh();
    await bridge.refresh();
    assert.equal(state.calls.claude, 1);
    assert.equal(state.calls.codex, 2);
    advance(600000);
    state.failClaude = false;
    await bridge.refresh("claude");
    assert.equal(state.calls.claude, 2);
});
test("遅れて返る短いRetry-Afterでも次の定期取得を見送らない", async (context) => {
    let poll;
    context.mock.method(globalThis, "setInterval", (callback) => { poll = callback; });
    const { bridge, config, state, advance, events } = setup(context);
    state.failClaude = true;
    state.retry = 60;
    await bridge.configure(config);
    advance(5000);
    await bridge.refresh("claude");
    const failure = events.find((event) => event.type === "error");
    assert.equal(failure.diagnostic.retryNotBefore, "2026-10-04T10:01:05.000Z");
    assert.equal(failure.diagnostic.nextAttemptAt, "2026-10-04T10:03:00.000Z");
    state.failClaude = false;
    advance(175000);
    poll();
    const pending = bridge.inFlight.get("claude");
    assert.ok(pending, "180秒の定期取得がClaudeの取得を開始する");
    await pending;
    assert.equal(state.calls.claude, 2);
    assert.equal(state.calls.codex, 1);
});
test("短いRetry-Afterは指定期限まで手動更新を止め、期限ちょうどに再開する", async (context) => {
    const { bridge, config, state, advance } = setup(context);
    state.failClaude = true;
    state.retry = 60;
    await bridge.configure(config);
    advance(5000);
    await bridge.refresh("claude");
    state.failClaude = false;
    advance(59999);
    await bridge.refresh("claude");
    assert.equal(state.calls.claude, 1);
    advance(1);
    await bridge.refresh("claude");
    assert.equal(state.calls.claude, 2);
});
test("設定変更でもClaudeの429待機期限を保持し、期限後に取得を再開する", async (context) => {
    for (const change of [
        (config) => { config.codexBin = "another-codex"; },
        (config) => { config.timeoutSeconds = 16; },
        (config) => { config.claudeSource = "api"; },
        (config) => { config.intervalSeconds = 60; },
        (config) => { config.services.claude.notifyBelow = 80; },
    ]) {
        const { bridge, config, state, advance, events } = setup(context);
        state.failClaude = true;
        state.retry = 600;
        await bridge.configure(config);
        await bridge.refresh("claude");
        const deadline = bridge.nextAllowedAt.get("claude");
        state.failClaude = false;
        change(config);
        await bridge.configure(config);
        await bridge.refresh();
        assert.equal(state.calls.claude, 1);
        assert.equal(state.calls.codex, 1);
        assert.equal(bridge.nextAllowedAt.get("claude"), deadline);
        assert.equal(events.findLast((event) => event.type === "diagnostic").diagnostic.retryNotBefore,
            "2026-10-04T10:10:00.000Z");
        advance(599999);
        await bridge.refresh("claude");
        assert.equal(state.calls.claude, 1);
        advance(1);
        await bridge.refresh("claude");
        assert.equal(state.calls.claude, 2);
        assert.equal(bridge.nextAllowedAt.has("claude"), false);
    }
});
test("サンプル・キャッシュ表示への切替は429待機を迂回して表示し、API復帰時には待機する", async (context) => {
    const { bridge, config, state, advance, events } = setup(context);
    const calls = { api: 0, cache: 0 };
    bridge.collectors.claude = async (settings) => {
        if (settings.claudeSource === "statusline") {
            calls.cache++;
            return demoSnapshot("claude", new Date("2026-10-04T10:00:00Z"));
        }
        calls.api++;
        if (state.failClaude) throw new UsageApiError("回数制限", 600);
        return demoSnapshot("claude", new Date("2026-10-04T10:00:00Z"));
    };
    state.failClaude = true;
    await bridge.configure(config);
    await bridge.refresh("claude");
    const deadline = bridge.nextAllowedAt.get("claude");
    state.failClaude = false;
    config.demo = true;
    await bridge.configure(config);
    await bridge.refresh("claude");
    assert.equal(events.at(-1).type, "snapshot");
    assert.equal(events.at(-1).demo, true);
    assert.equal(bridge.nextAllowedAt.get("claude"), deadline);
    assert.equal(calls.api, 1);
    config.demo = false;
    config.claudeSource = "statusline";
    await bridge.configure(config);
    await bridge.refresh("claude");
    assert.equal(calls.cache, 1);
    assert.equal(events.at(-1).diagnostic.source, "cache");
    assert.equal(events.at(-1).diagnostic.retryNotBefore, undefined);
    assert.equal(bridge.nextAllowedAt.get("claude"), deadline);
    config.claudeSource = "auto";
    await bridge.configure(config);
    await bridge.refresh("claude");
    assert.equal(calls.api, 1);
    advance(600000);
    await bridge.refresh("claude");
    assert.equal(calls.api, 2);
});
test("保存済みの通知条件があってもサンプルから通知せず、実取得では通知する", async (context) => {
    for (const method of ["popup", "notification"]) {
        const { bridge, config, state, events, notifications } = setup(context, { remaining: 50 });
        config.demo = true;
        for (const service of ["codex", "claude"]) {
            config.services[service].notifyBelow = 80;
            config.services[service].notifyEvery = 20;
            config.services[service].notifyApiError = true;
            config.services[service].notifyMethod = method;
        }
        await bridge.configure(config);
        await bridge.refresh();
        await bridge.refresh();
        assert.equal(events.filter((event) => event.type === "snapshot").length, 4);
        assert.equal(state.calls.claude, 0);
        assert.equal(state.calls.codex, 0);
        assert.equal(notifications().length, 0);
        assert.equal(bridge.notifiers.get("claude").states.size, 0);
        config.demo = false;
        await bridge.configure(config);
        await bridge.refresh();
        assert.ok(notifications().length > 0);
        assert.ok(notifications().every((event) => event.demo === false && event.method === method));
        const count = notifications().length;
        config.demo = true;
        await bridge.configure(config);
        await bridge.refresh();
        assert.equal(notifications().length, count);
    }
});
test("GUI診断はHTTP理由と待機・次回の周期を伝え、再試行や通知を増やさない", async (context) => {
    const { bridge, config, state, events, advance, notifications } = setup(context);
    config.services.claude.notifyApiError = true;
    let calls = 0;
    bridge.collectors.claude = async () => {
        calls++;
        throw new UsageApiError("secret upstream body", 600, { code: "api_rate_limit", httpStatus: 429 });
    };
    await bridge.configure(config);
    await bridge.refresh("claude");
    const error = events.find((event) => event.type === "error");
    assert.equal(error.diagnostic.code, "api_rate_limit");
    assert.equal(error.diagnostic.httpStatus, 429);
    assert.equal(error.diagnostic.retryAfterSeconds, 600);
    assert.equal(error.diagnostic.retryNotBefore, "2026-10-04T10:10:00.000Z");
    assert.equal(error.diagnostic.nextAttemptAt, "2026-10-04T10:12:00.000Z");
    await bridge.refresh();
    assert.equal(events.find((event) => event.type === "diagnostic").diagnostic.code, "retry_wait");
    assert.equal(calls, 1);
    assert.equal(state.calls.codex, 1);
    advance(600000);
    await bridge.refresh("claude");
    assert.equal(calls, 2);
    assert.equal(notifications().length, 1);
    assert.doesNotMatch(JSON.stringify(events), /secret/);
});
test("GUI診断は未知のエラーや余分なフィールド・コードを転送しない", async (context) => {
    const { bridge, config, events } = setup(context);
    await bridge.configure(config);
    for (const failure of [
        Object.assign(new Error("secret token"), { diagnostic: { code: "secret token", message: "secret" } }),
        new UsageApiError("secret", undefined, { code: "keychain_access", exitStatus: 44, message: "secret", networkCode: "secret" }),
    ]) {
        bridge.collectors.claude = async () => { throw failure; };
        await bridge.refresh("claude");
    }
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors[0].diagnostic.code, "unknown_error");
    assert.equal(errors[1].diagnostic.code, "keychain_access");
    assert.equal(errors[1].diagnostic.exitStatus, 44);
    assert.doesNotMatch(JSON.stringify(events), /secret/);
});
test("失敗後の成功もGUI診断に含め、キャッシュの取得元を区別する", async (context) => {
    const { bridge, config, state, events } = setup(context);
    await bridge.configure(config);
    state.failClaude = true;
    bridge.collectors.fallback = () => demoSnapshot("claude", new Date("2026-10-04T10:00:00Z"));
    await bridge.refresh("claude");
    const fallback = events.find((event) => event.type === "snapshot");
    assert.equal(fallback.diagnostic.code, "cache_fallback");
    assert.equal(fallback.diagnostic.source, "cache");
    state.failClaude = false;
    await bridge.refresh("claude");
    assert.equal(events.at(-1).diagnostic.code, "success");
    assert.equal(events.at(-1).diagnostic.source, "api");
});
test("同時の更新要求をまとめ、停止後に取得しない", async (context) => {
    const { bridge, config, state } = setup(context);
    await bridge.configure(config);
    await Promise.all([bridge.refresh("codex"), bridge.refresh("codex")]);
    assert.equal(state.calls.codex, 1);
    await bridge.stop();
    await bridge.refresh();
    assert.equal(state.calls.claude, 0);
});
test("取得中のサンプル切替はキャンセルし、古い応答を送らない", async (context) => {
    const events = [];
    let release;
    const collectors = {
        async codex() { await new Promise((resolve) => { release = resolve; }); return demoSnapshot("codex"); },
        async claude() { return demoSnapshot("claude"); },
        async close() { release?.(); },
    };
    const bridge = new WidgetBridge((event) => events.push(event), collectors, Date.now, () => collectors);
    context.after(() => bridge.stop());
    const config = defaultBridgeConfig();
    config.demo = false;
    await bridge.configure(config);
    const pending = bridge.refresh("codex");
    config.demo = true;
    await bridge.configure(config);
    await pending;
    assert.equal(events.filter((event) => event.type === "snapshot").length, 0);
    await bridge.refresh();
    assert.equal(events.filter((event) => event.type === "snapshot").length, 2);
});
test("停止はClaude取得にもキャンセルを伝える", async () => {
    let capturedSignal;
    const collectors = createCollectors({
        fetchUsageSnapshot: ({ signal }) => new Promise((_resolve, reject) => {
            capturedSignal = signal;
            signal.addEventListener("abort", () => reject(new Error("中止")), { once: true });
        }),
        writeCache: () => assert.fail("キャンセル値を保存しない"),
    });
    const pending = assert.rejects(collectors.claude(defaultBridgeConfig()), /中止/);
    await collectors.close();
    await pending;
    assert.equal(capturedSignal.aborted, true);
});
test("Codex応答待ちを停止し、子プロセスとタイムアウトを残さない", async (context) => {
    const fake = await createFakeCodex(context, "timeout");
    const collectors = createCollectors();
    context.after(() => collectors.close());
    const config = defaultBridgeConfig();
    config.codexBin = fake.executablePath;
    config.timeoutSeconds = 300;
    const pending = assert.rejects(collectors.codex(config), /停止/);
    await waitUntil(async () => (await readCapturedEvents(fake.capturePath)).some((event) => event.type === "read-start"));
    await collectors.close();
    await pending;
    assert.ok((await readCapturedEvents(fake.capturePath)).some((event) => event.type === "stdin-ended"));
});
test("モデル別制限も通知・スナップショットに含め、除外しても表示を残す", async (context) => {
    const { bridge, config, events, notifications } = setup(context);
    bridge.collectors.claude = async () => {
        const snapshot = demoSnapshot("claude", new Date("2026-10-04T10:00:00Z"));
        snapshot.limits.push({ ...snapshot.limits[1], limitId: "claude-fable", limitName: "Claude Fable", remainingPercent: 5, usedPercent: 95 });
        return snapshot;
    };
    config.services.claude.notifyBelow = 20;
    await bridge.configure(config);
    await bridge.refresh("claude");
    assert.equal(notifications().length, 1);
    assert.match(notifications()[0].message, /Claude Fable/);
    config.services.claude.notifyExclude = ["FABLE"];
    await bridge.configure(config);
    await bridge.refresh("claude");
    assert.equal(notifications().length, 1);
    assert.equal(events.filter((event) => event.type === "snapshot").at(-1).snapshot.limits.length, 3);
});
test("不正なNDJSON入力は安全なエラーとして返し、取得を開始しない", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk; });
    const running = runBridge(input, output);
    input.end('broken\n{"type":"configure","config":{}}\n{"type":"refresh","service":"unknown"}\n');
    await running;
    const events = text.trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.type === "protocolError"));
});
test("NDJSONで分割された設定を読み、ダミー取得してEOFで終了する", async () => {
    const child = spawn(process.execPath, [new URL("../dist/widget-bridge.mjs", import.meta.url).pathname], { stdio: "pipe" });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const command = JSON.stringify({ type: "configure", config: defaultBridgeConfig() });
    child.stdin.write(command.slice(0, 20));
    child.stdin.write(command.slice(20) + "\n");
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error("ダミー取得が終了しません。")); }, 5000);
        const check = () => {
            if (output.split("\n").filter(Boolean).length >= 3) {
                clearTimeout(timeout);
                child.stdout.removeListener("data", check);
                resolve();
            }
        };
        child.stdout.on("data", check);
        check();
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    assert.equal(await exited, 0);
    const events = output.trim().split("\n").map(JSON.parse);
    assert.equal(events.filter((event) => event.type === "snapshot").length, 2);
    assert.equal(stderr, "");
});
