#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, helpText } from "./claude-args.mjs";
import { normalizeStatusLine, isStale } from "./claude-limits.mjs";
import { readCache, writeCache, cachePath } from "./claude-cache.mjs";
import { formatClaudeSnapshot, formatClaudeJson, formatStatusLine } from "./claude-format.mjs";
import { fetchUsageSnapshot } from "./claude-usage-api.mjs";
import { ThresholdNotifier } from "./notifier.mjs";
import { CliUsageError } from "./types.mjs";

const VERSION = "0.1.0";
const UPDATE_DEBOUNCE_MS = 500;
const CACHE_POLL_INTERVAL_MS = 2000;
const CACHE_WAIT_INTERVAL_MS = 5000;

function filterSnapshot(snapshot, filter) {
    if (filter === undefined) {
        return snapshot;
    }
    const normalizedFilter = filter.toLowerCase();
    return {
        ...snapshot,
        limits: snapshot.limits.filter((limit) =>
            `${limit.limitName ?? limit.limitId} / ${limit.window}`
                .toLowerCase()
                .includes(normalizedFilter),
        ),
    };
}

function writeResult(snapshot, stale, options) {
    if (options.json) {
        process.stdout.write(`${formatClaudeJson(snapshot, stale)}\n`);
        return;
    }
    if (options.watch && process.stdout.isTTY) {
        process.stdout.write("\x1B[2J\x1B[H");
    }
    process.stdout.write(
        `${formatClaudeSnapshot(snapshot, stale, options.notifyBelow, options.notifyMethod, options.notifyEvery, options.notifyExclude, options.notifyApiError)}\n`,
    );
}

function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`エラー: ${message}\n`);
}

/** stdin から全データを読み、文字列として返す。 */
function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(chunks.join("")));
        process.stdin.on("error", reject);
    });
}

/** キャッシュファイルの mtime を取得。存在しなければ 0。 */
function getCacheMtime() {
    try {
        return statSync(cachePath()).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * --statusline モード: stdin の JSON を読み、正規化してキャッシュに書き込む。
 * 有効な制限データが取れた場合のみキャッシュを更新する。
 * テストから直接呼べるようにエクスポートする。
 */
export async function runStatusLineFromText(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        process.stderr.write("エラー: stdin が有効な JSON ではありません。\n");
        return 1;
    }
    const snapshot = normalizeStatusLine(json);
    if (snapshot.limits.length === 0) {
        // 有効な制限データがないためキャッシュを更新せず最小表示のみ出す
        process.stdout.write("Claude: --\n");
        return 0;
    }
    try {
        const previous = readCache();
        const unchanged = previous !== null &&
            previous.limits.length === snapshot.limits.length &&
            previous.limits.every((limit, index) =>
                limit.limitId === snapshot.limits[index].limitId &&
                limit.window === snapshot.limits[index].window &&
                limit.usedPercent === snapshot.limits[index].usedPercent &&
                limit.resetsAtEpochSeconds === snapshot.limits[index].resetsAtEpochSeconds,
            );
        if (!unchanged) {
            writeCache(snapshot);
        }
    } catch (error) {
        reportError(new Error(
            `キャッシュの書き込みに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return 1;
    }
    process.stdout.write(`${formatStatusLine(snapshot)}\n`);
    return 0;
}

async function runStatusLine() {
    let raw;
    try {
        raw = await readStdin();
    } catch {
        process.stderr.write("エラー: stdin の読み込みに失敗しました。\n");
        return 1;
    }
    return runStatusLineFromText(raw);
}

/**
 * 利用量 API から snapshot を取得する。取得できた値はキャッシュにも保存する。
 * auto では失敗時にキャッシュへ切り替え、失敗理由を error として返す。
 */
async function loadApiSnapshot(options, fetchSnapshot, notifier) {
    try {
        const snapshot = await fetchSnapshot();
        notifier.clearApiError();
        try {
            writeCache(snapshot);
        } catch (error) {
            process.stderr.write(
                `警告: キャッシュの書き込みに失敗しました: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
        return { snapshot, error: undefined };
    } catch (error) {
        if (options.notifyApiError) {
            await notifier.notifyApiError(error);
        }
        if (options.source === "api") {
            throw error;
        }
        return { snapshot: readCache(), error };
    }
}

function reportFallback(error, hasCache) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
        hasCache
            ? `警告: ${message} キャッシュの値を表示します。\n`
            : `警告: ${message} キャッシュもありません。\n`,
    );
}

function waitSeconds(seconds, setWake) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            setWake(undefined);
            resolve();
        };
        const timer = setTimeout(finish, seconds * 1_000);
        setWake(finish);
    });
}

