import { alignColumns } from "./align-columns.mjs";
function percent(value) {
    return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}
function duration(value) {
    if (value === null) {
        return "不明";
    }
    if (value === 300) {
        return "5時間";
    }
    if (value === 10_080) {
        return "7日（週次）";
    }
    if (value % 1_440 === 0) {
        return `${value / 1_440}日`;
    }
    if (value % 60 === 0) {
        return `${value / 60}時間`;
    }
    return `${value}分`;
}
/** 人向け表示の残量。桁をそろえるため常に小数1桁で表す。 */
function fixedPercent(value) {
    return `${value.toFixed(1)}%`;
}
function formatDateTime(isoString) {
    if (isoString === null || isoString === undefined) {
        return "不明";
    }
    return new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(new Date(isoString)).replaceAll("/", "-");
}
function label(limit) {
    return limit.limitName ?? limit.limitId;
}
/**
 * Claude snapshot を人向けに整形する。
 * 「取得日時」と表示し、stale 時は末尾に注記を加える。
 */
export function formatClaudeSnapshot(snapshot, stale, notifyBelow = undefined, notifyMethod = "popup", notifyEvery = undefined, notifyExclude = [], notifyApiError = false) {
    const settings = [];
    if (notifyBelow !== undefined) {
        settings.push(`${notifyBelow}% 以下`);
    }
    if (notifyEvery !== undefined) {
        settings.push(`${notifyEvery}% 毎`);
    }
    const notificationSettings = [];
    if (settings.length > 0) {
        notificationSettings.push(`残量 ${settings.join(" + ")}`);
    }
    if (notifyApiError) {
        notificationSettings.push("API 取得エラー");
    }
    const notification = notificationSettings.length === 0
        ? ""
        : `【通知設定: ${notificationSettings.join(" + ")} / ${notifyMethod === "popup" ? "ポップアップ" : "Mac 通知センター"}${notifyExclude.length === 0 ? "" : ` / 除外: ${notifyExclude.join(", ")}`}】`;
    const lines = [`取得日時: ${formatDateTime(snapshot.observedAt)}${notification}`];
    if (snapshot.limits.length === 0) {
        lines.push("表示可能な利用制限の情報がありません。");
    }
    lines.push(...alignColumns(snapshot.limits.map((limit) => [
        label(limit),
        " / ",
        limit.window,
        " / ",
        `${duration(limit.windowDurationMins)}:`,
        " 残量 ",
        fixedPercent(limit.remainingPercent),
        " / リセット ",
        formatDateTime(limit.resetsAt),
    ])));
    if (stale) {
        lines.push("※ 最新データが取得できていません");
    }
    return lines.join("\n");
}
/**
 * Claude snapshot を JSON 文字列へ変換する。stale フラグを含む。
 */
export function formatClaudeJson(snapshot, stale) {
    return JSON.stringify({ ...snapshot, stale });
}
/**
 * --statusline 用の短い残量表示を生成する（Claude Code ステータスバー向け）。
 */
export function formatStatusLine(snapshot) {
    if (snapshot.limits.length === 0) {
        return "Claude: --";
    }
    const parts = snapshot.limits.map((l) => {
        const tag = l.window === "five_hour" ? "5h"
            : l.window === "seven_day" ? "7d"
            : l.window;
        return `${tag}:${percent(l.remainingPercent)}`;
    });
    return `Claude ${parts.join(" ")}`;
}
