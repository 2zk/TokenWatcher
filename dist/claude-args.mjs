import { CliUsageError } from "./types.mjs";

const HELP = `使い方: token-watcher-claude [options]

オプション:
  --statusline               Claude Code の statusLine JSON を stdin から読み、キャッシュして残量を出力する
  --watch                    Ctrl+C まで定期的に表示を更新する
  --source <source>          取得元: auto（API、失敗時キャッシュ）、api（利用量 API のみ）、statusline（キャッシュのみ）（既定: auto）
  --interval <seconds>       更新間隔（既定: 180、60以上の整数）
  --json                     one-shot は JSON、watch は NDJSON で出力する
  --filter <text>            表示名と期間を部分一致で絞り込む（大文字・小文字を区別しない）
  --notify-below <percent>   残量が指定値以下なら通知する（0〜100）
  --notify-every <percent>   指定した割合（%）ごとに通知する（1〜99）
  --notify-api-error         利用量 API の取得エラーを通知する
  --notify-method <method>   通知方式: popup（ポップアップ）または notification（Mac 通知センター）（既定: popup）
  --notify-exclude <text>    表示名と期間が部分一致する制限を通知対象から外す（表示は残す、複数指定可）
  --help                     このヘルプを表示する
  --version                  バージョンを表示する

前提条件:
  Pro または Max プランでターミナル版 Claude Code にログインしていること。
  api/auto はキーチェーンの OAuth トークンで非公式の利用量 API を呼ぶ。
  トークンはターミナル版 Claude Code の起動時に更新され、デスクトップアプリの利用では更新されない。
  statusline は Claude Code v2.1.251 以降で、~/.claude/settings.json の statusLine に本コマンドの --statusline を設定する。`;

export function helpText() {
    return HELP;
}

function requiredValue(args, index, option) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`${option} には値が必要です。`);
    }
    return value;
}

function integer(value, option, minimum) {
    if (!/^[0-9]+$/.test(value)) {
        throw new CliUsageError(`${option} は整数で指定してください。`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new CliUsageError(`${option} は ${minimum} 以上の整数で指定してください。`);
    }
    return parsed;
}

export function parseArgs(args) {
    const options = {
        statusline: false,
        watch: false,
        intervalSeconds: 180,
        json: false,
        notifyBelow: undefined,
        notifyEvery: undefined,
        notifyApiError: false,
        notifyMethod: "popup",
        notifyExclude: [],
        source: "auto",
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        switch (arg) {
            case "--help":
                return { kind: "help" };
            case "--version":
                return { kind: "version" };
            case "--statusline":
                options.statusline = true;
                break;
            case "--watch":
                options.watch = true;
                break;
            case "--json":
                options.json = true;
                break;
            case "--notify-api-error":
                options.notifyApiError = true;
                break;
            case "--filter":
                options.filter = requiredValue(args, index, arg);
                index += 1;
                break;
            case "--interval":
                options.intervalSeconds = integer(requiredValue(args, index, arg), arg, 60);
                index += 1;
                break;
            case "--notify-below": {
                const value = requiredValue(args, index, arg);
                if (!/^(?:0|[1-9][0-9]?|100)$/.test(value)) {
                    throw new CliUsageError(`${arg} は 0〜100 の整数で指定してください。`);
                }
                options.notifyBelow = Number(value);
                index += 1;
                break;
            }
            case "--notify-every": {
                const value = requiredValue(args, index, arg);
                if (!/^(?:[1-9][0-9]?)$/.test(value)) {
                    throw new CliUsageError(`${arg} は 1〜99 の整数で指定してください。`);
                }
                options.notifyEvery = Number(value);
                index += 1;
                break;
            }
            case "--source": {
                const value = requiredValue(args, index, arg);
                if (value !== "auto" && value !== "api" && value !== "statusline") {
                    throw new CliUsageError(`${arg} は auto、api、statusline のいずれかで指定してください。`);
                }
                options.source = value;
                index += 1;
                break;
            }
            case "--notify-exclude":
                options.notifyExclude.push(requiredValue(args, index, arg));
                index += 1;
                break;
            case "--notify-method": {
                const value = requiredValue(args, index, arg);
                if (value !== "popup" && value !== "notification") {
                    throw new CliUsageError(`${arg} は popup（ポップアップ）または notification（Mac 通知センター）で指定してください。`);
                }
                options.notifyMethod = value;
                index += 1;
                break;
            }
            default:
                throw new CliUsageError(`不明なオプションです: ${arg}`);
        }
    }
    return { kind: "run", options };
}
