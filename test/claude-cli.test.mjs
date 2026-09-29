import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runStatusLineFromText, runCli } from "../dist/claude-cli.mjs";
import { formatClaudeSnapshot } from "../dist/claude-format.mjs";
import { readCache, writeCache, _setCachePath } from "../dist/claude-cache.mjs";
import { fetchUsageSnapshot, UsageApiError } from "../dist/claude-usage-api.mjs";

const cliPath = fileURLToPath(new URL("../dist/claude-cli.mjs", import.meta.url));

// --- テスト用ユーティリティ ---

function makeCachePath() {
    return join(tmpdir(), `claude-cli-test-${process.pid}-${Date.now()}.json`);
}

async function captureStdoutAsync(fn) {
    const output = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const errOutput = [];
    process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { errOutput.push(String(chunk)); return true; };
    let code;
    try {
        code = await fn();
    } finally {
        process.stdout.write = originalOut;
        process.stderr.write = originalErr;
    }
    return { stdout: output.join(""), stderr: errOutput.join(""), code };
}

function spawnCli(args, stdinData, envOverrides = {}) {
    const child = spawn(process.execPath, [cliPath, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...envOverrides },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (stdinData !== undefined) {
        child.stdin.write(stdinData);
        child.stdin.end();
    } else {
        child.stdin.end();
    }
    const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, completed };
}

function nextStdoutLine(child, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("watch の出力が時間内に届きませんでした"));
        }, timeoutMs);
        const onData = (chunk) => {
            output += chunk;
            const newline = output.indexOf("\n");
            if (newline < 0) return;
            cleanup();
            resolve(output.slice(0, newline));
        };
        const onExit = () => {
            cleanup();
            reject(new Error("watch が出力前に終了しました"));
        };
        const cleanup = () => {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            child.off("exit", onExit);
        };
        child.stdout.on("data", onData);
        child.once("exit", onExit);
    });
}

// --- --statusline モード ---

test("--statusline: 有効な JSON で statusLine 出力とキャッシュ書き込み", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const json = JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 45.5, resets_at: 1720018000 },
                seven_day: { used_percentage: 23.0, resets_at: 1720500000 },
            },
        });
        const { stdout, stderr, code } = await captureStdoutAsync(() => runStatusLineFromText(json));
        assert.equal(code, 0);
        assert.equal(stderr, "");
        assert.match(stdout, /^Claude 5h:/);
        assert.match(stdout, /7d:/);

        // キャッシュが書き込まれていること
        const cached = readCache();
        assert.ok(cached !== null);
        assert.equal(cached.limits.length, 2);
        assert.equal(cached.limits[0].window, "five_hour");
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("--statusline: 不正な JSON はエラー終了", async () => {
    const { stderr, code } = await captureStdoutAsync(() => runStatusLineFromText("not json"));
    assert.equal(code, 1);
    assert.match(stderr, /JSON/);
});

