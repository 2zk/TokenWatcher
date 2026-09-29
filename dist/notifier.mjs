import { spawn } from "node:child_process";
const POPUP_APPLESCRIPT = 'on run argv\n  display dialog (item 1 of argv) with title (item 2 of argv) buttons {"閉じる"} default button "閉じる"\nend run';
const NOTIFICATION_APPLESCRIPT = "on run argv\n  display notification (item 1 of argv) with title (item 2 of argv)\nend run";
const defaultNotificationExecutor = (file, args) => new Promise((resolve, reject) => {
    try {
        const child = spawn(file, args, { detached: true, stdio: "ignore" });
        child.unref();
        child.once("error", reject);
        child.once("spawn", resolve);
    }
    catch (error) {
        reject(error);
    }
});
function evaluateObservation(previous, limit, observedAtEpochSeconds, reachedThresholds, threshold, notifyEvery) {
    const previousResetAtEpochSeconds = previous?.resetsAtEpochSeconds;
    const pendingResetAtEpochSeconds = previousResetAtEpochSeconds !== null &&
        previousResetAtEpochSeconds !== undefined &&
        observedAtEpochSeconds >= previousResetAtEpochSeconds
        ? previousResetAtEpochSeconds
        : previous?.pendingResetAtEpochSeconds;
    const recoveredAfterReset = previous !== undefined &&
        pendingResetAtEpochSeconds !== undefined &&
        limit.remainingPercent > previous.remainingPercent;
    const newlyReached = previous === undefined
        ? threshold !== undefined && reachedThresholds.includes(threshold)
            ? [threshold]
            : []
        : reachedThresholds.filter((candidate) => !previous.reachedThresholds.includes(candidate));
    const messages = [];
    const name = limit.limitName ?? limit.limitId;
    if (recoveredAfterReset) {
        messages.push(`${name} / ${limit.window}: 残量 ${limit.remainingPercent}%（リセットにより回復）`);
    }
    if (newlyReached.length > 0) {
        const notificationThreshold = Math.min(...newlyReached);
        const description = notificationThreshold === threshold
            ? `通知閾値 ${notificationThreshold}% 以下`
            : `${notifyEvery}% 毎の通知`;
        messages.push(`${name} / ${limit.window}: 残量 ${limit.remainingPercent}%（${description}）`);
    }
    return {
        state: {
            reachedThresholds,
            remainingPercent: limit.remainingPercent,
            resetsAtEpochSeconds: limit.resetsAtEpochSeconds,
            pendingResetAtEpochSeconds: recoveredAfterReset ? undefined : pendingResetAtEpochSeconds,
        },
        messages,
    };
}
export class ThresholdNotifier {
    threshold;
    warn;
    execute;
    method;
    notifyEvery;
    title;
    notifyExclude;
    states = new Map();
    hasWarned = false;
    apiErrorActive = false;
    constructor(threshold, warn, execute = defaultNotificationExecutor, method = "popup", notifyEvery = undefined, title = "Codex 利用制限", notifyExclude = []) {
        this.threshold = threshold;
        this.warn = warn;
        this.execute = execute;
        this.method = method;
        this.notifyEvery = notifyEvery;
        this.title = title;
        this.notifyExclude = notifyExclude.map((pattern) => pattern.toLowerCase());
    }
    async observe(snapshot) {
        if (this.threshold === undefined && this.notifyEvery === undefined)
            return;
        const observedAtEpochSeconds = Date.parse(snapshot.observedAt) / 1_000;
        for (const limit of snapshot.limits) {
            if (this.isExcluded(limit))
                continue;
            await this.maybeNotify(limit, observedAtEpochSeconds);
        }
    }
    async notifyApiError(error) {
        if (this.apiErrorActive)
            return;
        this.apiErrorActive = true;
        const detail = error instanceof Error ? error.message : String(error);
        await this.sendNotification(`利用量 API の取得に失敗しました: ${detail}`);
    }
    clearApiError() {
        this.apiErrorActive = false;
    }
    isExcluded(limit) {
        const name = `${limit.limitName ?? limit.limitId} / ${limit.window}`.toLowerCase();
        return this.notifyExclude.some((pattern) => name.includes(pattern));
    }
    async maybeNotify(limit, observedAtEpochSeconds) {
        const key = `${limit.limitId}:${limit.window}`;
        const previous = this.states.get(key);
        const reachedThresholds = this.reachedThresholds(limit.remainingPercent);
        const result = evaluateObservation(previous, limit, observedAtEpochSeconds, reachedThresholds, this.threshold, this.notifyEvery);
        this.states.set(key, result.state);
        for (const message of result.messages) {
            await this.sendNotification(message);
        }
    }
    async sendNotification(message) {
        try {
            await this.execute("/usr/bin/osascript", [
                "-e",
                this.method === "popup" ? POPUP_APPLESCRIPT : NOTIFICATION_APPLESCRIPT,
                message,
                this.title,
            ]);
        }
        catch (error) {
            if (!this.hasWarned) {
                this.hasWarned = true;
                const detail = error instanceof Error ? error.message : String(error);
                const target = this.method === "popup" ? "macOS ポップアップ" : "Mac 通知センター通知";
                this.warn(`${target}を表示できませんでした。監視は継続します: ${detail}`);
            }
        }
    }
    reachedThresholds(remainingPercent) {
        const thresholds = new Set();
        if (this.threshold !== undefined) {
            thresholds.add(this.threshold);
        }
        if (this.notifyEvery !== undefined) {
            for (let threshold = 100 - this.notifyEvery; threshold > 0; threshold -= this.notifyEvery) {
                thresholds.add(threshold);
            }
        }
        return [...thresholds].filter((threshold) => remainingPercent <= threshold);
    }
}
