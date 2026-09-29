# TokenWatcher

Codex と Claude（Claude Code Pro/Max）の利用制限の残量を表示・監視する macOS 向け Node.js CLI。残量が減ったときや API 取得エラーが起きたときに、Mac 通知センターまたはポップアップウィンドウで通知できる。

Codex 用と Claude 用は別のコマンドになっている。

| コマンド | 対象 | 取得元 |
|---|---|---|
| `token-watcher-codex` | Codex | `codex app-server`（`codex login` 済みのログイン状態を利用） |
| `token-watcher-claude` | Claude Code Pro/Max | 利用量 API（非公式）、または Claude Code の statusLine |

## 使い始める

```sh
git clone https://github.com/2zk/TokenWatcher.git
cd TokenWatcher
./token-watcher-codex
./token-watcher-claude
```

clone 後のパッケージインストールやビルドは不要。リポジトリに含まれるNode.js実装を直接実行する。どちらのコマンドも macOS と Node.js 20 以上が必要。

---

## token-watcher-codex（Codex）

Codex の app-server から、現在表示できる利用制限の残量を取得する。

`primary` と `secondary` を含め、app-server が返したすべての制限期間を表示する。返されなかった期間を推測して表示することはない。

### 前提条件

- macOS
- Node.js 20 以上
- `codex` CLI が PATH 上にあり、ChatGPT 管理認証で `codex login` 済みであること

このツールは認証情報を読まず、`codex app-server` が既存ログイン状態を利用する。API キーのみ、または Bedrock などの認証では、Codex service-backed の利用量を取得できない場合がある。

### 使い方

```sh
# 1回だけ、人向けの表示で取得
./token-watcher-codex

# JSON で1回取得
./token-watcher-codex --json

# 表示名と期間で絞り込む（大文字・小文字を区別しない部分一致）
./token-watcher-codex --filter "codex / primary"

# 180秒ごと（既定）に表示。Ctrl+C で終了
./token-watcher-codex --watch

# 5分ごとに表示
./token-watcher-codex --watch --interval 300

# watch と組み合わせて NDJSON を標準出力へ追記
./token-watcher-codex --watch --json

# Codex コマンドのパスを明示
./token-watcher-codex --codex-bin /opt/homebrew/bin/codex

# app-server 応答の待機時間を30秒にする
./token-watcher-codex --timeout 30

# 残量20%以下でポップアップを表示（既定の通知方式）
./token-watcher-codex --watch --notify-below 20

# 残量20%以下でMac 通知センターに通知を出す
./token-watcher-codex --watch --notify-below 20 --notify-method notification

# 利用量 API の取得エラーを通知する
./token-watcher-codex --watch --notify-api-error

# 残量が20%減るごとに通知する（80%、60%、40%、20%）
./token-watcher-codex --watch --notify-every 20

# 固定閾値と刻み通知を併用する
./token-watcher-codex --watch --notify-below 30 --notify-every 20

# primary は表示したまま通知だけ止める
./token-watcher-codex --watch --notify-every 20 --notify-exclude "codex / primary"
```

`--interval` は 60 以上の整数だけを受け付け、既定は 180 秒。`--timeout` は正整数だけを受け付ける。利用量取得に失敗した場合は 10 秒、20 秒、30 秒後に計 3 回再試行し、初回を含む最大 4 回がすべて失敗した場合は既存どおりエラー終了する。`--notify-below` は 0〜100 の整数、`--notify-every` は 1〜99 の整数を受け付ける。

`--filter <text>` を指定すると、各制限の表示名（`limitName` がなければ `limitId`）と期間（`primary` / `secondary`）を連結した文字列に対し、大文字・小文字を区別しない部分一致で絞り込む。省略時はすべての制限を表示する。フィルタは人向け表示、JSON/NDJSON、通知の対象に共通で適用される。

