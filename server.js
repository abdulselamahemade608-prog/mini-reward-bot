
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;

function verifyTelegram(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) return null;

  // Reject expired authentication data (24 hours)
  if (Date.now() / 1000 - authDate > 86400) return null;

  const entries = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b));

  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(calculatedHash, "hex");
  const b = Buffer.from(hash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "https://example.com");
  const path = url.pathname;

  // Only allow the necessary HTTP methods
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  try {
    // Trusted advertisement provider webhook
    if (path === "/api/ad-complete" && req.method === "POST") {
      if (
        !process.env.AD_WEBHOOK_SECRET ||
        req.headers["x-ad-secret"] !== process.env.AD_WEBHOOK_SECRET
      ) {
        return send(res, 401, { error: "Unauthorized" });
      }

      const { event_id, telegram_id } = req.body || {};

      if (!event_id || !telegram_id) {
        return send(res, 400, { error: "Missing event information" });
      }

      const { error } = await supabase.rpc("record_ad_view", {
        p_event_id: String(event_id),
        p_telegram_id: String(telegram_id)
      });

      if (error) throw error;

      return send(res, 200, { success: true });
    }

    // Authenticate Telegram Mini App
    const auth = req.headers.authorization || "";
    const initData = auth.startsWith("tma ")
      ? auth.slice(4)
      : "";

    const telegramUser = verifyTelegram(initData);

    if (!telegramUser) {
      return send(res, 401, {
        error: "Invalid or expired Telegram authentication"
      });
    }

    const telegramId = String(telegramUser.id);

    // Register user and process referral
    if (path === "/api/me" && req.method === "POST") {
      const { startParam } = req.body || {};

      let referrerId = null;

      if (typeof startParam === "string") {
        const match = startParam.match(/^ref_(\d+)$/);
        if (match && match[1] !== telegramId) {
          referrerId = match[1];
        }
      }

      const { data, error } = await supabase.rpc(
        "register_giveaway_user",
        {
          p_telegram_id: telegramId,
          p_first_name: telegramUser.first_name || "User",
          p_username: telegramUser.username || null,
          p_referrer_id: referrerId
        }
      );

      if (error) throw error;

      return send(res, 200, {
        user: data,
        botUsername: BOT_USERNAME
      });
    }

    // Weekly leaderboard
    if (path === "/api/leaderboard" && req.method === "GET") {
      const type = url.searchParams.get("type");

      if (!["ads", "invites"].includes(type)) {
        return send(res, 400, { error: "Invalid leaderboard type" });
      }

      const orderColumn =
        type === "ads" ? "weekly_ads" : "weekly_invites";

      const { data, error } = await supabase
        .from("giveaway_users")
        .select("telegram_id, first_name, weekly_ads, weekly_invites")
        .order(orderColumn, { ascending: false })
        .order("telegram_id", { ascending: true })
        .limit(50);

      if (error) throw error;

      return send(res, 200, { users: data || [] });
    }

    return send(res, 404, { error: "Route not found" });

  } catch (error) {
    console.error("API error:", error.message);
    return send(res, 500, { error: "Server error" });
  }
};
