/**
 * 人間観察BOX 当日チケット一覧 → Google スプレッドシート同期
 *
 * Escape ID Organization API から当日の開催回・チケットを取得し、
 * 日付タブ（YYYY-MM-DD）に一覧を書き込む。依存パッケージなし（Node 18+）。
 *
 * 使い方:
 *   node sync.mjs                  # 人間観察BOXの今日の分を同期（初回はシート自動作成）
 *   node sync.mjs mirage           # MIRAGEを別シートに同期
 *   node sync.mjs --date=2026-09-27
 *   node sync.mjs --watch          # 10分おきに同期し続ける
 *   node sync.mjs --watch --interval=5   # 間隔を分で指定
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { createSign } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

const DIR = fileURLToPath(new URL(".", import.meta.url))
const ENV_PATH = DIR + ".env"
const CONFIG_PATH = DIR + "config.json"

// ---- 設定読み込み: ローカルは .env、Vercel等では process.env（.env が優先） ----
const env = { ...process.env }
if (existsSync(ENV_PATH)) {
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, "")
  }
}
const need = (k) => {
  if (!env[k]) throw new Error(`${k} が .env に未設定です`)
  return env[k]
}

const ESCAPE_API_KEY = need("ESCAPE_API_KEY")
const SA_EMAIL = need("GOOGLE_SERVICE_ACCOUNT_EMAIL")
const SA_KEY = need("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n")
const SHARE_WITH = (env.SHARE_WITH || "").split(",").map((s) => s.trim()).filter(Boolean)
// ターゲットごとに別スプレッドシートへ同期する。box は一般＋関係者の2イベント合算。
const TARGETS = {
  box: {
    sheetTitle: "人間観察BOX 当日チケット一覧",
    events: [
      { uid: need("ESCAPE_EVENT_UID"), label: "一般" },
      ...(env.ESCAPE_EVENT_UID_KANKEISHA ? [{ uid: env.ESCAPE_EVENT_UID_KANKEISHA, label: "関係者" }] : []),
    ],
  },
  mirage: {
    sheetTitle: "MIRAGE 当日チケット一覧",
    events: [{ uid: need("ESCAPE_EVENT_UID_MIRAGE"), label: "一般" }],
    // 当日券（公演当日に購入されたチケット）をSlackへ通知する
    notifySameDay: {
      name: "MIRAGE",
      webhook: env.SLACK_WEBHOOK_URL_MIRAGE || env.SLACK_WEBHOOK_URL,
    },
    // 受付表スプレッドシートに公演回ごとの「受付表 M/D H時」タブを自動生成・追記する
    reception: {
      sheetId: env.RECEPTION_SHEET_ID_MIRAGE,
      title: "『MIRAGE』一般公演",
    },
  },
}

// 外部APIは必ずタイムアウトを付ける（無期限待ちでハングした過去障害の再発防止）
const TIMEOUT = 20000
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`${res.status} ${url}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

// ---- Escape ID API ----
const ESCAPE = "https://orgapi.escape.id/v1"
const escapeGet = (path) => fetchJson(ESCAPE + path, { headers: { "X-API-Key": ESCAPE_API_KEY } })

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

// ---- Google OAuth（サービスアカウント JWT） ----
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
      scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
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

// ---- スプレッドシート準備（初回のみ作成して共有、config.json にターゲット別で保存） ----
async function ensureSpreadsheet(targetKey) {
  // Vercel等ではファイルに保存できないので、env（SPREADSHEET_ID_BOX 等）でIDを渡す
  const envId = env[`SPREADSHEET_ID_${targetKey.toUpperCase()}`]
  if (envId) return envId
  let config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {}
  // 旧形式（トップレベルに spreadsheetId）は box のものとして移行する
  if (config.spreadsheetId) config = { box: config }
  if (config[targetKey]?.spreadsheetId) return config[targetKey].spreadsheetId
  const created = await gapi("https://sheets.googleapis.com/v4/spreadsheets", "POST", {
    properties: { title: TARGETS[targetKey].sheetTitle, locale: "ja_JP", timeZone: "Asia/Tokyo" },
  })
  const id = created.spreadsheetId
  for (const email of SHARE_WITH) {
    await gapi(
      `https://www.googleapis.com/drive/v3/files/${id}/permissions?sendNotificationEmail=false`,
      "POST",
      { type: "user", role: "writer", emailAddress: email },
    )
  }
  config[targetKey] = { spreadsheetId: id, url: created.spreadsheetUrl }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  console.log("シートを作成しました:", created.spreadsheetUrl)
  return id
}

async function ensureTab(spreadsheetId, title, index = 0) {
  const meta = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
  )
  const found = meta.sheets.find((s) => s.properties.title === title)
  if (found) return { sheetId: found.properties.sheetId, created: false }
  const res = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    "POST",
    {
      requests: [
        {
          addSheet: {
            // index未指定なら末尾に追加
            properties: { title, ...(index != null ? { index } : {}), gridProperties: { frozenRowCount: 2 } },
          },
        },
      ],
    },
  )
  return { sheetId: res.replies[0].addSheet.properties.sheetId, created: true }
}

// 時間別タブの色分け: 0人の回は青、満枠(残=0)は赤、残1〜4は黄。タブ作成時に一度だけ登録する。
// 各ルールを index 0 に挿入するため、後に追加したものほど優先される（青が最優先）。
async function addHourlyFormatRules(spreadsheetId, sheetId) {
  const range = { sheetId, startRowIndex: 2, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 4 }
  const rule = (formula, color) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
          format: { backgroundColor: color },
        },
      },
      index: 0,
    },
  })
  await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", {
    requests: [
      rule('=AND($A3<>"",$D3=0)', { red: 1, green: 0.4, blue: 0.4 }),
      rule('=AND($A3<>"",$D3>0,$D3<=4)', { red: 1, green: 0.92, blue: 0.45 }),
      rule('=AND($A3<>"",$B3=0)', { red: 0.55, green: 0.75, blue: 1 }),
    ],
  })
  // 凡例を右端（F列）に色付きで書く
  const legend = [
    ["0人の回", { red: 0.55, green: 0.75, blue: 1 }],
    ["残り4枠以下", { red: 1, green: 0.92, blue: 0.45 }],
    ["満枠", { red: 1, green: 0.4, blue: 0.4 }],
  ]
  await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", {
    requests: [
      {
        updateCells: {
          start: { sheetId, rowIndex: 1, columnIndex: 5 },
          fields: "userEnteredValue,userEnteredFormat.backgroundColor",
          rows: legend.map(([text, backgroundColor]) => ({
            values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: { backgroundColor } }],
          })),
        },
      },
    ],
  })
}

// 全日程タブ版の色分け（列構成が違う: C=人数, E=残）。凡例はG列。
async function addAllHourlyFormatRules(spreadsheetId, sheetId) {
  const range = { sheetId, startRowIndex: 2, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 5 }
  const rule = (formula, color) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
          format: { backgroundColor: color },
        },
      },
      index: 0,
    },
  })
  await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", {
    requests: [
      rule('=AND($A3<>"",$E3=0)', { red: 1, green: 0.4, blue: 0.4 }),
      rule('=AND($A3<>"",$E3>0,$E3<=4)', { red: 1, green: 0.92, blue: 0.45 }),
      rule('=AND($A3<>"",$C3=0)', { red: 0.55, green: 0.75, blue: 1 }),
      {
        updateCells: {
          start: { sheetId, rowIndex: 1, columnIndex: 6 },
          fields: "userEnteredValue,userEnteredFormat.backgroundColor",
          rows: [
            ["0人の回", { red: 0.55, green: 0.75, blue: 1 }],
            ["残り4枠以下", { red: 1, green: 0.92, blue: 0.45 }],
            ["満枠", { red: 1, green: 0.4, blue: 0.4 }],
          ].map(([text, backgroundColor]) => ({
            values: [{ userEnteredValue: { stringValue: text }, userEnteredFormat: { backgroundColor } }],
          })),
        },
      },
    ],
  })
}

// ---- 当日データ取得 → 行データ化 ----
const hm = (iso) => iso.slice(11, 16)

// detailDates（今日・翌日など）の明細行と、今日以降全日程の時間別集計を一度の取得でまとめて作る。
// スロット・チケットのAPI呼び出しは全日程分を1回ずつで済ませ、日付別には振り分けだけ行う。
// 購入時アンケートの自由回答からニックネームを取り出す
const nicknameOf = (t) =>
  t.inquiryAnswers?.find((a) => a.type === "text" && a.question?.includes("ニックネーム"))?.answer || ""

async function buildData(events, detailDates) {
  const fromDate = detailDates[0]
  const detail = Object.fromEntries(detailDates.map((d) => [d, { rows: [], checkedIn: 0 }]))
  const slotAgg = new Map() // "date time" → { date, time, count, capacity }（イベント合算）
  const sameDay = [] // 当日券 = 公演当日(fromDate)に購入された当日公演のチケット
  const slotTickets = new Map() // 今日以降全公演の "date time" → チケット配列（受付表用）
  for (const ev of events) {
    const slots = (await escapeGet(`/events/${ev.uid}/slots`)).items
      .filter((s) => s.startAt.slice(0, 10) >= fromDate)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
    const ticketsBySlot = await mapLimit(slots, 5, (s) =>
      escapeGet(`/events/${ev.uid}/slots/${s.uid}/tickets`),
    )
    slots.forEach((slot, i) => {
      const date = slot.startAt.slice(0, 10)
      const time = hm(slot.startAt)
      const key = `${date} ${time}`
      const agg = slotAgg.get(key) || { date, time, count: 0, capacity: 0 }
      agg.capacity += slot.simpleCapacity ?? (slot.tableUnitCapacity ?? 0) * (slot.tableCount ?? 0)
      slotAgg.set(key, agg)
      const d = detail[date]
      const st = slotTickets.get(key) || slotTickets.set(key, []).get(key)
      for (const t of ticketsBySlot[i].items) {
        if (t.revokedAt) continue
        agg.count += t.quantity
        st.push({ ticketCode: t.ticketCode, quantity: t.quantity, nickname: nicknameOf(t), note: t.note || "" })
        if (date === fromDate && t.createdAt.slice(0, 10) === fromDate) {
          sameDay.push({
            ticketCode: t.ticketCode,
            quantity: t.quantity,
            nickname: nicknameOf(t),
            time,
            createdAt: t.createdAt.slice(11, 16),
          })
        }
        if (d) {
          if (t.redeemedAt) d.checkedIn += t.quantity
          d.rows.push([
            time,
            t.ticketCode,
            t.quantity,
            [t.isInvited ? "招待" : "", t.isRepeater ? "リピーター" : ""].filter(Boolean).join("・"),
            t.note || "",
            t.createdAt.slice(0, 16).replace("T", " "),
          ])
        }
      }
    })
  }
  for (const d of Object.values(detail)) d.rows.sort((a, b) => a[0].localeCompare(b[0]))
  const all = [...slotAgg.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
  return { detail, all, sameDay, slotTickets }
}

// ---- 当日券のSlack通知（通知済み管理はシートの専用タブ。Vercelはステートレスなため） ----
const NOTIFIED_TAB = "通知済み当日券"

async function notifySameDayPurchases(spreadsheetId, notify, date, tickets) {
  if (!notify.webhook || !tickets.length) return
  await ensureTab(spreadsheetId, NOTIFIED_TAB, null)
  const existing = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${NOTIFIED_TAB}'!A:A`)}`,
  )
  const seen = new Set((existing.values || []).flat())
  const fresh = tickets.filter((t) => !seen.has(t.ticketCode))
  if (!fresh.length) return
  const lines = [
    `🎟️ 当日券が購入されました（${notify.name} ${fmtDate(date)}）`,
    ...fresh.map(
      (t) =>
        `${t.time}の回 ${t.quantity}人 / コード ${t.ticketCode} / ニックネーム: ${t.nickname || "（未記入）"}`,
    ),
  ]
  const res = await fetch(notify.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`Slack通知失敗: ${res.status} ${await res.text()}`)
  // 送信に成功したものだけ通知済みとして記録する（失敗時は次回リトライ）
  const notifiedAt = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${NOTIFIED_TAB}'!A1`)}:append?valueInputOption=RAW`,
    "POST",
    { values: fresh.map((t) => [t.ticketCode, date, t.time, t.quantity, t.nickname, notifiedAt]) },
  )
  console.log(`当日券通知: ${fresh.length}件（${fresh.map((t) => t.ticketCode).join(", ")}）`)
}

// ---- MIRAGE受付表: 公演回ごとの「受付表 M/D H時」タブを既存フォーマットで生成・追記 ----
// 1人1行（予約番号・氏名(ニックネーム)・組分け・受付確認/誓約書回収チェックボックス・備考）。
// 既存タブへは未記載の予約番号だけを末尾に追記し、現場で入力済みのチェックや組分けは触らない。
const RC_GRAY = { red: 0.9529412, green: 0.9529412, blue: 0.9529412 }
const RC_WIDTHS = [74, 137, 115, 93, 93, 242]

// 自由回答のニックネームを人数分に分割する。書き方のゆらぎに段階的に対応:
//   区切り文字（、,・/など）→ 足りなければ「」括り → さらに足りなければスペース区切り。
// 「1人目:しお」「1枚目…りり」「1娘：アヤちゃん」のような番号ラベルや ･ 箇条書き、「」括りは剥がす。
// 「と」では切らない（「まこと」等の名前を壊すため）。それでも1つしか取れなければ代表者名として先頭行に入れる。
export function splitNames(nickname, quantity) {
  const raw = (nickname || "").trim().replace(/[。．]$/, "")
  const clean = (s) =>
    s
      .trim()
      .replace(/^[･・●○◯\-‐]\s*/, "") // 箇条書きの頭
      .replace(/^[0-9０-９①-⑳]+[^\s：:．.、…‥]{0,6}?[：:．.、…‥]+\s*/, "") // 「1.」「2人目:」「1枚目…」「1娘：」
      .replace(/^[「『“"]|[」』”"]$/g, "")
      .trim()
  let parts = raw.split(/[、,，・\/／\n;；]+/).map(clean).filter(Boolean)
  if (parts.length < quantity) {
    const quoted = [...raw.matchAll(/[「『]([^」』]+)[」』]/g)].map((m) => m[1].trim()).filter(Boolean)
    if (quoted.length > parts.length) parts = quoted
  }
  if (parts.length < quantity) {
    const spaced = raw.split(/[\s　]+/).map(clean).filter(Boolean)
    if (spaced.length > parts.length) parts = spaced
  }
  const names = parts.slice(0, quantity)
  if (parts.length > quantity && quantity > 0) names[quantity - 1] = parts.slice(quantity - 1).join("、")
  while (names.length < quantity) names.push("")
  return names
}