test("--statusline: rate_limits が空なら 'Claude: --' を出力しキャッシュを更新しない", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const json = JSON.stringify({});
        const { stdout, code } = await captureStdoutAsync(() => runStatusLineFromText(json));
        assert.equal(code, 0);
        assert.match(stdout, /Claude: --/);

        // キャッシュが作成されていないこと
        const cached = readCache();
        assert.equal(cached, null);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("--statusline: 同じ値の再送ではキャッシュの受信時刻を新しくしない", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const oldTime = Math.floor(Date.now() / 1000) - 400;
        const resetTime = Math.floor(Date.now() / 1000) + 10_000;
        writeCache({
            schemaVersion: 1,
            receivedAt: oldTime,
            observedAt: new Date(oldTime * 1000).toISOString(),
            limits: [{
                limitId: "claude",
                limitName: "Claude",
                window: "five_hour",
                windowDurationMins: 300,
                usedPercent: 30,
                remainingPercent: 70,
                resetsAtEpochSeconds: resetTime,
                resetsAt: new Date(resetTime * 1000).toISOString(),
            }],
        });
        const json = JSON.stringify({
            rate_limits: { five_hour: { used_percentage: 30, resets_at: resetTime } },
        });
        const { code } = await captureStdoutAsync(() => runStatusLineFromText(json));
        assert.equal(code, 0);
        assert.equal(readCache().receivedAt, oldTime);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

// --- one-shot モード ---

test("Claude の通知設定を短く表示する", () => {
    const snapshot = { observedAt: "2026-09-22T00:00:00.000Z", limits: [] };
    const every = formatClaudeSnapshot(snapshot, false, undefined, "popup", 5);
    assert.match(every.split("\n")[0], /^取得日時: [^\n]+【通知設定: 残量 5% 毎 \/ ポップアップ】$/);

    const combined = formatClaudeSnapshot(snapshot, false, 10, "notification", 5);
    assert.match(combined.split("\n")[0], /^取得日時: [^\n]+【通知設定: 残量 10% 以下 \+ 5% 毎 \/ Mac 通知センター】$/);

    const excluded = formatClaudeSnapshot(snapshot, false, undefined, "popup", 10, ["claude / five_hour"]);
    assert.match(excluded.split("\n")[0], /^取得日時: [^\n]+【通知設定: 残量 10% 毎 \/ ポップアップ \/ 除外: claude \/ five_hour】$/);

    const apiError = formatClaudeSnapshot(snapshot, false, undefined, "popup", undefined, [], true);
    assert.match(apiError.split("\n")[0], /^取得日時: [^\n]+【通知設定: API 取得エラー \/ ポップアップ】$/);
});

test("one-shot: キャッシュなしはエラー + 終了コード 1", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli(["--source", "statusline"]));
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, /キャッシュがありません/);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot: 新鮮なキャッシュを人向けに表示する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const now = Math.floor(Date.now() / 1000);
        writeCache({
            schemaVersion: 1,
            receivedAt: now,
            observedAt: new Date(now * 1000).toISOString(),
            limits: [{
                limitId: "claude",
                limitName: "Claude",
                window: "five_hour",
                windowDurationMins: 300,
                usedPercent: 45.5,
                remainingPercent: 54.5,
                resetsAtEpochSeconds: now + 10000,
                resetsAt: new Date((now + 10000) * 1000).toISOString(),
            }],
        });
        const { stdout, code } = await captureStdoutAsync(() => runCli(["--source", "statusline"]));
        assert.equal(code, 0);
        assert.match(stdout, /取得日時:/);
        assert.doesNotMatch(stdout, /最新データが取得できていません/);
        assert.match(stdout, /five_hour/);
        assert.match(stdout, /54\.5%/);
        assert.match(stdout, /^取得日時: \d{4}-\d{2}-\d{2} /);
        assert.match(stdout, /リセット \d{4}-\d{2}-\d{2} /);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot: stale なキャッシュは末尾に注記を含む", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const oldTime = Math.floor(Date.now() / 1000) - 400;
        writeCache({
            schemaVersion: 1,
            receivedAt: oldTime,
            observedAt: new Date(oldTime * 1000).toISOString(),
            limits: [{
                limitId: "claude",
                limitName: "Claude",
                window: "five_hour",
                windowDurationMins: 300,
                usedPercent: 60,
                remainingPercent: 40,
                resetsAtEpochSeconds: oldTime + 10000,
                resetsAt: new Date((oldTime + 10000) * 1000).toISOString(),
            }],
        });
        const { stdout, code } = await captureStdoutAsync(() => runCli(["--source", "statusline"]));
        assert.equal(code, 0);
        assert.doesNotMatch(stdout, /参考値/);
        assert.match(stdout.trimEnd().split("\n").at(-1), /^※ 最新データが取得できていません$/);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot: --json でキャッシュを JSON 出力し stale フラグが含まれる", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const now = Math.floor(Date.now() / 1000);
        writeCache({
            schemaVersion: 1,
            receivedAt: now,
            observedAt: new Date(now * 1000).toISOString(),
            limits: [{
                limitId: "claude",
                limitName: "Claude",
                window: "seven_day",
                windowDurationMins: 10080,
                usedPercent: 10,
                remainingPercent: 90,
                resetsAtEpochSeconds: now + 500000,
                resetsAt: new Date((now + 500000) * 1000).toISOString(),
            }],
        });
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli([
            "--source", "statusline", "--json", "--notify-below", "30", "--notify-every", "20", "--notify-method", "notification",
        ]));
        assert.equal(code, 0);
        assert.equal(stderr, "通知設定: 残量 30% 以下 + 20% 毎 / Mac 通知センター\n");
        const parsed = JSON.parse(stdout.trim());
        assert.equal(parsed.schemaVersion, 1);
        assert.equal(typeof parsed.stale, "boolean");
        assert.equal(parsed.stale, false);
        assert.equal(parsed.limits.length, 1);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot: --json で stale なキャッシュは stale:true を含む", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const oldTime = Math.floor(Date.now() / 1000) - 500;
        writeCache({
            schemaVersion: 1,
            receivedAt: oldTime,
            observedAt: new Date(oldTime * 1000).toISOString(),
            limits: [],
        });
        const { stdout, code } = await captureStdoutAsync(() => runCli(["--source", "statusline", "--json"]));
        assert.equal(code, 0);
        const parsed = JSON.parse(stdout.trim());
        assert.equal(parsed.stale, true);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

