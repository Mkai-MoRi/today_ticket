# ウズ当日チケット一覧シート（人間観察BOX / MIRAGE）

Escape ID Organization API から当日の予約を取得し、Googleスプレッドシートの日付タブに一覧を書き込むスクリプト。

- シートURL: `config.json` のターゲット別 `url`（初回実行時に自動作成・mori.blueluc@gmail.com へ共有済み）
- box: 一般公演 `JKI1ilM9EFx7` ＋ 関係者公演 `HLPGsgLQ7LpK` ／ mirage: `AOXma0hWOP4f`（取消済みチケットは除外）
- 列: 時刻・コード・人数・リピ/招待・備考・予約日時（公演区分・券種・氏名・メール・入場は表示しない）

## 常時更新（Vercel）

GitHub `Mkai-MoRi/today_ticket` → Vercel `reiserteam/today-ticket` に接続済み。
`vercel.json` の cron が **10分おき**に `/api/sync` を叩き、box/mirage 両方のシートを更新する（Macの起動不要）。

- 認証: `Authorization: Bearer <CRON_SECRET>`（控えは Desktop の today-ticket-cron-secret.txt）
- 必要env（Production設定済み）: ESCAPE系4つ / GOOGLE系2つ / SPREADSHEET_ID_BOX / SPREADSHEET_ID_MIRAGE / CRON_SECRET
- 手動実行: `curl -H "Authorization: Bearer <CRON_SECRET>" https://today-ticket.vercel.app/api/sync`

## 使い方（ローカル手動実行）

```sh
node sync.mjs                  # 人間観察BOXの今日＋翌日を同期（タブ = YYYY-MM-DD）
node sync.mjs mirage           # MIRAGEを別シートに同期
node sync.mjs --date=2026-09-27  # 日付指定
node sync.mjs --watch          # 10分おきに同期し続ける（普段はVercel cronが担当）
```

## 売れ行きSlackレポート（report.mjs）

今日以降の全日程の 売上・定員・残数 と前回比を集計してSlackへ文字だけで投稿する。

```sh
node report.mjs mirage           # MIRAGEを報告（前回スナップショット: report-state.json）
node report.mjs mirage --dry-run # 送信せずコンソール確認
node report.mjs mirage --no-slack # シートの「売れ行き」タブだけ更新
```

- 月・水・金 10:00 に launchd で自動実行（`~/Library/LaunchAgents/com.uzu.mirage-report.plist`、ログは `report.log`）
- 送信先: `SLACK_WEBHOOK_URL_MIRAGE`（未設定なら共通の `SLACK_WEBHOOK_URL` にフォールバック）
- 実行時にスプレッドシート先頭の「売れ行き」タブへ、Slack通知と同じ内容を回別まで詳しく書く（8人未満=黄、満枠=赤）

## 設定（.env）

- `ESCAPE_API_KEY` — 人間観察BOX運営団体のAPIキー（PIIスコープ付き。氏名・メールが取れる）
- `ESCAPE_EVENT_UID` / `ESCAPE_EVENT_UID_KANKEISHA` — イベントUID
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` — 盗薬次楽カルテと同じサービスアカウント
- `SHARE_WITH` — シート作成時に編集権限を付与するメール（カンマ区切り）

`config.json` を消すと次回実行時に新しいシートを作り直す。