const rcCell = (value, format = {}) => ({
  userEnteredValue: typeof value === "boolean" ? { boolValue: value } : { stringValue: String(value) },
  userEnteredFormat: format,
})

// absIdx は0始まりの行番号。4行目(absIdx=3)が白、以降交互に灰色（既存タブの縞に合わせる）
function receptionPersonRows(tickets, startIdx) {
  const rows = []
  for (const t of tickets) {
    splitNames(t.nickname, t.quantity).forEach((name, i) => {
      const bg = (startIdx + rows.length) % 2 === 0 ? { backgroundColor: RC_GRAY } : {}
      const center = { horizontalAlignment: "CENTER", ...bg }
      rows.push({
        values: [
          rcCell(t.ticketCode, center),
          rcCell(name, { ...center, textFormat: { fontSize: 14 } }),
          rcCell("", bg),
          rcCell(false, center),
          rcCell(false, center),
          rcCell(i === 0 ? t.note : "", bg),
        ],
      })
    })
  }
  return rows
}

const RC_CELL_FIELDS = "userEnteredValue,userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"

// 行の高さ（元の受付表と同じ: タイトル34/日付21/ヘッダー30/データ行47）
const rcRowHeight = (sheetId, startIndex, endIndex, pixelSize) => ({
  updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex, endIndex },
    properties: { pixelSize },
    fields: "pixelSize",
  },
})

