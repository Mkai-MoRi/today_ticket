/**
 * チケット売れ行きレポート → Slack 通知（文字のみ）
 *
 * 今日以降の全日程について 売上数・定員・残数 を集計し、
 * 前回実行時のスナップショット（report-state.json）との差分と合わせて Slack に投稿する。
 *
 * 使い方:
 *   node report.mjs            # mirage を報告
 *   node report.mjs box        # 人間観察BOX を報告
 *   node report.mjs --dry-run  # Slackに送らずコンソール表示のみ（スナップショット・シートも更新しない）
 *   node report.mjs --no-slack # シートの「売れ行き」タブだけ更新（Slack送信・スナップショット更新なし）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createSign } from "node:crypto"
import { fileURLToPath } from "node:url"

const DIR = fileURLToPath(new URL(".", import.meta.url))
const STATE_PATH = DIR + "report-state.json"
const CONFIG_PATH = DIR + "config.json"

const env = {}
for (const line of readFileSync(DIR + ".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "")
}
const need = (k) => {
  if (!env[k]) throw new Error(`${k} が .env に未設定です`)
  return env[k]
}

const ESCAPE_API_KEY = need("ESCAPE_API_KEY")
const SA_EMAIL = need("GOOGLE_SERVICE_ACCOUNT_EMAIL")
const SA_KEY = need("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n")

// ターゲット別Webhook（SLACK_WEBHOOK_URL_MIRAGE 等）があれば優先、なければ共通の SLACK_WEBHOOK_URL
const TARGETS = {
  box: {
    name: "人間観察BOX",
    events: [need("ESCAPE_EVENT_UID"), ...(env.ESCAPE_EVENT_UID_KANKEISHA ? [env.ESCAPE_EVENT_UID_KANKEISHA] : [])],
    webhook: env.SLACK_WEBHOOK_URL_BOX || need("SLACK_WEBHOOK_URL"),
  },
  mirage: {
    name: "MIRAGE",
    events: [need("ESCAPE_EVENT_UID_MIRAGE")],
    webhook: env.SLACK_WEBHOOK_URL_MIRAGE || need("SLACK_WEBHOOK_URL"),
  },
}

// 外部APIは必ずタイムアウトを付ける（無期限待ちでハングした過去障害の再発防止）
const TIMEOUT = 20000
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}
const escapeGet = (path) =>
  fetchJson("https://orgapi.escape.id/v1" + path, { headers: { "X-API-Key": ESCAPE_API_KEY } })

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cur = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cur < items.length) {
        const i = cur++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

// ---- Google OAuth（サービスアカウント JWT、sync.mjs と同じ方式） ----
let tokenCache = { token: null, exp: 0 }
async function googleToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const unsigned =
    b64({ alg: "RS256", typ: "JWT" }) +
    "." +
    b64({
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  const sig = createSign("RSA-SHA256").update(unsigned).sign(SA_KEY, "base64url")
  const data = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${sig}`,
  })
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 }
  return tokenCache.token
}
async function gapi(url, method = "GET", body) {
  return fetchJson(url, {
    method,
    headers: { Authorization: `Bearer ${await googleToken()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ---- 集計: 今日以降の日程ごとに 売上/定員/残 ----
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" })

async function collect(target) {
  const byDate = new Map() // YYYY-MM-DD → { sold, capacity }
  const slotRows = [] // 回ごとの { date, time, sold, capacity }
  const from = today()
  for (const uid of target.events) {
    const slots = (await escapeGet(`/events/${uid}/slots`)).items.filter(
      (s) => s.startAt.slice(0, 10) >= from,
    )
    const ticketsBySlot = await mapLimit(slots, 5, (s) => escapeGet(`/events/${uid}/slots/${s.uid}/tickets`))
    slots.forEach((slot, i) => {
      const date = slot.startAt.slice(0, 10)
      const agg = byDate.get(date) || { sold: 0, capacity: 0 }
      const capacity = slot.simpleCapacity ?? (slot.tableUnitCapacity ?? 0) * (slot.tableCount ?? 0)
      agg.capacity += capacity
      let sold = 0
      for (const t of ticketsBySlot[i].items) {
        if (t.revokedAt) continue
        sold += t.quantity
      }
      agg.sold += sold
      byDate.set(date, agg)
      slotRows.push({ date, time: slot.startAt.slice(11, 16), sold, capacity })
    })
  }
  slotRows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  return {
    byDate: Object.fromEntries([...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    slotRows,
  }
}

// ---- メッセージ組み立て ----
const WD = ["日", "月", "火", "水", "木", "金", "土"]
const label = (d) => {
  const [y, m, day] = d.split("-").map(Number)
  return `${m}/${day}(${WD[new Date(y, m - 1, day).getDay()]})`
}

const MIN_PER_SLOT = 8 // これに満たない回をピックアップして知らせる

function buildMessage(targetKey, targetName, { byDate, slotRows }, prev) {
  const total = Object.values(byDate).reduce((s, a) => s + a.sold, 0)
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
  const lines = [`🎫 ${targetName} チケット状況（${now} 時点）`]

  if (prev) {
    // 前回スナップショットと同じ日付集合で比較する（過ぎた日程は前回値から除外）
    const prevTotal = Object.entries(prev.byDate)
      .filter(([d]) => d in byDate)
      .reduce((s, [, a]) => s + a.sold, 0)
    const diff = total - prevTotal
    lines.push(`前回報告（${prev.at}）から *${diff >= 0 ? "+" : ""}${diff}枚*（今日以降の合計 ${total}枚）`)
  } else {
    lines.push(`今日以降の合計 ${total}枚（初回報告のため前回比なし）`)
  }

  lines.push("", "▼ 各日程の残数")
  for (const [date, a] of Object.entries(byDate)) {
    const remain = a.capacity - a.sold
    const prevSold = prev?.byDate?.[date]?.sold
    const d = prevSold != null ? a.sold - prevSold : null
    const diffNote = d ? `（前回比 ${d > 0 ? "+" : ""}${d}）` : ""
    const mark = remain <= 0 ? " 🈵" : remain <= 4 ? " ⚠️" : ""
    lines.push(`${label(date)} 残${remain}/${a.capacity}（売${a.sold}${diffNote}）${mark}`)
  }
  if (!Object.keys(byDate).length) lines.push("今日以降の日程はありません")

  const under = slotRows.filter((s) => s.sold < MIN_PER_SLOT)
  if (under.length) {
    lines.push("", `▼ ${MIN_PER_SLOT}人に満たない回（${under.length}回）`)
    for (const s of under) lines.push(`${label(s.date)} ${s.time} — ${s.sold}人（あと${MIN_PER_SLOT - s.sold}人）`)
  }

  // 当日チケット一覧スプレッドシート（sync.mjs が config.json に保存したURL）
  const sheetUrl = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf8"))[targetKey]?.url
    : null
  if (sheetUrl) lines.push("", `📋 スプレッドシート: ${sheetUrl}`)
  return lines.join("\n")
}

// ---- スプレッドシート「売れ行き」タブ: Slack通知と同じ内容を回別まで詳しく書く ----
const SUMMARY_TAB = "売れ行き"

async function writeSummarySheet(spreadsheetId, { byDate, slotRows }, prev) {
  const meta = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
  )
  let sheet = meta.sheets.find((s) => s.properties.title === SUMMARY_TAB)
  if (!sheet) {
    const res = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", {
      requests: [
        { addSheet: { properties: { title: SUMMARY_TAB, index: 0, gridProperties: { frozenRowCount: 1 } } } },
      ],
    })
    const sheetId = res.replies[0].addSheet.properties.sheetId
    // 状態列の文字で色分け: ⚠️(8人未満)=黄、🈵(満枠)=灰。作成時に一度だけ登録。
    const range = { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 7 }
    const rule = (text, color) => ({
      addConditionalFormatRule: {
        rule: {
          ranges: [range],
          booleanRule: {
            condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=COUNTIF($F2,"*${text}*")` }] },
            format: { backgroundColor: color },
          },
        },
        index: 0,
      },
    })
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", {
      requests: [rule("⚠️", { red: 1, green: 0.92, blue: 0.45 }), rule("🈵", { red: 0.85, green: 0.85, blue: 0.85 })],
    })
  }

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
  const total = Object.values(byDate).reduce((s, a) => s + a.sold, 0)
  const prevTotal = prev
    ? Object.entries(prev.byDate).filter(([d]) => d in byDate).reduce((s, [, a]) => s + a.sold, 0)
    : null
  const fmtDiff = (d) => (d == null ? "" : `${d >= 0 ? "+" : ""}${d}`)

  const values = [
    ["日付", "時刻", "売上", "定員", "残", "状態", `更新: ${now}${prev ? `（前回比 ${fmtDiff(total - prevTotal)}枚・合計 ${total}枚）` : `（合計 ${total}枚）`}`],
  ]
  for (const [date, a] of Object.entries(byDate)) {
    // 日付の合計行 → その日の回別行 の順に並べる
    const prevSold = prev?.byDate?.[date]?.sold
    values.push([
      label(date),
      "合計",
      a.sold,
      a.capacity,
      a.capacity - a.sold,
      "",
      prevSold != null ? `前回比 ${fmtDiff(a.sold - prevSold)}` : "",
    ])
    for (const s of slotRows.filter((r) => r.date === date)) {
      const remain = s.capacity - s.sold
      const status =
        remain <= 0 ? "🈵 満枠" : s.sold < MIN_PER_SLOT ? `⚠️ あと${MIN_PER_SLOT - s.sold}人で${MIN_PER_SLOT}人` : ""
      values.push(["", s.time, s.sold, s.capacity, remain, status, ""])
    }
  }
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${SUMMARY_TAB}'!A:G:clear`,
    "POST",
    {},
  )
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${SUMMARY_TAB}'!A1?valueInputOption=RAW`,
    "PUT",
    { values },
  )
}

// ---- 実行 ----
const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const noSlack = args.includes("--no-slack")
const targetKey = args.find((a) => !a.startsWith("--")) || "mirage"
const target = TARGETS[targetKey]
if (!target) {
  console.error(`不明なターゲット: ${targetKey}（指定可能: ${Object.keys(TARGETS).join(", ")}）`)
  process.exit(1)
}

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : {}
const collected = await collect(target)
const { byDate } = collected
const message = buildMessage(targetKey, target.name, collected, state[targetKey])

if (dryRun) {
  console.log(message)
} else {
  // シートの「売れ行き」タブにも同じ内容を回別まで詳しく書く（前回比はSlackと同じ基準）
  const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}
  const spreadsheetId = config[targetKey]?.spreadsheetId
  if (spreadsheetId) await writeSummarySheet(spreadsheetId, collected, state[targetKey])
  if (noSlack) {
    console.log("シートの売れ行きタブを更新しました（Slack送信なし）")
  } else {
    // Slack Webhookは成功時にJSONでない "ok" を返すため fetchJson は使わない
    const res = await fetch(target.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) throw new Error(`Slack送信失敗: ${res.status} ${await res.text()}`)
    state[targetKey] = {
      at: new Date().toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" }),
      byDate,
    }
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
    console.log("Slackに報告しました:\n" + message)
  }
}