TTY 上の `--watch` は前回表示を更新する。パイプやリダイレクトなど非TTYでは、スナップショットを追記する。通知オプション指定時の人向け表示には、各スナップショットに通知設定と方式を表示する。JSON 出力では one-shot は1個の JSON オブジェクト、watch は1行に1個の JSON（NDJSON）になる。JSON/NDJSON で通知を指定した場合、通知設定は起動時に1回だけ標準エラー出力へ表示する。診断と警告も標準エラー出力へ出るため、JSON の標準出力には混ざらない。

表示する残量は `100 - usedPercent` を 0〜100 の範囲に丸めたもの。300分の期間は「5時間」、10080分は「7日（週次）」と表示する。

app-server が利用制限の無料リセット権（`rateLimitResetCredits`）を返した場合は、利用可能な件数と各クレジットの期限を末尾に表示する。JSON 出力では `resetCredits` に含まれる。`--filter` の対象にはならない。

```
取得日時: 2026-09-26 8:43:06
codex / primary / 7日（週次）: 残量 30.0% / リセット 2026-09-28 17:42:53
リセットクレジット: 利用可能 1件（Full reset / 期限 2026-10-23 5:38:08）
```

### 通知

`--notify-below <percent>` を指定すると、残量が指定値以下になったときに `osascript` で通知する。`--notify-api-error` を指定すると、利用量 API の取得エラーも通知する。`--notify-method <popup|notification>` で通知方式を選べ、既定は `popup`。

`--notify-every <percent>` を指定すると、100% から指定値を繰り返し引いた正の段階ごとに通知する。たとえば `--notify-every 20` の通知段階は 80%、60%、40%、20% となる。`--notify-below` と併用した場合は両方の閾値の和集合を使い、同じ段階は1回だけ通知する。

`--notify-exclude <text>` を指定すると、`--filter` と同じ規則（表示名と期間を連結した文字列への大文字・小文字を区別しない部分一致）で一致する制限を通知対象から外す。表示と JSON/NDJSON には残る。複数回指定でき、いずれかに一致すれば通知しない。指定した除外は通知設定の表示に「除外: …」として併記される。

```sh
# 閉じるまで残るポップアップ（既定）
./token-watcher-codex --watch --notify-below 20

# ディスプレイ右上のMac 通知センター通知
./token-watcher-codex --watch --notify-below 20 --notify-method notification
```

`--notify-every` の最初の取得時は、到達済みの通知段階を基準として記録するだけで通知しない。以後は上から下へ段階をまたいだときだけ通知し、複数段階を飛び越えた場合も最も低い到達段階を1回だけ通知する。`--notify-below` を指定した場合は、最初の取得時でも固定閾値以下なら通知する。監視中は、前回提示されたリセット日時を過ぎて残量が回復した場合にも1回通知する。リセット時刻の変動だけ、日時の通過だけ、リセット前の残量回復では通知しない。残量が通知段階より上へ回復してから再低下した場合は再通知する。同じ段階内での繰り返し通知はしない。`popup` は「閉じる」ボタンを押すまで表示される。`notification` は Mac 通知センターへ表示され、通知の許可や表示スタイルは「システム設定 → 通知」で設定できる。表示に失敗しても監視は継続する。

API 取得エラーの通知は、連続して失敗している間は1回だけ表示し、取得成功後に再び失敗すると再通知する。Codex では app-server の起動失敗、または3回の再試行後も取得できなかった場合に通知する。Claude では `auto` / `api` の取得失敗や認証情報の取得失敗を通知し、`statusline` では通知しない。Claude の `auto` では、通知後もキャッシュの値を表示する。

どちらの方式でも、通知表示中に監視と1回実行の終了を待たない。

---

## token-watcher-claude（Claude）

Claude Code Pro/Max の利用制限（5時間・7日、モデル別の週次制限）の残量を表示・監視する。statusLine を設定していなくても、キーチェーンの OAuth トークンで利用量を取得できる。ただしトークンはターミナル版 Claude Code を起動したときだけ更新されるため、デスクトップアプリだけの利用では期限切れになる。