// --- CLI プロセス境界テスト ---

test("help と version の exit code は CLI 境界でも正しい", async () => {
    const help = spawnCli(["--help"]);
    const helpResult = await help.completed;
    assert.equal(helpResult.code, 0);
    assert.match(helpResult.stdout, /--statusline/);
    assert.match(helpResult.stdout, /v2\.1\.251/);

    const version = spawnCli(["--version"]);
    const versionResult = await version.completed;
    assert.equal(versionResult.code, 0);
    assert.match(versionResult.stdout, /^0\.1\.0\n$/);

    const invalid = spawnCli(["--interval", "59"]);
    const invalidResult = await invalid.completed;
    assert.equal(invalidResult.code, 2);
    assert.equal(invalidResult.stdout, "");
    assert.match(invalidResult.stderr, /60 以上の整数/);
});

test("--statusline は CLI プロセスで stdin を読んでキャッシュし出力する", async () => {
    const isolatedTmpDir = mkdtempSync(join(tmpdir(), "claude-statusline-test-"));
    const statuslineJson = JSON.stringify({
        rate_limits: {
            five_hour: { used_percentage: 30, resets_at: Math.floor(Date.now() / 1000) + 10000 },
        },
    });
    try {
        const run = spawnCli(["--statusline"], statuslineJson, { TMPDIR: isolatedTmpDir });
        const result = await run.completed;
        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.match(result.stdout, /^Claude 5h:/);
        assert.match(result.stdout.trim(), /70%/);

        const oneShot = spawnCli(["--source", "statusline", "--json"], undefined, { TMPDIR: isolatedTmpDir });
        const oneShotResult = await oneShot.completed;
        assert.equal(oneShotResult.code, 0);
        assert.equal(JSON.parse(oneShotResult.stdout).limits[0].remainingPercent, 70);

        const cacheDir = join(isolatedTmpDir, `token-watcher-claude-${process.getuid()}`);
        assert.equal(statSync(cacheDir).mode & 0o077, 0);
        assert.equal(statSync(join(cacheDir, "cache.json")).mode & 0o077, 0);

        const filtered = spawnCli(["--source", "statusline", "--json", "--filter", "seven_day"], undefined, { TMPDIR: isolatedTmpDir });
        const filteredResult = await filtered.completed;
        assert.equal(filteredResult.code, 0);
        assert.deepEqual(JSON.parse(filteredResult.stdout).limits, []);
    } finally {
        rmSync(isolatedTmpDir, { recursive: true, force: true });
    }
});

test("--statusline に不正 JSON を渡すと終了コード 1", async () => {
    const run = spawnCli(["--statusline"], "invalid json here");
    const result = await run.completed;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /JSON/);
});