async function showSnapshot(snapshot, options, notifier) {
    const stale = isStale(snapshot);
    const filtered = filterSnapshot(snapshot, options.filter);
    writeResult(filtered, stale, options);
    if (!stale) {
        await notifier.observe(filtered);
    }
}

/** --source auto / api の watch: 利用量 API を一定間隔で呼ぶ。 */
async function runApiWatch(options, notifier, shouldStop, setWake, fetchSnapshot, wait) {
    while (!shouldStop()) {
        let retryAfterSeconds;
        try {
            const { snapshot, error } = await loadApiSnapshot(options, fetchSnapshot, notifier);
            if (error !== undefined) {
                reportFallback(error, snapshot !== null);
                retryAfterSeconds = error.retryAfterSeconds;
            }
            if (shouldStop()) break;
            if (snapshot !== null) {
                await showSnapshot(snapshot, options, notifier);
            }
        } catch (error) {
            if (shouldStop()) break;
            // --source api でも監視は止めず、次の間隔で再試行する
            reportError(error);
            retryAfterSeconds = error?.retryAfterSeconds;
        }
        if (shouldStop()) break;
        // 429 の Retry-After が間隔より長ければそれに従う
        await wait(Math.max(options.intervalSeconds, retryAfterSeconds ?? 0), setWake);
    }
}

/** --source statusline の watch: statusLine が書くキャッシュを監視する。 */
async function runCacheWatch(options, notifier, shouldStop, setWake) {
    let wakeCurrentWait;
    let cacheUpdatePending = false;
    let lastMtime = getCacheMtime();

    // キャッシュの更新を定期ポーリングで検出する
    const cachePoller = setInterval(() => {
        const mtime = getCacheMtime();
        if (mtime !== lastMtime) {
            lastMtime = mtime;
            cacheUpdatePending = true;
            wakeCurrentWait?.();
        }
    }, CACHE_POLL_INTERVAL_MS);

    try {
        // キャッシュが存在するまで待機（--statusline 未設定時の案内）
        let reportedWaiting = false;
        while (!shouldStop()) {
            const snapshot = readCache();
            if (snapshot !== null) {
                const stale = isStale(snapshot);
                const filtered = filterSnapshot(snapshot, options.filter);
                writeResult(filtered, stale, options);
                if (!stale) {
                    await notifier.observe(filtered);
                }
                cacheUpdatePending = false;
                break;
            }
            if (!reportedWaiting) {
                process.stderr.write("キャッシュ待機中（--statusline モードを設定してください）...\n");
                reportedWaiting = true;
            }
            await new Promise((resolve) => {
                let done = false;
                let timer;
                const finish = () => {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    wakeCurrentWait = undefined;
                    setWake(undefined);
                    resolve();
                };
                wakeCurrentWait = finish;
                setWake(finish);
                timer = setTimeout(finish, CACHE_WAIT_INTERVAL_MS);
            });
        }

        // メインの監視ループ
        while (!shouldStop()) {
            await new Promise((resolve) => {
                let done = false;
                let timer;
                const finish = () => {
                    if (done) return;
                    done = true;
                    if (timer !== undefined) {
                        clearTimeout(timer);
                    }
                    wakeCurrentWait = undefined;
                    setWake(undefined);
                    resolve();
                };
                wakeCurrentWait = () => {
                    if (!cacheUpdatePending) return;
                    cacheUpdatePending = false;
                    if (timer !== undefined) {
                        clearTimeout(timer);
                    }
                    timer = setTimeout(finish, UPDATE_DEBOUNCE_MS);
                };
                setWake(finish);
                if (cacheUpdatePending) {
                    wakeCurrentWait();
                } else {
                    timer = setTimeout(finish, options.intervalSeconds * 1_000);
                }
            });

            if (shouldStop()) break;

            const snapshot = readCache();
            if (snapshot === null) continue;
            const stale = isStale(snapshot);
            const filtered = filterSnapshot(snapshot, options.filter);
            writeResult(filtered, stale, options);
            if (!stale) {
                await notifier.observe(filtered);
            }
        }
    } finally {
        clearInterval(cachePoller);
    }
}