// 表全体（A1〜F最終行）に実線の格子罫線を引く（元の受付表と同じ見た目）
const RC_BORDER = { style: "SOLID", color: { red: 0, green: 0, blue: 0 } }
const receptionBorderRequest = (sheetId, endRowIndex) => ({
  updateBorders: {
    range: { sheetId, startRowIndex: 0, endRowIndex, startColumnIndex: 0, endColumnIndex: 6 },
    top: RC_BORDER,
    bottom: RC_BORDER,
    left: RC_BORDER,
    right: RC_BORDER,
    innerHorizontal: RC_BORDER,
    innerVertical: RC_BORDER,
  },
})

function receptionRowRequests(sheetId, startIdx, tickets) {
  const rows = receptionPersonRows(tickets, startIdx)
  if (!rows.length) return []
  return [
    { updateCells: { start: { sheetId, rowIndex: startIdx, columnIndex: 0 }, fields: RC_CELL_FIELDS, rows } },
    {
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: startIdx,
          endRowIndex: startIdx + rows.length,
          startColumnIndex: 3,
          endColumnIndex: 5,
        },
        rule: { condition: { type: "BOOLEAN" }, strict: true },
      },
    },
  ]
}

const receptionTabTitle = (date, time) =>
  `受付表 ${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${Number(time.slice(0, 2))}時`