test("watch はキャッシュを待ち、受信後と次の更新後に NDJSON を出す", { timeout: 20_000 }, async () => {
    const isolatedTmpDir = mkdtempSync(join(tmpdir(), "claude-watch-test-"));
    const env = { TMPDIR: isolatedTmpDir };
    const watcher = spawnCli(["--source", "statusline", "--watch", "--json", "--interval", "60"], undefined, env);
    try {
        const firstLine = nextStdoutLine(watcher.child);
        const firstStatus = spawnCli(["--statusline"], JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 10_000 },
            },
        }), env);
        assert.equal((await firstStatus.completed).code, 0);
        assert.equal(JSON.parse(await firstLine).limits[0].remainingPercent, 90);

        const secondLine = nextStdoutLine(watcher.child);
        const secondStatus = spawnCli(["--statusline"], JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 30, resets_at: Math.floor(Date.now() / 1000) + 10_000 },
            },
        }), env);
        assert.equal((await secondStatus.completed).code, 0);
        assert.equal(JSON.parse(await secondLine).limits[0].remainingPercent, 70);
    } finally {
        watcher.child.kill("SIGINT");
        await watcher.completed;
        rmSync(isolatedTmpDir, { recursive: true, force: true });
    }
});

// --- 利用量 API（--source auto / api） ---

/** テストランナー自身の出力が stdout に混ざるため、snapshot の JSON 行だけを取り出す。 */
function snapshotLines(stdout) {
    return stdout.split("\n").filter((line) => line.startsWith("{\"schemaVersion\""));
}

function apiSnapshot(usedPercent = 30) {
    const now = Math.floor(Date.now() / 1000);
    return {
        schemaVersion: 1,
        receivedAt: now,
        observedAt: new Date(now * 1000).toISOString(),
        limits: [{
            limitId: "claude",
            limitName: "Claude",
            window: "five_hour",
            windowDurationMins: 300,
            usedPercent,
            remainingPercent: 100 - usedPercent,
            resetsAtEpochSeconds: now + 10000,
            resetsAt: new Date((now + 10000) * 1000).toISOString(),
        }],
    };
}

test("one-shot auto: API の値を表示し、キャッシュにも保存する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli(["--json"], {
            fetchSnapshot: async () => apiSnapshot(30),
        }));
        assert.equal(code, 0);
        assert.equal(stderr, "");
        const lines = snapshotLines(stdout);
        assert.equal(lines.length, 1);
        const parsed = JSON.parse(lines[0]);
        assert.equal(parsed.stale, false);
        assert.equal(parsed.limits[0].remainingPercent, 70);
        assert.equal(readCache().limits[0].usedPercent, 30);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot auto: モデル別の週次制限を表示し --filter で絞り込める", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const snapshot = apiSnapshot(30);
        snapshot.limits.push({
            ...snapshot.limits[0],
            limitId: "claude-fable",
            limitName: "Claude Fable",
            window: "seven_day",
            windowDurationMins: 10080,
            usedPercent: 5,
            remainingPercent: 95,
        });
        const text = await captureStdoutAsync(() => runCli([], { fetchSnapshot: async () => snapshot }));
        assert.equal(text.code, 0);
        assert.match(text.stdout, /Claude Fable \/ seven_day \/ 7日（週次）: 残量 95\.0% \/ リセット/);
        const filtered = await captureStdoutAsync(() => runCli(["--json", "--filter", "fable"], {
            fetchSnapshot: async () => snapshot,
        }));
        const limits = JSON.parse(snapshotLines(filtered.stdout)[0]).limits;
        assert.deepEqual(limits.map((l) => l.limitId), ["claude-fable"]);
        assert.equal(readCache().limits[1].limitId, "claude-fable");
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot auto: API 失敗時は警告してキャッシュを表示する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const notifications = [];
        writeCache(apiSnapshot(40));
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli(["--notify-api-error"], {
            fetchSnapshot: async () => { throw new Error("API 失敗"); },
            notificationExecutor: async (...args) => { notifications.push(args); },
        }));
        assert.equal(code, 0);
        assert.match(stderr, /警告: API 失敗 キャッシュの値を表示します。/);
        assert.match(stdout, /残量 60\.0%/);
        assert.match(stdout, /通知設定: API 取得エラー \/ ポップアップ/);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0][1][2], /API 失敗/);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("one-shot auto: API 失敗かつキャッシュなしは終了コード 1", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli([], {
            fetchSnapshot: async () => { throw new Error("API 失敗"); },
        }));
        assert.equal(code, 1);
        assert.equal(snapshotLines(stdout).length, 0);
        assert.match(stderr, /キャッシュもありません/);
    } finally {
        _setCachePath(null);
    }
});

