export function terminalDisplayOptions(stdout = process.stdout, env = process.env) {
    return {
        bars: Boolean(stdout.isTTY),
        color: Boolean(stdout.isTTY) && !env.NO_COLOR && env.TERM !== "dumb",
        columns: stdout.columns ?? 80,
    };
}

/** GUI と同じ残量の色分けで、端末幅に収まる横バーを描画する。 */
export function formatRemainingBar(remaining, { color = false, stale = false, columns = 80 } = {}) {
    const width = Math.max(1, Math.min(32, Math.floor(columns) - 2));
    const percent = Math.min(100, Math.max(0, remaining));
    const filledWidth = Math.round(width * percent / 100);
    const filled = "█".repeat(filledWidth);
    const empty = "░".repeat(width - filledWidth);
    if (!color) {
        return filled + empty;
    }
    const shade = stale ? "90" : percent > 30 ? "32" : percent > 10 ? "38;5;208" : "31";
    return `${filled ? `\x1B[${shade}m${filled}\x1B[0m` : ""}${empty ? `\x1B[90m${empty}\x1B[0m` : ""}`;
}

export function formatRemainingCards(limits, options = {}) {
    return limits.flatMap((limit, index) => [
        ...(index === 0 ? [] : [""]),
        `${limit.label}: 残量 ${limit.remainingPercent.toFixed(1)}%`,
        `  ${formatRemainingBar(limit.remainingPercent, options)}`,
        `  リセット ${limit.resetAt}`,
    ]);
}