### 前提条件

- macOS、Node.js 20 以上
- **Claude Pro または Max プラン**でターミナル版 Claude Code にログイン済みであること（キーチェーンの `Claude Code-credentials` はターミナル版が作成・更新する）
- `--source statusline` を使う場合は **Claude Code v2.1.251 以降**

### 取得元（`--source`）

| 値 | 動作 |
|---|---|
| `auto`（既定） | 利用量 API から取得する。失敗した場合は警告を出し、キャッシュの値を表示する |
| `api` | 利用量 API からだけ取得する。失敗した場合はエラーにする（watch では次の間隔で再試行する） |
| `statusline` | API を呼ばず、`--statusline` が書いたキャッシュだけを表示する（従来の動作） |

> **注意: 利用量 API は Anthropic が公開していない非公式 API です。**
> Claude Code 本体が `/usage` 表示のために使っているエンドポイント（`https://api.anthropic.com/api/oauth/usage`）を、同じ OAuth トークンで呼び出している。公開仕様やサポートはなく、エンドポイント・応答形式・呼び出し回数の制限は予告なく変わる可能性がある。変更されて取得できなくなった場合は、`--source statusline` を使うか、`auto` のままキャッシュ（statusLine 設定時）の値で表示を続ける。

API 取得時の動作:

- macOS キーチェーンの `Claude Code-credentials` から OAuth アクセストークンを読み取り、API 呼び出しにだけ使う。トークンは表示・保存しない。初回はキーチェーンへのアクセス許可ダイアログが表示される場合がある。
- トークンの更新（refresh）は行わない。期限切れの場合は、ターミナル版 Claude Code（`claude` コマンド）を起動すると更新される。デスクトップアプリ（Code タブを含む）はアプリ側で別に認証を管理しており、キーチェーンの `Claude Code-credentials` を更新しない。
- 呼び出しでトークン（利用量）は消費しない。ただし API には呼び出し回数の制限があるため、`--interval` を短くしすぎないこと。HTTP 429 で `Retry-After` が返された場合は、その秒数と `--interval` の長い方だけ待つ。
- API から取得できた値はキャッシュにも保存する。
- 取得するのは 5時間（`five_hour`）、7日（`seven_day`）の制限と、応答の `limits[]` に含まれるモデル別の週次制限（`kind: "weekly_scoped"`、例: Fable）。モデル別の制限は `Claude Fable / seven_day` のように表示し、`--filter fable` で絞り込める。
- モデル別の週次制限は API からだけ取得できる。statusLine の入力には含まれないため、`--source statusline` では表示されない。また `--statusline` がキャッシュを更新すると、キャッシュ上のモデル別の値は消える。
- Claude Code 本体はサーバー側の設定でモデル別の制限を絞り込んで表示するが、このコマンドは応答に含まれる `weekly_scoped` の制限をすべて表示する。そのため `/usage` に出ないモデルが表示される場合がある。

### statusLine の設定（任意）

`--source statusline` を使う場合、または `auto` で API 失敗時の代替値を用意したい場合に設定する。Claude Code の `~/.claude/settings.json` に以下の `statusLine` キーを追加し、Claude Code を再起動する。既存の設定キーは残す。`<PATH>` はこのリポジトリの絶対パスに置き換える。

```json
{
  "statusLine": {
    "type": "command",
    "command": "<PATH>/token-watcher-claude --statusline"
  }
}
```

この設定により、Claude Code が `token-watcher-claude --statusline` を呼び出し、利用状況 JSON を stdin に渡す。コマンドは stdout に短い残量表示を返し、値が変わったときに内部キャッシュを更新する。同じ値の再送だけでは受信時刻を更新せず、古い値を新鮮な情報として扱わない。