// 全公演分のタブをまとめて作成し（API 2回）、appendDates（今日・翌日）の既存タブには未記載分を追記する
async function upsertReceptionTabs(reception, slotTickets, appendDates) {
  const id = reception.sheetId
  const meta = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`)
  const tabs = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]))
  const keys = [...slotTickets.keys()].sort()

  // まとめて新規作成（タブ数が多いためAPI呼び出しをバッチ化してレート制限を避ける）
  const toCreate = keys
    .map((key) => {
      const [date, time] = key.split(" ")
      return { date, time, tickets: slotTickets.get(key), title: receptionTabTitle(date, time) }
    })
    .filter((c) => !tabs.has(c.title))
  if (toCreate.length) {
    const added = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, "POST", {
      requests: toCreate.map((c) => ({ addSheet: { properties: { title: c.title } } })),
    })
    const requests = []
    toCreate.forEach((c, idx) => {
      const sheetId = added.replies[idx].addSheet.properties.sheetId
      tabs.set(c.title, sheetId)
      const [h, m] = c.time.split(":").map(Number)
      const open = `${String(Math.floor((h * 60 + m - 30) / 60)).padStart(2, "0")}:${String((h * 60 + m - 30) % 60).padStart(2, "0")}`
      const dateLine = `　${Number(c.date.slice(5, 7))}月${Number(c.date.slice(8, 10))}日(${WEEKDAYS[new Date(c.date + "T00:00:00+09:00").getDay()]}) 開場${open}　開演${c.time}`
      const headerFmt = { textFormat: { bold: true }, horizontalAlignment: "CENTER" }
      requests.push(
        ...RC_WIDTHS.map((pixelSize, i) => ({
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
            properties: { pixelSize },
            fields: "pixelSize",
          },
        })),
        { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 6 } } },
        { mergeCells: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 6 } } },
        {
          updateCells: {
            start: { sheetId, rowIndex: 0, columnIndex: 0 },
            fields: RC_CELL_FIELDS,
            rows: [
              { values: [rcCell(reception.title, { textFormat: { bold: true, fontSize: 14 }, horizontalAlignment: "CENTER" })] },
              { values: [rcCell(dateLine, { horizontalAlignment: "CENTER" })] },
              { values: ["予約番号", "氏名", "組分け", "受付確認", "誓約書回収", "備考"].map((v) => rcCell(v, headerFmt)) },
            ],
          },
        },
        ...receptionRowRequests(sheetId, 3, c.tickets),
        receptionBorderRequest(sheetId, 3 + c.tickets.reduce((s, t) => s + t.quantity, 0)),
        rcRowHeight(sheetId, 0, 1, 34),
        rcRowHeight(sheetId, 1, 2, 21),
        rcRowHeight(sheetId, 2, 3, 30),
        rcRowHeight(sheetId, 3, 3 + c.tickets.reduce((s, t) => s + t.quantity, 0), 47),
      )
    })
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, "POST", { requests })
    console.log(`受付表タブを作成: ${toCreate.map((c) => c.title).join(", ")}`)
  }

  // 既存タブへの追記は今日・翌日分だけ（直前の購入を取りこぼさないため）
  for (const key of keys) {
    const [date, time] = key.split(" ")
    if (!appendDates.includes(date)) continue
    const title = receptionTabTitle(date, time)
    const tickets = slotTickets.get(key)
    if (toCreate.some((c) => c.title === title)) continue // いま作ったばかり
    {
      const sheetId = tabs.get(title)
      const existing = await gapi(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${title}'!A1:A1000`)}`,
      )
      const rows = existing.values || []
      const seen = new Set(rows.map((r) => r[0]).filter(Boolean))
      const fresh = tickets.filter((t) => !seen.has(t.ticketCode))
      if (!fresh.length) continue
      const startIdx = rows.length // 0始まり = 最終使用行の次
      const requests = receptionRowRequests(sheetId, startIdx, fresh)
      if (requests.length) {
        const endIdx = startIdx + fresh.reduce((s, t) => s + t.quantity, 0)
        requests.push(receptionBorderRequest(sheetId, endIdx), rcRowHeight(sheetId, startIdx, endIdx, 47))
        await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, "POST", { requests })
        console.log(`受付表に追記: ${title} ${fresh.length}件（${fresh.map((t) => t.ticketCode).join(", ")}）`)
      }
    }
  }
}

// ---- 公演45分前に受付表のPDF/Excelリンクをリマインド（10分おきcron前提: 45〜35分前に届く） ----
const REMIND_BEFORE_MIN = Number(env.REMIND_BEFORE_MIN) || 45
const REMINDED_TAB = "リマインド済み"

async function remindUpcomingReception(reception, webhook, all, today) {
  if (!webhook) return
  const slotsToday = all.filter((a) => a.date === today)
  if (!slotsToday.length) return
  const [nh, nm] = new Date()
    .toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour12: false })
    .split(":")
    .map(Number)
  const nowMin = nh * 60 + nm
  const due = slotsToday.filter((s) => {
    const min = Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5))
    return min - nowMin > 0 && min - nowMin <= REMIND_BEFORE_MIN
  })
  if (!due.length) return
  const id = reception.sheetId
  const meta = await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`)
  const tabs = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]))
  await ensureTab(id, REMINDED_TAB, null)
  const rem = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${REMINDED_TAB}'!A:A`)}`,
  )
  const seen = new Set((rem.values || []).flat())
  for (const s of due) {
    const slotKey = `${s.date} ${s.time}`
    if (seen.has(slotKey)) continue
    const title = receptionTabTitle(s.date, s.time)
    const gid = tabs.get(title)
    const base = `https://docs.google.com/spreadsheets/d/${id}`
    const lines = [
      `📋 まもなく開演です: ${fmtDate(s.date)} ${s.time}の回（${s.count}人予約）`,
      `受付表「${title}」`,
      ...(gid != null
        ? [
            `PDF: ${base}/export?format=pdf&gid=${gid}&portrait=true&fitw=true`,
            `Excel(全タブ): ${base}/export?format=xlsx`,
            `シートで開く: ${base}/edit#gid=${gid}`,
          ]
        : [`シート: ${base}/edit（タブ「${title}」が見つかりませんでした）`]),
    ]
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) throw new Error(`リマインド送信失敗: ${res.status} ${await res.text()}`)
    // 送信成功時のみ記録（失敗は次回リトライ）
    await gapi(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`'${REMINDED_TAB}'!A1`)}:append?valueInputOption=RAW`,
      "POST",
      { values: [[slotKey, new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })]] },
    )
    console.log(`開演前リマインド送信: ${slotKey}`)
  }
}

async function writeTab(spreadsheetId, tab, clearRange, values) {
  // 古い行が残らないよう一度クリアしてから書き込む
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!${clearRange}`)}:clear`,
    "POST",
    {},
  )
  await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`,
    "PUT",
    { values },
  )
}