test("one-shot api: API 失敗時はキャッシュがあってもエラー終了する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const notifications = [];
        writeCache(apiSnapshot(40));
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli(["--source", "api", "--notify-api-error", "--notify-method", "notification"], {
            fetchSnapshot: async () => { throw new Error("API 失敗"); },
            notificationExecutor: async (...args) => { notifications.push(args); },
        }));
        assert.equal(code, 1);
        assert.equal(snapshotLines(stdout).length, 0);
        assert.match(stderr, /エラー: API 失敗/);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0][1][1], /display notification/);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("Claude の認証情報取得失敗も API エラーとして通知する", async () => {
    const notifications = [];
    const result = await captureStdoutAsync(() => runCli(["--source", "api", "--notify-api-error"], {
        fetchSnapshot: () => fetchUsageSnapshot({
            readCredentials: async () => { throw new UsageApiError("認証情報を読めませんでした"); },
        }),
        notificationExecutor: async (...args) => { notifications.push(args); },
    }));
    assert.equal(result.code, 1);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0][1][2], /認証情報を読めませんでした/);
});

test("one-shot statusline: API を呼ばない", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        writeCache(apiSnapshot(10));
        let called = false;
        const notifications = [];
        const { code } = await captureStdoutAsync(() => runCli(["--source", "statusline", "--notify-api-error"], {
            fetchSnapshot: async () => { called = true; return apiSnapshot(); },
            notificationExecutor: async (...args) => { notifications.push(args); },
        }));
        assert.equal(code, 0);
        assert.equal(called, false);
        assert.deepEqual(notifications, []);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

/** runCli が登録した SIGINT リスナーだけを呼ぶ（テストランナーのハンドラは呼ばない）。 */
function sigintCaller() {
    const before = new Set(process.listeners("SIGINT"));
    return () => {
        for (const listener of process.listeners("SIGINT")) {
            if (!before.has(listener)) listener("SIGINT");
        }
    };
}

test("watch auto: API の値を NDJSON で出し、429 の Retry-After を待機に反映する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const sendSigint = sigintCaller();
        let calls = 0;
        const waits = [];
        const { stdout, stderr, code } = await captureStdoutAsync(() => runCli(["--watch", "--json", "--interval", "60"], {
            fetchSnapshot: async () => {
                calls += 1;
                if (calls === 1) return apiSnapshot(25);
                const error = new Error("回数制限");
                error.retryAfterSeconds = 600;
                throw error;
            },
            waitSeconds: async (seconds) => {
                waits.push(seconds);
                if (waits.length === 2) sendSigint();
            },
        }));
        assert.equal(code, 130);
        assert.equal(calls, 2);
        // 1回目は通常の間隔、429 の後は Retry-After の長い方
        assert.deepEqual(waits, [60, 600]);
        assert.match(stderr, /警告: 回数制限 キャッシュの値を表示します。/);
        const lines = snapshotLines(stdout);
        assert.equal(lines.length, 2);
        assert.equal(JSON.parse(lines[0]).limits[0].remainingPercent, 75);
        assert.equal(JSON.parse(lines[1]).limits[0].remainingPercent, 75);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});

test("watch api: 連続失敗は1回通知し、成功後の再失敗は再通知する", async () => {
    const cachePath = makeCachePath();
    _setCachePath(cachePath);
    try {
        const sendSigint = sigintCaller();
        const notifications = [];
        let calls = 0;
        let waits = 0;
        const { code, stderr } = await captureStdoutAsync(() => runCli([
            "--source", "api", "--watch", "--notify-api-error", "--json",
        ], {
            fetchSnapshot: async () => {
                calls += 1;
                if (calls === 3) return apiSnapshot(20);
                throw new Error(`取得失敗 ${calls}`);
            },
            notificationExecutor: async (...args) => { notifications.push(args); },
            waitSeconds: async () => {
                waits += 1;
                if (waits === 4) sendSigint();
            },
        }));
        assert.equal(code, 130);
        assert.equal(calls, 4);
        assert.equal(notifications.length, 2);
        assert.match(notifications[0][1][2], /取得失敗 1/);
        assert.match(notifications[1][1][2], /取得失敗 4/);
        assert.match(stderr, /エラー: 取得失敗 2/);
    } finally {
        try { rmSync(cachePath); } catch {}
        _setCachePath(null);
    }
});
