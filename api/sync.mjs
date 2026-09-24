/**
 * Vercel cron から叩かれる同期エンドポイント。
 * 認証: Authorization: Bearer <CRON_SECRET>（Vercel cronが自動付与）か x-admin-key。
 */
import { syncTarget, targetKeys } from "../sync.mjs"

export default async function handler(req, res) {
  const auth = req.headers["authorization"] || ""
  const adminKey = req.headers["x-admin-key"] || ""
  const secret = process.env.CRON_SECRET || ""
  if (!secret || (auth !== `Bearer ${secret}` && adminKey !== secret)) {
    return res.status(401).json({ error: "unauthorized" })
  }
  const results = {}
  for (const key of targetKeys) {
    try {
      await syncTarget(key)
      results[key] = "ok"
    } catch (e) {
      results[key] = `error: ${e.message}`
    }
  }
  const failed = Object.values(results).some((v) => v !== "ok")
  res.status(failed ? 500 : 200).json(results)
}