// タブを指定順に並べ直す（指定外の古い日付タブはその後ろに残る）
async function reorderTabs(spreadsheetId, orderedTitles) {
  const meta = await gapi(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
  )
  const byTitle = new Map(meta.sheets.map((s) => [s.properties.title, s.properties]))
  const requests = orderedTitles
    .filter((t) => byTitle.has(t))
    .map((t, i) => ({
      updateSheetProperties: { properties: { sheetId: byTitle.get(t).sheetId, index: i }, fields: "index" },
    }))
  if (requests.length)
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, "POST", { requests })
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"]
const fmtDate = (date) => `${date.slice(5)}(${WEEKDAYS[new Date(date + "T00:00:00+09:00").getDay()]})`

async function sync(targetKey, detailDates) {
  const spreadsheetId = await ensureSpreadsheet(targetKey)
  const { detail, all, sameDay, slotTickets } = await buildData(TARGETS[targetKey].events, detailDates)
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
  if (TARGETS[targetKey].notifySameDay) {
    await notifySameDayPurchases(spreadsheetId, TARGETS[targetKey].notifySameDay, detailDates[0], sameDay)
  }
  if (TARGETS[targetKey].reception?.sheetId) {
    await upsertReceptionTabs(TARGETS[targetKey].reception, slotTickets, detailDates)
    await remindUpcomingReception(
      TARGETS[targetKey].reception,
      TARGETS[targetKey].notifySameDay?.webhook,
      all,
      detailDates[0],
    )
  }
  // タブ順: 日付 / 日付 時間別 … / 時間別 全日程
  let tabIndex = 0
  for (const date of detailDates) {
    const hourly = all.filter((a) => a.date === date)
    // 開催のない日（MIRAGEの平日など）はタブを作らない
    if (!hourly.length) {
      console.log(`${now} [${targetKey}] ${date} は開催なしのためタブ作成をスキップ`)
      continue
    }
    const { rows, checkedIn } = detail[date]
    const total = rows.reduce((s, r) => s + r[2], 0)
    await ensureTab(spreadsheetId, date, tabIndex++)
    await writeTab(spreadsheetId, date, "A:K", [
      [`${date} 合計 ${rows.length}件 / ${total}人`, "", "", "", "", `更新: ${now}`],
      ["時刻", "コード", "人数", "リピ/招待", "備考", "予約日時"],
      ...rows,
    ])
    // 時間別タブ（回ごとの人数・定員・残）
    const hourlyTab = `${date} 時間別`
    const h = await ensureTab(spreadsheetId, hourlyTab, tabIndex++) // 日付タブのすぐ後ろ
    if (h.created) await addHourlyFormatRules(spreadsheetId, h.sheetId)
    await writeTab(spreadsheetId, hourlyTab, "A:D", [
      [`${date} 合計 ${hourly.reduce((s, a) => s + a.count, 0)}人`, "", "", `更新: ${now}`],
      ["時刻", "人数", "定員", "残"],
      ...hourly.map((a) => [a.time, a.count, a.capacity, a.capacity - a.count]),
    ])
    console.log(`${now} 同期完了[${targetKey}]: ${date} ${rows.length}件 / ${total}人（入場済 ${checkedIn}人）`)
  }
  // 時間別 全日程タブ（今日以降の全開催回）
  const allTab = "時間別 全日程"
  const a = await ensureTab(spreadsheetId, allTab, tabIndex)
  if (a.created) await addAllHourlyFormatRules(spreadsheetId, a.sheetId)
  await writeTab(spreadsheetId, allTab, "A:E", [
    [`${detailDates[0]}以降 合計 ${all.reduce((s, x) => s + x.count, 0)}人`, "", "", "", `更新: ${now}`],
    ["日付", "時刻", "人数", "定員", "残"],
    ...all.map((x) => [fmtDate(x.date), x.time, x.count, x.capacity, x.capacity - x.count]),
  ])
  await reorderTabs(spreadsheetId, [...detailDates.flatMap((d) => [d, `${d} 時間別`]), allTab])
}

const jstDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }) // YYYY-MM-DD

// 今日＋翌日の明細と全日程の時間別を同期（Vercelのcronからも使う）
export const syncTarget = (targetKey, dates = [jstDate(0), jstDate(1)]) => sync(targetKey, dates)
export const targetKeys = Object.keys(TARGETS)

// ---- CLIエントリポイント（importされたときは実行しない） ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith("--")) || "box"
  if (!TARGETS[target]) {
    console.error(`不明なターゲット: ${target}（指定可能: ${Object.keys(TARGETS).join(", ")}）`)
    process.exit(1)
  }
  const dateArg = args.find((a) => a.startsWith("--date="))?.slice(7)
  const watch = args.includes("--watch")
  const intervalMin = Number(args.find((a) => a.startsWith("--interval="))?.slice(11)) || 10

  // --date 指定時はその日だけ、通常は今日＋翌日の明細と全日程の時間別を同期
  const syncAll = () => syncTarget(target, dateArg ? [dateArg] : undefined)

  if (watch) {
    const loop = async () => {
      try {
        await syncAll()
      } catch (e) {
        console.error("同期エラー:", e.message)
      }
      setTimeout(loop, intervalMin * 60 * 1000)
    }
    console.log(`[${target}] ${intervalMin}分おきに同期します（Ctrl+Cで停止）`)
    loop()
  } else {
    await syncAll()
  }
}
