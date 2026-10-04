#!/usr/bin/env node
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-app-server.mjs";
import { normalizeRateLimits } from "./codex-limits.mjs";
import { readRateLimitsWithRetry } from "./codex-cli.mjs";
import { fetchUsageSnapshot, UsageApiError } from "./claude-usage-api.mjs";
import { AppServerError } from "./types.mjs";
import { readCache, writeCache } from "./claude-cache.mjs";
import { ThresholdNotifier } from "./notifier.mjs";

const SERVICES = ["codex", "claude"];
const ERROR_CODES = new Set([
    "keychain_timeout", "keychain_access", "credentials_invalid", "credentials_missing", "credentials_expired",
    "api_timeout", "api_network", "api_auth", "api_rate_limit", "api_http", "api_invalid_json", "api_missing_limits",
]);
const NETWORK_CODES = new Set([
    "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
// 生の message / cause / stderr は GUI に渡さず、既知の分類と値だけを渡す。
function safeErrorDiagnostic(service, error, config) {
    if (service === "claude" && config.claudeSource === "statusline")
        return { code: "cache_unavailable" };
    if (service === "claude" && error instanceof UsageApiError) {
        const detail = error.diagnostic;
        const result = { code: ERROR_CODES.has(detail?.code) ? detail.code : "unknown_error" };
        if (boundedInteger(detail?.httpStatus, 100, 599)) result.httpStatus = detail.httpStatus;
        if (boundedInteger(detail?.exitStatus, 0, 255)) result.exitStatus = detail.exitStatus;
        if (NETWORK_CODES.has(detail?.networkCode)) result.networkCode = detail.networkCode;
        return result;
    }
    if (service === "codex" && error instanceof AppServerError) {
        if (["ENOENT", "EACCES", "ENOEXEC"].includes(error.cause?.code))
            return { code: "codex_start", networkCode: error.cause.code };
        if (/^.+ が \d+ 秒以内に応答しませんでした。$/.test(error.message))
            return { code: "codex_timeout" };
        if (error.message.startsWith("認証または利用量取得に対応しない認証方式"))
            return { code: "codex_auth" };
        if (error.message.startsWith("Codex app-server が途中で終了しました"))
            return { code: "codex_exit" };
        return { code: "codex_server" };
    }
    return { code: "unknown_error" };
}
function diagnosticDate(timestamp) {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
export function defaultBridgeConfig() {
    const settings = () => ({ notifyBelow: null, notifyEvery: null, notifyMethod: "popup", notifyApiError: false, notifyExclude: [] });
    return { demo: true, intervalSeconds: 180, codexBin: "codex", timeoutSeconds: 15, claudeSource: "auto", services: { codex: settings(), claude: settings() } };
}
function boundedInteger(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
export function validateBridgeConfig(config) {
    if (!config || typeof config.demo !== "boolean" ||
        !boundedInteger(config.intervalSeconds, 60, 86400) ||
        !boundedInteger(config.timeoutSeconds, 1, 300) ||
        typeof config.codexBin !== "string" || config.codexBin.trim() === "" ||
        !["auto", "api", "statusline"].includes(config.claudeSource)) {
        throw new Error("取得設定が不正です。");
    }
    for (const service of SERVICES) {
        const settings = config.services?.[service];
        if (!settings ||
            !(settings.notifyBelow === null || boundedInteger(settings.notifyBelow, 0, 100)) ||
            !(settings.notifyEvery === null || boundedInteger(settings.notifyEvery, 1, 99)) ||
            !["popup", "notification"].includes(settings.notifyMethod) ||
            typeof settings.notifyApiError !== "boolean" ||
            !Array.isArray(settings.notifyExclude) ||
            settings.notifyExclude.some((pattern) => typeof pattern !== "string" || pattern.trim() === "")) {
            throw new Error("通知設定が不正です。");
        }
    }
    return structuredClone(config);
}
export function snapshotIsStale(snapshot, now = Date.now()) {
    const observed = Date.parse(snapshot.observedAt);
    return !Number.isFinite(observed) || now - observed >= 300000 ||
        snapshot.limits.some((limit) => limit.resetsAtEpochSeconds !== null && now >= limit.resetsAtEpochSeconds * 1000);
}
export function demoSnapshot(service, now = new Date()) {
    const values = service === "codex" ? [75, 42] : [54, 77];
    const windows = service === "codex" ? ["primary", "secondary"] : ["five_hour", "seven_day"];
    return { schemaVersion: 1, observedAt: now.toISOString(), limits: values.map((remainingPercent, index) => ({
        limitId: service, limitName: service === "codex" ? "Codex" : "Claude", window: windows[index],
        windowDurationMins: index === 0 ? 300 : 10080, usedPercent: 100 - remainingPercent, remainingPercent,
        resetsAtEpochSeconds: Math.floor(now.getTime() / 1000) + (index === 0 ? 7200 : 259200),
        resetsAt: new Date(now.getTime() + (index === 0 ? 7200000 : 259200000)).toISOString(),
    })) };
}
export function createCollectors(dependencies = {}) {
    const cancellation = new AbortController();
    let server;
    let stopped = false;
    let wakeRetry;
    return {
        async codex(config) {
            try {
                if (!server) {
                    server = new CodexAppServer(config.codexBin, config.timeoutSeconds * 1000);
                    await server.start();
                }
                const result = await readRateLimitsWithRetry(server, () => stopped, (wake) => { wakeRetry = wake; }, {
                    reportRetry: () => {},
                });
                if (result === undefined)
                    throw new Error("取得を停止しました。");
                return normalizeRateLimits(result);
            } catch (error) {
                await server?.stop();
                server = undefined;
                throw error;
            }
        },
        async claude(config) {
            if (config.claudeSource === "statusline") {
                const snapshot = (dependencies.readCache ?? readCache)();
                if (!snapshot)
                    throw new Error("キャッシュがありません。");
                return snapshot;
            }
            const snapshot = await (dependencies.fetchUsageSnapshot ?? fetchUsageSnapshot)({ signal: cancellation.signal });
            try { (dependencies.writeCache ?? writeCache)(snapshot); } catch { /* 取得成功値は表示を継続 */ }
            return snapshot;
        },
        fallback(config) {
            return config.claudeSource === "auto" ? (dependencies.readCache ?? readCache)() : null;
        },
        async close() {
            stopped = true;
            cancellation.abort();
            wakeRetry?.();
            const connection = server;
            server = undefined;
            connection?.failAll(new Error("取得を停止しました。"));
            await connection?.stop();
        },
    };
}
export class WidgetBridge {
    config = defaultBridgeConfig();
    states = new Map();
    notifiers = new Map();
    inFlight = new Map();
    nextAllowedAt = new Map();
    nextPollAt;
    stopped = false;
    revision = 0;
    timer;
    constructor(emit, collectors = createCollectors(), now = () => Date.now(), makeCollectors = createCollectors) {
        this.emit = emit;
        this.collectors = collectors;
        this.now = now;
        this.makeCollectors = makeCollectors;
        for (const service of SERVICES) {
            this.notifiers.set(service, new ThresholdNotifier(undefined, () => {}, async (_file, args) => {
                this.emit({ type: "notification", service, message: args[2], title: args[3], method: this.config.services[service].notifyMethod, demo: this.config.demo });
            }, "popup", undefined, `${service === "codex" ? "Codex" : "Claude"} 利用制限`));
        }
    }
    async configure(config) {
        const validated = validateBridgeConfig(config);
        const collectorChanged = validated.demo !== this.config.demo || validated.codexBin !== this.config.codexBin ||
            validated.timeoutSeconds !== this.config.timeoutSeconds || validated.claudeSource !== this.config.claudeSource;
        if (collectorChanged) {
            clearInterval(this.timer);
            this.revision++;
            await this.collectors.close();
            await Promise.allSettled([...this.inFlight.values()]);
            if (this.stopped)
                return;
            this.collectors = this.makeCollectors();
            if (validated.demo !== this.config.demo) {
                this.states.clear();
                for (const notifier of this.notifiers.values()) {
                    notifier.states.clear();
                    notifier.clearApiError();
                }
            }
            // 設定・表示モードの変更では API の待機期限を消さない。
        }
        this.config = validated;
        for (const service of SERVICES) {
            const settings = this.config.services[service];
            const notifier = this.notifiers.get(service);
            notifier.configure({ ...settings, notifyBelow: settings.notifyBelow ?? undefined, notifyEvery: settings.notifyEvery ?? undefined }, this.states.get(service));
            // エラー通知を途中で有効にしても、継続中の失敗では通知しない。
        }
        clearInterval(this.timer);
        this.nextPollAt = this.now() + this.config.intervalSeconds * 1000;
        this.timer = setInterval(() => {
            this.nextPollAt = this.now() + this.config.intervalSeconds * 1000;
            void this.refresh();
        }, this.config.intervalSeconds * 1000);
        this.emit({ type: "configured", demo: this.config.demo });
    }
    refresh(service) {
        const targets = service === undefined ? SERVICES : SERVICES.includes(service) ? [service] : [];
        return Promise.all(targets.map((target) => this.refreshService(target)));
    }
    retryDeadline(service) {
        if (this.config.demo || (service === "claude" && this.config.claudeSource === "statusline"))
            return undefined;
        return this.nextAllowedAt.get(service);
    }
    refreshService(service) {
        if (this.stopped)
            return Promise.resolve();
        if (this.now() < (this.retryDeadline(service) ?? 0)) {
            this.emit({ type: "diagnostic", service, demo: this.config.demo,
                diagnostic: this.diagnostic(service, { code: "retry_wait" }) });
            return Promise.resolve();
        }
        if (this.inFlight.has(service))
            return this.inFlight.get(service);
        const operation = this.collect(service).finally(() => this.inFlight.delete(service));
        this.inFlight.set(service, operation);
        return operation;
    }
    diagnostic(service, details) {
        const now = this.now();
        const interval = this.config.intervalSeconds * 1000;
        const retryNotBefore = this.retryDeadline(service);
        const earliest = Math.max(now + 1, retryNotBefore ?? 0);
        let nextAttempt = this.nextPollAt ?? now + interval;
        if (nextAttempt < earliest)
            nextAttempt += Math.ceil((earliest - nextAttempt) / interval) * interval;
        return { ...details, occurredAt: diagnosticDate(now),
            source: details.source ?? (service === "codex" ? "app_server" : this.config.claudeSource === "statusline" ? "cache" : "api"),
            nextAttemptAt: diagnosticDate(nextAttempt),
            ...(retryNotBefore > now ? { retryNotBefore: diagnosticDate(retryNotBefore) } : {}) };
    }
    async collect(service) {
        const revision = this.revision;
        const notifier = this.notifiers.get(service);
        try {
            const snapshot = this.config.demo ? demoSnapshot(service, new Date(this.now())) : await this.collectors[service](this.config);
            if (this.stopped || revision !== this.revision)
                return;
            this.states.set(service, snapshot);
            if (!this.config.demo && (service !== "claude" || this.config.claudeSource !== "statusline"))
                this.nextAllowedAt.delete(service);
            notifier.clearApiError();
            const stale = snapshotIsStale(snapshot, this.now());
            this.emit({ type: "snapshot", service, snapshot, stale, demo: this.config.demo,
                ...(this.config.demo ? {} : { diagnostic: this.diagnostic(service, { code: stale ? "stale_value" : "success" }) }) });
            if (!this.config.demo && !stale)
                await notifier.observe(snapshot);
        } catch (error) {
            if (this.stopped || revision !== this.revision)
                return;
            if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) {
                this.nextAllowedAt.set(service, this.now() + error.retryAfterSeconds * 1000);
            }
            const message = service === "codex"
                ? "Codex の取得に失敗しました。ログイン状態・実行パス・接続を確認してください。"
                : this.config.claudeSource === "statusline"
                    ? "Claude のキャッシュを取得できません。statusLine の設定と利用状況を確認してください。"
                    : "Claude の取得に失敗しました。ターミナル版のログイン状態・キーチェーン許可・接続を確認してください。";
            if (service === "claude" && !this.states.has(service)) {
                const cached = this.collectors.fallback?.(this.config);
                if (cached) {
                    this.states.set(service, cached);
                    this.emit({ type: "snapshot", service, snapshot: cached, stale: snapshotIsStale(cached, this.now()), demo: this.config.demo,
                        diagnostic: this.diagnostic(service, { code: "cache_fallback", source: "cache" }) });
                }
            }
            this.emit({ type: "error", service, message, demo: this.config.demo,
                diagnostic: this.diagnostic(service, { ...safeErrorDiagnostic(service, error, this.config),
                    ...(boundedInteger(error?.retryAfterSeconds, 0, 86400 * 365) ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }) });
            if (this.config.services[service].notifyApiError &&
                (service === "codex" || this.config.claudeSource !== "statusline")) {
                await notifier.notifyApiError(new Error(message));
            } else {
                notifier.apiErrorActive = true;
            }
        }
    }
    async stop() {
        this.stopped = true;
        this.revision++;
        clearInterval(this.timer);
        await this.collectors.close();
        await Promise.allSettled([...this.inFlight.values()]);
    }
}
export async function runBridge(input = process.stdin, output = process.stdout) {
    const bridge = new WidgetBridge((event) => output.write(`${JSON.stringify(event)}\n`));
    const lines = createInterface({ input, crlfDelay: Infinity });
    let commands = Promise.resolve();
    const stop = () => { lines.close(); void bridge.stop(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    lines.on("line", (line) => {
        commands = commands.then(async () => {
            if (bridge.stopped)
                return;
            try {
                const command = JSON.parse(line);
                if (command.type === "configure") {
                    await bridge.configure(command.config);
                    void bridge.refresh();
                } else if (command.type === "refresh") {
                    if (command.service !== undefined && !SERVICES.includes(command.service))
                        throw new Error("サービスが不正です。");
                    void bridge.refresh(command.service);
                } else if (command.type === "stop") {
                    stop();
                } else {
                    throw new Error("コマンドが不正です。");
                }
            } catch {
                output.write(`${JSON.stringify({ type: "protocolError", message: "ブリッジ設定またはコマンドが不正です。" })}\n`);
            }
        });
    });
    await new Promise((resolve) => lines.once("close", resolve));
    await commands;
    await bridge.stop();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
}
const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
    runBridge().catch(() => { process.stderr.write("ブリッジが停止しました。\n"); process.exitCode = 1; });
}