statusLine はターミナル版 Claude Code の対話画面でだけ実行され、デスクトップアプリでは実行されない。また、利用制限の値はそのセッションで API 応答を受け取った後にだけ渡されるため、起動しただけではキャッシュは作られない。

> **注意**: このツールは `~/.claude/settings.json` を読まず、編集もしない。

### 使い方

```sh
# 利用量を1回表示（API から取得、失敗時はキャッシュ）
./token-watcher-claude

# statusLine のキャッシュだけを使う（API を呼ばない）
./token-watcher-claude --source statusline

# API だけを使う（失敗時はエラー）
./token-watcher-claude --source api

# JSON で1回表示
./token-watcher-claude --json

# 表示名と期間で絞り込む（大文字・小文字を区別しない部分一致）
./token-watcher-claude --filter "five_hour"

# 180秒ごとに表示を更新する（Ctrl+C で終了）
./token-watcher-claude --watch

# 5分ごとに表示を更新する
./token-watcher-claude --watch --interval 300

# watch + NDJSON
./token-watcher-claude --watch --json

# 残量20%以下でポップアップ通知（--watch と組み合わせて使う）
./token-watcher-claude --watch --notify-below 20

# 残量20%以下で Mac 通知センターへ通知
./token-watcher-claude --watch --notify-below 20 --notify-method notification

# 利用量 API の取得エラーを通知する
./token-watcher-claude --watch --notify-api-error

# 残量が20%減るごとに通知する（80%、60%、40%、20%）
./token-watcher-claude --watch --notify-every 20

# 固定閾値と刻み通知を併用する
./token-watcher-claude --watch --notify-below 30 --notify-every 20

# 5時間の制限は表示したまま通知だけ止める（Claude Fable などモデル別の制限には一致しない）
./token-watcher-claude --watch --notify-every 10 --notify-exclude "claude / five_hour"
```

通知の動作は `token-watcher-codex` の「[通知](#通知)」と同じ。

### 表示形式

```
取得日時: 2026-09-22 10:30:00
Claude       / five_hour / 5時間:       残量 54.5% / リセット 2026-09-22 15:00:00
Claude       / seven_day / 7日（週次）: 残量 77.0% / リセット 2026-09-29 10:30:00
Claude Fable / seven_day / 7日（週次）: 残量 95.0% / リセット 2026-09-29 10:30:00
```

各行の区切りは表示幅でそろえ、残量は小数1桁で表示する。

キャッシュが 300 秒以上古い、またはいずれかの期間のリセット時刻を過ぎている場合は出力末尾に「※ 最新データが取得できていません」と注記する。stale 値では残量に基づく通知をしない。JSON 出力には `stale` フラグ（boolean）が含まれる。

ヘッダ行の「取得日時」は、API から取得した場合はその取得日時、キャッシュを表示した場合は値を最後に受信した日時を示す。

### キャッシュの制限

- キャッシュは API から取得できたとき、または `--statusline` が呼ばれたときだけ更新される。`--source statusline` では、**Claude Code が停止中・アイドル中（会話していない状態）は更新されない。**
- キャッシュは Node.js のユーザー用一時ディレクトリ配下の `token-watcher-claude-<uid>/cache.json` に保存される（ディレクトリ 0700、ファイル 0600）。
- キャッシュには使用率・リセット時刻・受信日時のみ保存する。トークンや認証情報は含まない。

---

## 開発とテスト

テストはNode.js標準のテストランナーで実行する。

```sh
node --test
```

直接CLIを実行する場合は `node dist/codex-cli.mjs`（Codex）または `node dist/claude-cli.mjs`（Claude）を使う。

app-server のプロトコルは [OpenAI 公式 app-server ドキュメント](https://learn.chatgpt.com/docs/app-server) に基づく。接続時は `initialize` の成功後に `initialized` を送り、`account/rateLimits/read` と `account/rateLimits/updated` を利用する。
