import assert from "node:assert/strict";
import test from "node:test";
import {
    USAGE_URL,
    UsageApiError,
    fetchUsageSnapshot,
    normalizeUsageResponse,
    parseCredentials,
    requestUsage,
} from "../dist/claude-usage-api.mjs";

const TOKEN = "test-token-value";

function credentials(overrides = {}) {
    return JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000, ...overrides } });
}

function fakeResponse(status, body, headers = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        json: async () => {
            if (body instanceof Error) throw body;
            return body;
        },
    };
}

const SAMPLE = {
    five_hour: { utilization: 45.5, resets_at: "2026-09-23T05:30:00.193Z" },
    seven_day: { utilization: 23, resets_at: "2026-09-25T11:00:00+00:00" },
    seven_day_opus: { utilization: 10, resets_at: "2026-09-25T11:00:00Z" },
    extra_usage: { is_enabled: false },
};

// --- 認証情報 ---

test("parseCredentials はアクセストークンを返す", () => {
    assert.equal(parseCredentials(credentials()), TOKEN);
});

test("parseCredentials: 期限切れ・欠落・不正 JSON はエラーでトークンを含まない", () => {
    const cases = [
        credentials({ expiresAt: Date.now() - 1 }),
        JSON.stringify({ claudeAiOauth: {} }),
        JSON.stringify({}),
        "not json",
    ];
    for (const text of cases) {
        assert.throws(() => parseCredentials(text), (error) => {
            assert.ok(error instanceof UsageApiError);
            assert.doesNotMatch(error.message, new RegExp(TOKEN));
            return true;
        });
    }
});

test("parseCredentials: expiresAt がなければ受け付ける", () => {
    assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })), TOKEN);
});

// --- 応答の正規化 ---

test("normalizeUsageResponse は five_hour / seven_day だけを snapshot にする", () => {
    const receivedAt = new Date("2026-09-23T01:00:00Z");
    const snapshot = normalizeUsageResponse(SAMPLE, receivedAt);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.receivedAt, Math.floor(receivedAt.getTime() / 1000));
    assert.deepEqual(snapshot.limits.map((l) => l.window), ["five_hour", "seven_day"]);
    const [five, seven] = snapshot.limits;
    assert.equal(five.windowDurationMins, 300);
    assert.equal(five.usedPercent, 45.5);
    assert.equal(five.remainingPercent, 54.5);
    assert.equal(five.resetsAtEpochSeconds, Math.floor(Date.parse("2026-09-23T05:30:00.193Z") / 1000));
    assert.equal(seven.windowDurationMins, 10_080);
    assert.equal(seven.resetsAt, "2026-09-25T11:00:00.000Z");
});

test("normalizeUsageResponse: null・不正値の期間は除外し、範囲外は丸める", () => {
    const snapshot = normalizeUsageResponse({
        five_hour: null,
        seven_day: { utilization: 120, resets_at: null },
    });
    assert.equal(snapshot.limits.length, 1);
    assert.equal(snapshot.limits[0].usedPercent, 100);
    assert.equal(snapshot.limits[0].remainingPercent, 0);
    assert.equal(snapshot.limits[0].resetsAt, null);
    assert.equal(normalizeUsageResponse({ five_hour: { utilization: "10" } }).limits.length, 0);
    assert.equal(normalizeUsageResponse(null).limits.length, 0);
});

// --- API 呼び出し ---

test("normalizeUsageResponse は limits[] のモデル別週次制限を読む", () => {
    const snapshot = normalizeUsageResponse({
        ...SAMPLE,
        limits: [
            { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 5, resets_at: 1_790_600_000 },
            { kind: "weekly_scoped", scope: { model: { display_name: "Big Model" } }, percent: 12.5, resets_at: "2026-10-02T10:59:00Z" },
            { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 50 },
            { kind: "weekly_scoped", scope: { model: { display_name: "!!" } }, percent: 1 },
            { kind: "weekly_scoped", scope: {}, percent: 1 },
            { kind: "weekly_scoped", scope: { model: { display_name: "NoPercent" } } },
            { kind: "five_hour", percent: 1 },
            null,
        ],
    });
    assert.deepEqual(
        snapshot.limits.map((l) => [l.limitId, l.limitName, l.window]),
        [
            ["claude", "Claude", "five_hour"],
            ["claude", "Claude", "seven_day"],
            ["claude-fable", "Claude Fable", "seven_day"],
            ["claude-big-model", "Claude Big Model", "seven_day"],
        ],
    );
    const [, , fable, big] = snapshot.limits;
    assert.equal(fable.usedPercent, 5);
    assert.equal(fable.remainingPercent, 95);
    assert.equal(fable.windowDurationMins, 10_080);
    assert.equal(fable.resetsAtEpochSeconds, 1_790_600_000);
    assert.equal(big.resetsAt, "2026-10-02T10:59:00.000Z");
});

