import { alignColumns } from "./align-columns.mjs";
// 桁をそろえるため常に小数1桁で表す。
function percent(value) {
    return `${value.toFixed(1)}%`;
}
function duration(value) {
    if (value === null)
        return "不明";
    if (value === 300)
        return "5時間";
    if (value === 10_080)
        return "7日（週次）";
    if (value % 1_440 === 0)
        return `${value / 1_440}日`;
    if (value % 60 === 0)
        return `${value / 60}時間`;
    return `${value}分`;
}
function resetAt(value) {
    if (value === null)
        return "不明";
    return new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(new Date(value)).replaceAll("/", "-");
}
function label(limit) {
    return limit.limitName ?? limit.limitId;
}
/** 利用可能なリセットクレジットの件数と内訳を1行で表す。 */
function resetCreditsLine(resetCredits) {
    const available = resetCredits.credits
        .filter((credit) => credit.status === "available")
        .sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""));
    const count = resetCredits.availableCount ?? available.length;
    const details = available
        .map((credit) => `${credit.title ?? credit.resetType ?? "不明"} / 期限 ${resetAt(credit.expiresAt)}`)
        .join("、");
    return `リセットクレジット: 利用可能 ${count}件${details === "" ? "" : `（${details}）`}`;
}
export function formatSnapshot(snapshot, notifyBelow = undefined, notifyMethod = "popup", notifyEvery = undefined, notifyExclude = [], notifyApiError = false) {
    const settings = [];
    if (notifyBelow !== undefined) {
        settings.push(`${notifyBelow}% 以下`);
    }
    if (notifyEvery !== undefined) {
        settings.push(`${notifyEvery}% 毎`);
    }
    const notificationSettings = [];
    if (settings.length > 0)
        notificationSettings.push(`残量 ${settings.join(" + ")}`);
    if (notifyApiError)
        notificationSettings.push("API 取得エラー");
    const notification = notificationSettings.length === 0
        ? ""
        : `【通知設定: ${notificationSettings.join(" + ")} / ${notifyMethod === "popup" ? "ポップアップ" : "Mac 通知センター"}${notifyExclude.length === 0 ? "" : ` / 除外: ${notifyExclude.join(", ")}`}】`;
    const lines = [`取得日時: ${resetAt(snapshot.observedAt)}${notification}`];
    if (snapshot.limits.length === 0) {
        lines.push("表示可能な利用制限は返されませんでした。");
    }
    lines.push(...alignColumns(snapshot.limits.map((limit) => [
        label(limit),
        " / ",
        limit.window,
        " / ",
        `${duration(limit.windowDurationMins)}:`,
        " 残量 ",
        percent(limit.remainingPercent),
        " / リセット ",
        resetAt(limit.resetsAt),
    ])));
    if (snapshot.resetCredits !== undefined) {
        lines.push(resetCreditsLine(snapshot.resetCredits));
    }
    return lines.join("\n");
}
export function formatJson(snapshot) {
    return JSON.stringify(snapshot);
}
