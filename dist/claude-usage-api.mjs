import { execFile } from "node:child_process";
import { modelScopedLimit } from "./claude-limits.mjs";

/**
 * Claude Code の利用量 API（非公式）から利用制限を取得する。
 * エンドポイントや応答形式は公開仕様ではなく、予告なく変わる可能性がある。
 */
export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const REQUEST_TIMEOUT_MS = 15_000;
const SECURITY_TIMEOUT_MS = 30_000;
const WINDOWS = [
    { key: "five_hour", window: "five_hour", windowDurationMins: 300 },
    { key: "seven_day", window: "seven_day", windowDurationMins: 10_080 },
];

export class UsageApiError extends Error {
    constructor(message, retryAfterSeconds = undefined, diagnostic = undefined) {
        super(message);
        this.name = "UsageApiError";
        this.retryAfterSeconds = retryAfterSeconds;
        this.diagnostic = diagnostic;
    }
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** macOS キーチェーンから Claude Code の認証情報 JSON 文字列を読む。 */
function readKeychain(signal) {
    return new Promise((resolve, reject) => {
        execFile(
            "/usr/bin/security",
            ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
            (error, stdout) => {
                if (error) {
                    // stderr にはトークンが含まれないが、念のためメッセージには含めない
                    reject(new UsageApiError(
                        "キーチェーンから Claude Code の認証情報を読めませんでした。Claude Code にログインしているか、キーチェーンへのアクセスを許可したか確認してください。",
                        undefined, {
                            code: error.killed ? "keychain_timeout" : "keychain_access",
                            exitStatus: Number.isInteger(error.code) ? error.code : undefined,
                        },
                    ));
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

/**
 * 認証情報 JSON からアクセストークンを取り出す。
 * トークンの更新（refresh）は行わない。期限切れなら案内付きのエラーにする。
 */
export function parseCredentials(text, nowMs = Date.now()) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new UsageApiError("Claude Code の認証情報の形式を解釈できませんでした。", undefined, { code: "credentials_invalid" });
    }
    const oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
    if (!isRecord(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken === "") {
        throw new UsageApiError("Claude Code の認証情報に OAuth トークンがありません。Pro/Max プランでログインしてください。", undefined, { code: "credentials_missing" });
    }
    if (typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= nowMs) {
        throw new UsageApiError("Claude Code の OAuth トークンが期限切れです。ターミナル版 Claude Code（claude コマンド）を起動すると更新されます（デスクトップアプリの利用では更新されません）。", undefined, { code: "credentials_expired" });
    }
    return oauth.accessToken;
}

function parseRetryAfter(value) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (/^[0-9]+$/.test(value.trim())) {
        return Number(value.trim());
    }
    const date = Date.parse(value);
    if (Number.isNaN(date)) {
        return undefined;
    }
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

const NETWORK_CODES = new Set([
    "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
function connectionDiagnostic(error, signal) {
    let networkCode;
    let timeout = error?.name === "TimeoutError" || signal?.reason?.name === "TimeoutError";
    let cause = error;
    for (let depth = 0; cause && depth < 3; depth++, cause = cause.cause) {
        if (NETWORK_CODES.has(cause.code)) {
            networkCode = cause.code;
            timeout ||= cause.code.includes("TIMEOUT") || cause.code === "ETIMEDOUT";
            break;
        }
    }
    return { code: timeout ? "api_timeout" : "api_network", networkCode };
}

/** 利用量 API を呼び、応答 JSON を返す。 */
export async function requestUsage(token, fetchImpl = fetch, signal) {
    let response;
    const requestSignal = signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    try {
        response = await fetchImpl(USAGE_URL, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-beta": OAUTH_BETA,
                Accept: "application/json",
            },
            signal: requestSignal,
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new UsageApiError(`利用量 API に接続できませんでした: ${reason}`, undefined, connectionDiagnostic(error, requestSignal));
    }
    if (response.status === 401 || response.status === 403) {
        throw new UsageApiError(
            `利用量 API の認証に失敗しました（HTTP ${response.status}）。ターミナル版 Claude Code（claude コマンド）で再ログインしてください。`,
            undefined, { code: "api_auth", httpStatus: response.status },
        );
    }
    if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        throw new UsageApiError("利用量 API の呼び出し回数制限に達しました（HTTP 429）。", retryAfterSeconds, { code: "api_rate_limit", httpStatus: 429 });
    }
    if (!response.ok) {
        throw new UsageApiError(`利用量 API がエラーを返しました（HTTP ${response.status}）。`, undefined, { code: "api_http", httpStatus: response.status });
    }
    try {
        return await response.json();
    } catch (error) {
        const diagnostic = connectionDiagnostic(error, requestSignal);
        if (diagnostic.code === "api_timeout" || diagnostic.networkCode) {
            throw new UsageApiError("利用量 API の応答を受信できませんでした。", undefined, diagnostic);
        }
        throw new UsageApiError("利用量 API の応答が JSON ではありません。", undefined, { code: "api_invalid_json" });
    }
}

function readWindow(raw, spec) {
    if (!isRecord(raw)) {
        return null;
    }
    const used = raw.utilization;
    if (typeof used !== "number" || !Number.isFinite(used)) {
        return null;
    }
    const usedPercent = Math.min(100, Math.max(0, used));
    let resetsAtEpochSeconds = null;
    if (typeof raw.resets_at === "string") {
        const ms = Date.parse(raw.resets_at);
        if (!Number.isNaN(ms)) {
            resetsAtEpochSeconds = Math.floor(ms / 1000);
        }
    }
    return {
        limitId: "claude",
        limitName: "Claude",
        window: spec.window,
        windowDurationMins: spec.windowDurationMins,
        usedPercent,
        remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
        resetsAtEpochSeconds,
        resetsAt: resetsAtEpochSeconds === null ? null : new Date(resetsAtEpochSeconds * 1000).toISOString(),
    };
}

function readResetsAt(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const seconds = Math.floor(value);
        return Number.isNaN(new Date(seconds * 1000).getTime()) ? null : seconds;
    }
    if (typeof value === "string") {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    return null;
}

/**
 * limits[] のモデル別週次制限（kind: "weekly_scoped"）を読む。
 * 形式は Claude Code 本体の実装から読み取ったもので、公開仕様ではない。
 */
function readModelScoped(rawLimits) {
    if (!Array.isArray(rawLimits)) {
        return [];
    }
    const limits = [];
    const seen = new Set();
    for (const raw of rawLimits) {
        if (!isRecord(raw) || raw.kind !== "weekly_scoped") {
            continue;
        }
        const model = isRecord(raw.scope) && isRecord(raw.scope.model) ? raw.scope.model : undefined;
        const percent = raw.percent;
        if (model === undefined || typeof percent !== "number" || !Number.isFinite(percent)) {
            continue;
        }
        const limit = modelScopedLimit(model.display_name, percent, readResetsAt(raw.resets_at));
        if (limit !== null && !seen.has(limit.limitId)) {
            seen.add(limit.limitId);
            limits.push(limit);
        }
    }
    return limits;
}

/**
 * 利用量 API の応答を内部 snapshot 形式へ正規化する。
 * five_hour / seven_day と、limits[] のモデル別週次制限（例: Fable）を扱う。欠けた期間は推測しない。
 */
export function normalizeUsageResponse(json, receivedAt = new Date()) {
    const record = isRecord(json) ? json : {};
    const limits = [];
    for (const spec of WINDOWS) {
        const limit = readWindow(record[spec.key], spec);
        if (limit !== null) {
            limits.push(limit);
        }
    }
    limits.push(...readModelScoped(record.limits));
    return {
        schemaVersion: 1,
        receivedAt: Math.floor(receivedAt.getTime() / 1000),
        observedAt: receivedAt.toISOString(),
        limits,
    };
}

/** キーチェーンのトークンで利用量 API を呼び、snapshot を返す。 */
export async function fetchUsageSnapshot(dependencies = {}) {
    const readCredentials = dependencies.readCredentials ?? (() => readKeychain(dependencies.signal));
    const token = parseCredentials(await readCredentials());
    const json = await requestUsage(token, dependencies.fetchImpl ?? fetch, dependencies.signal);
    const snapshot = normalizeUsageResponse(json);
    if (snapshot.limits.length === 0) {
        throw new UsageApiError("利用量 API の応答に利用制限が含まれていません。", undefined, { code: "api_missing_limits" });
    }
    return snapshot;
}
