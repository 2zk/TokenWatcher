#!/usr/bin/env node
import { parseArgs, helpText } from "./codex-args.mjs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.mjs";
import { formatJson, formatSnapshot } from "./codex-format.mjs";
import { normalizeRateLimits } from "./codex-limits.mjs";
import { ThresholdNotifier } from "./notifier.mjs";
import { AppServerError, CliUsageError } from "./types.mjs";
const VERSION = "0.1.0";
const UPDATE_DEBOUNCE_MS = 500;
const RATE_LIMIT_RETRY_DELAYS_MS = [10_000, 20_000, 30_000];
function filterSnapshot(snapshot, filter) {
    if (filter === undefined)
        return snapshot;
    const normalizedFilter = filter.toLowerCase();
    return {
        ...snapshot,
        limits: snapshot.limits.filter((limit) => `${limit.limitName ?? limit.limitId} / ${limit.window}`.toLowerCase().includes(normalizedFilter)),
    };
}
function writeResult(snapshot, options) {
    if (options.json) {
        process.stdout.write(`${formatJson(snapshot)}\n`);
        return;
    }
    if (options.watch && process.stdout.isTTY) {
        process.stdout.write("\x1B[2J\x1B[H");
    }
    process.stdout.write(`${formatSnapshot(snapshot, options.notifyBelow, options.notifyMethod, options.notifyEvery, options.notifyExclude, options.notifyApiError)}\n`);
}
function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`エラー: ${message}\n`);
}
async function waitForRetry(delayMs, shouldStop, setWake) {
    if (shouldStop())
        return;
    await new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = () => {
            if (done)
                return;
            done = true;
            if (timer !== undefined)
                clearTimeout(timer);
            setWake(undefined);
            resolve();
        };
        setWake(finish);
        timer = setTimeout(finish, delayMs);
    });
}
export async function readRateLimitsWithRetry(server, shouldStop, setWake, dependencies = {}) {
    const wait = dependencies.waitForRetry ?? waitForRetry;
    const reportRetry = dependencies.reportRetry ?? ((delayMs) => {
        process.stderr.write(`利用量取得に失敗したため、${delayMs / 1_000} 秒後に再試行します。\n`);
    });
    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
        if (shouldStop())
            return undefined;
        try {
            return await server.readRateLimits();
        }
        catch (error) {
            if (shouldStop())
                return undefined;
            if (attempt === RATE_LIMIT_RETRY_DELAYS_MS.length)
                throw error;
            const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
            reportRetry(delayMs);
            await wait(delayMs, shouldStop, setWake);
        }
    }
    return undefined;
}
async function readRateLimits(server, options, notifier, shouldStop, setWake, dependencies) {
    try {
        const result = await readRateLimitsWithRetry(server, shouldStop, setWake, dependencies);
        if (result !== undefined)
            notifier.clearApiError();
        return result;
    }
    catch (error) {
        if (!shouldStop() && options.notifyApiError)
            await notifier.notifyApiError(error);
        throw error;
    }
}
async function runWatch(server, options, notifier, shouldStop, setWake, readDependencies) {
    let updatePending = false;
    let wakeCurrentWait;
    const onUpdated = () => {
        updatePending = true;
        wakeCurrentWait?.();
    };
    server.on("rateLimitsUpdated", onUpdated);
    try {
        while (!shouldStop()) {
            const result = await readRateLimits(server, options, notifier, shouldStop, setWake, readDependencies);
            if (result === undefined)
                break;
            const snapshot = filterSnapshot(normalizeRateLimits(result), options.filter);
            writeResult(snapshot, options);
            await notifier.observe(snapshot);
            if (shouldStop())
                break;
            await new Promise((resolve) => {
                let done = false;
                let timer;
                const finish = () => {
                    if (done)
                        return;
                    done = true;
                    if (timer !== undefined)
                        clearTimeout(timer);
                    wakeCurrentWait = undefined;
                    setWake(undefined);
                    resolve();
                };
                wakeCurrentWait = () => {
                    if (!updatePending)
                        return;
                    updatePending = false;
                    if (timer !== undefined)
                        clearTimeout(timer);
                    timer = setTimeout(finish, UPDATE_DEBOUNCE_MS);
                };
                setWake(finish);
                if (updatePending) {
                    wakeCurrentWait();
                }
                else {
                    timer = setTimeout(finish, options.intervalSeconds * 1_000);
                }
            });
        }
    }
    finally {
        server.off("rateLimitsUpdated", onUpdated);
    }
}
export async function runCli(args, dependencies = {}) {
    let parsed;
    try {
        parsed = parseArgs(args);
    }
    catch (error) {
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
    const server = dependencies.server ?? new CodexAppServer(options.codexBin, options.timeoutSeconds * 1_000);
    const notifier = new ThresholdNotifier(options.notifyBelow, (message) => process.stderr.write(`警告: ${message}\n`), dependencies.notificationExecutor, options.notifyMethod, options.notifyEvery, undefined, options.notifyExclude);
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
        if (settings.length > 0)
            notificationSettings.push(`残量 ${settings.join(" + ")}`);
        if (options.notifyApiError)
            notificationSettings.push("API 取得エラー");
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
            void server.forceStop();
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
        try {
            await server.start();
        }
        catch (error) {
            if (!stopping && options.notifyApiError)
                await notifier.notifyApiError(error);
            throw error;
        }
        if (options.watch) {
            await runWatch(server, options, notifier, () => stopping, (nextWake) => {
                wake = nextWake;
            }, dependencies.readDependencies);
        }
        else {
            const result = await readRateLimits(server, options, notifier, () => stopping, (nextWake) => {
                wake = nextWake;
            }, dependencies.readDependencies);
            if (result === undefined)
                return receivedSignal ? 130 : exitCode;
            const snapshot = filterSnapshot(normalizeRateLimits(result), options.filter);
            writeResult(snapshot, options);
            await notifier.observe(snapshot);
        }
    }
    catch (error) {
        if (!stopping) {
            reportError(error instanceof AppServerError ? error : new AppServerError("予期しないエラーが発生しました。", error));
            exitCode = 1;
        }
    }
    finally {
        await server.stop();
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