test("normalizeUsageResponse: limits[] が配列でなければ無視する", () => {
    assert.equal(normalizeUsageResponse({ ...SAMPLE, limits: { kind: "weekly_scoped" } }).limits.length, 2);
});

test("requestUsage は Bearer トークンと beta ヘッダで GET する", async () => {
    let captured;
    const json = await requestUsage(TOKEN, async (url, init) => {
        captured = { url, init };
        return fakeResponse(200, SAMPLE);
    });
    assert.deepEqual(json, SAMPLE);
    assert.equal(captured.url, USAGE_URL);
    assert.equal(captured.init.method, "GET");
    assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(captured.init.headers["anthropic-beta"], "oauth-2025-04-20");
});

test("requestUsage: 401 / 429 / 500 / 接続失敗 / 非 JSON はエラー", async () => {
    await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(401, {})), /認証に失敗/);
    await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(500, {})), /HTTP 500/);
    await assert.rejects(requestUsage(TOKEN, async () => { throw new Error("offline"); }), /接続できません/);
    await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(200, new SyntaxError("x"))), /JSON ではありません/);
    await assert.rejects(
        requestUsage(TOKEN, async () => fakeResponse(429, {}, { "retry-after": "120" })),
        (error) => {
            assert.ok(error instanceof UsageApiError);
            assert.equal(error.retryAfterSeconds, 120);
            return true;
        },
    );
});

test("fetchUsageSnapshot は認証情報を読み API の値を返す", async () => {
    const snapshot = await fetchUsageSnapshot({
        readCredentials: async () => credentials(),
        fetchImpl: async () => fakeResponse(200, SAMPLE),
    });
    assert.equal(snapshot.limits.length, 2);
});

test("fetchUsageSnapshot: 利用制限が1つもなければエラー", async () => {
    await assert.rejects(fetchUsageSnapshot({
        readCredentials: async () => credentials(),
        fetchImpl: async () => fakeResponse(200, {}),
    }), /含まれていません/);
});

test("認証情報の不正・欠落・期限切れを診断分類で区別し、秘密情報を含めない", () => {
    const cases = [
        ["invalid", "credentials_invalid"],
        [JSON.stringify({}), "credentials_missing"],
        [credentials({ expiresAt: Date.now() - 1 }), "credentials_expired"],
    ];
    for (const [text, code] of cases) {
        assert.throws(() => parseCredentials(text), (error) => {
            assert.equal(error.diagnostic.code, code);
            assert.doesNotMatch(JSON.stringify(error.diagnostic), /test-token-value/);
            return true;
        });
    }
});

test("HTTPの診断にはステータスと待機指定を残し、応答本文を含めない", async () => {
    for (const [status, code] of [[401, "api_auth"], [403, "api_auth"], [429, "api_rate_limit"], [503, "api_http"]]) {
        await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(status, { secret: TOKEN }, { "retry-after": "600" })), (error) => {
            assert.deepEqual(error.diagnostic, { code, httpStatus: status });
            if (status === 429) assert.equal(error.retryAfterSeconds, 600);
            assert.doesNotMatch(JSON.stringify(error.diagnostic), /test-token-value|secret/);
            return true;
        });
    }
});

test("通信・タイムアウトの診断は既知のコードだけを採用する", async () => {
    const failures = [
        [Object.assign(new Error(TOKEN), { name: "TimeoutError" }), { code: "api_timeout", networkCode: undefined }],
        [new Error(TOKEN, { cause: { code: "ENOTFOUND", message: TOKEN } }), { code: "api_network", networkCode: "ENOTFOUND" }],
        [new Error(TOKEN, { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), { code: "api_timeout", networkCode: "UND_ERR_CONNECT_TIMEOUT" }],
        [Object.assign(new Error(TOKEN), { code: TOKEN }), { code: "api_network", networkCode: undefined }],
    ];
    for (const [failure, expected] of failures) {
        await assert.rejects(requestUsage(TOKEN, async () => { throw failure; }), (error) => {
            assert.deepEqual(error.diagnostic, expected);
            assert.doesNotMatch(JSON.stringify(error.diagnostic), /test-token-value/);
            return true;
        });
    }
});

test("応答本文の受信タイムアウトと不正JSONを診断で区別する", async () => {
    await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(200,
        Object.assign(new Error(TOKEN), { name: "TimeoutError" }))), (error) => error.diagnostic.code === "api_timeout");
    await assert.rejects(requestUsage(TOKEN, async () => fakeResponse(200, new SyntaxError(TOKEN))),
        (error) => error.diagnostic.code === "api_invalid_json");
    const cancellation = new AbortController();
    await assert.rejects(requestUsage(TOKEN, async () => ({
        ...fakeResponse(200, {}),
        json: async () => {
            cancellation.abort(new DOMException("timeout", "TimeoutError"));
            throw new DOMException("aborted", "AbortError");
        },
    }), cancellation.signal), (error) => error.diagnostic.code === "api_timeout");
});