export async function runCli(args, dependencies = {}) {
    const fetchSnapshot = dependencies.fetchSnapshot ?? fetchUsageSnapshot;
    const wait = dependencies.waitSeconds ?? waitSeconds;
    let parsed;
    try {
        parsed = parseArgs(args);
    } catch (error) {
        if (error instanceof CliUsageError) {
            reportError(error);
            process.stderr.write("--help で使い方を確認できます。\n");
            return error.exitCode;
        }
        throw error;
    }
    if (parsed.kind === "help") {
        process.stdout.write(`${helpText()}\n`);
        return 0;
    }
    if (parsed.kind === "version") {
        process.stdout.write(`${VERSION}\n`);
        return 0;
    }
    const options = parsed.options;

    if (options.statusline) {
        return runStatusLine();
    }

    const notifier = new ThresholdNotifier(
        options.notifyBelow,
        (message) => process.stderr.write(`警告: ${message}\n`),
        dependencies.notificationExecutor,
        options.notifyMethod,
        options.notifyEvery,
        "Claude 利用制限",
        options.notifyExclude,
    );

    if (options.json && (options.notifyBelow !== undefined || options.notifyEvery !== undefined || options.notifyApiError)) {
        const method = options.notifyMethod === "popup" ? "ポップアップ" : "Mac 通知センター";
        const settings = [];
        const notificationSettings = [];
        if (options.notifyBelow !== undefined) {
            settings.push(`${options.notifyBelow}% 以下`);
        }
        if (options.notifyEvery !== undefined) {
            settings.push(`${options.notifyEvery}% 毎`);
        }
        if (settings.length > 0) notificationSettings.push(`残量 ${settings.join(" + ")}`);
        if (options.notifyApiError) notificationSettings.push("API 取得エラー");
        const exclude = options.notifyExclude.length === 0 ? "" : ` / 除外: ${options.notifyExclude.join(", ")}`;
        process.stderr.write(`通知設定: ${notificationSettings.join(" + ")} / ${method}${exclude}\n`);
    }

    let stopping = false;
    let exitCode = 0;
    let wake;
    let receivedSignal = false;

    const onSignal = (signal) => {
        if (receivedSignal) {
            process.stderr.write(`${signal} を再度受信したため、強制終了します。\n`);
            process.exit(130);
        }
        receivedSignal = true;
        stopping = true;
        wake?.();
        process.stderr.write(`${signal} を受信したため終了処理を開始します。\n`);
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    try {
        const setWake = (nextWake) => {
            wake = nextWake;
        };
        if (options.watch && options.source === "statusline") {
            await runCacheWatch(options, notifier, () => stopping, setWake);
        } else if (options.watch) {
            await runApiWatch(options, notifier, () => stopping, setWake, fetchSnapshot, wait);
        } else if (options.source !== "statusline") {
            // one-shot（API）モード
            const { snapshot, error } = await loadApiSnapshot(options, fetchSnapshot, notifier);
            if (error !== undefined) {
                reportFallback(error, snapshot !== null);
            }
            if (snapshot === null) {
                exitCode = 1;
            } else if (!stopping) {
                await showSnapshot(snapshot, options, notifier);
            }
        } else {
            // one-shot（キャッシュ）モード
            const snapshot = readCache();
            if (snapshot === null) {
                process.stderr.write(
                    "エラー: キャッシュがありません。先に --statusline モードを設定して実行してください。\n",
                );
                exitCode = 1;
            } else {
                const stale = isStale(snapshot);
                const filtered = filterSnapshot(snapshot, options.filter);
                writeResult(filtered, stale, options);
                if (!stale) {
                    await notifier.observe(filtered);
                }
            }
        }
    } catch (error) {
        if (!stopping) {
            reportError(error);
            exitCode = 1;
        }
    } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
    }

    return receivedSignal ? 130 : exitCode;
}

const invokedPath = process.argv[1] === undefined ? undefined : realpathSync(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
    runCli(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        reportError(error);
        process.exitCode = 1;
    });
}
