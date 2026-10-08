import express from "express";
import crypto from "crypto";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ============================ ENV ============================ */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "";
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADSGRAM_BLOCK_ID = String(process.env.ADSGRAM_BLOCK_ID || "52614");
const AD_COOLDOWN_SECONDS = Number(process.env.AD_COOLDOWN_SECONDS || 15);

const REQUIRED_CHANNELS = String(process.env.REQUIRED_CHANNELS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

/* ========================== DATABASE ========================== */

const pool = DATABASE_URL
    ? new Pool({
          connectionString: DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          max: 3, // serverless: keep connections low
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 10000
      })
    : null;

if (pool) {
    pool.on("error", e => console.error("pg pool error", e.message));
}

let schemaPromise = null;

async function ensureDatabase() {
    if (!pool) throw new Error("DATABASE_URL is not configured.");

    if (!schemaPromise) {
        schemaPromise = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_users (
                    telegram_id BIGINT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    photo_url TEXT,
                    ads_count INTEGER NOT NULL DEFAULT 0,
                    total_ads INTEGER NOT NULL DEFAULT 0,
                    invite_count INTEGER NOT NULL DEFAULT 0,
                    total_invites INTEGER NOT NULL DEFAULT 0,
                    points NUMERIC NOT NULL DEFAULT 0,
                    referral_code TEXT UNIQUE,
                    referred_by BIGINT,
                    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_referrals (
                    id BIGSERIAL PRIMARY KEY,
                    inviter_id BIGINT NOT NULL,
                    invited_id BIGINT NOT NULL UNIQUE,
                    reward NUMERIC NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_ad_rewards (
                    id BIGSERIAL PRIMARY KEY,
                    telegram_id BIGINT NOT NULL,
                    reward NUMERIC NOT NULL DEFAULT 0,
                    reward_key TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_rewards (
                    id BIGSERIAL PRIMARY KEY,
                    position INTEGER NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_admin_logs (
                    id BIGSERIAL PRIMARY KEY,
                    admin_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    details TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_withdrawals (
                    id BIGSERIAL PRIMARY KEY,
                    telegram_id BIGINT NOT NULL,
                    amount NUMERIC NOT NULL,
                    method TEXT NOT NULL,
                    address TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    admin_note TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    processed_at TIMESTAMPTZ
                );
            `);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS account_name TEXT;`);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_tasks (
                    id BIGSERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    url TEXT NOT NULL,
                    channel TEXT,
                    reward NUMERIC NOT NULL DEFAULT 0,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_task_claims (
                    id BIGSERIAL PRIMARY KEY,
                    task_id BIGINT NOT NULL,
                    telegram_id BIGINT NOT NULL,
                    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    UNIQUE(task_id, telegram_id)
                );
            `);
            await pool.query(`
                INSERT INTO mr_app_settings(key, value)
                VALUES ('ad_reward','1'),('invite_reward','1'),('max_ads_per_day','100'),('min_withdraw','100')
                ON CONFLICT(key) DO NOTHING;
            `);
            await pool.query(`
                INSERT INTO mr_rewards(position, title, description)
                VALUES
                    (1,'1st Place Reward','Top leaderboard reward'),
                    (2,'2nd Place Reward','Second leaderboard reward'),
                    (3,'3rd Place Reward','Third leaderboard reward')
                ON CONFLICT(position) DO NOTHING;
            `);
        })().catch(err => {
            schemaPromise = null; // FIX: allow retry after a failure
            throw err;
        });
    }
    return schemaPromise;
}

async function requireDatabase() {
    if (!pool) throw new Error("DATABASE_URL is not configured.");
    await ensureDatabase();
}

/* ============================ HEALTH ============================ */

app.get("/api/health", async (req, res) => {
    try {
        if (!pool) {
            return res.json({
                ok: true,
                database: false,
                adsgramBlock: ADSGRAM_BLOCK_ID,
                env: {
                    BOT_TOKEN: !!BOT_TOKEN,
                    ADMIN_ID: !!ADMIN_ID,
                    DATABASE_URL: false
                },
                error: "DATABASE_URL is not configured"
            });
        }
        await ensureDatabase();
        await pool.query("SELECT 1");
        res.json({
            ok: true,
            database: true,
            adsgramBlock: ADSGRAM_BLOCK_ID,
            env: {
                BOT_TOKEN: !!BOT_TOKEN,
                ADMIN_ID: !!ADMIN_ID,
                DATABASE_URL: true
            }
        });
    } catch (error) {
        res.status(500).json({ ok: false, database: false, error: error.message });
    }
});

/* ===================== TELEGRAM initData CHECK ===================== */

function validateTelegramInitData(initData) {
    if (!initData) throw new Error("Telegram initData is missing. Open the app from inside Telegram.");
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not configured.");

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");
    if (!receivedHash) throw new Error("Telegram hash is missing.");
    params.delete("hash");

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    const a = Buffer.from(calculatedHash, "utf8");
    const b = Buffer.from(receivedHash, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error("Invalid Telegram initData.");
    }

    const authDate = Number(params.get("auth_date"));
    if (!authDate) throw new Error("Telegram auth_date is missing.");
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age < -60 || age > 86400) throw new Error("Telegram initData expired.");

    const userRaw = params.get("user");
    if (!userRaw) throw new Error("Telegram user is missing.");

    let user;
    try {
        user = JSON.parse(userRaw);
    } catch {
        throw new Error("Telegram user data is invalid.");
    }
    if (!user.id) throw new Error("Telegram user ID is missing.");

    return { user, startParam: params.get("start_param") || "" };
}

function getInitData(req) {
    const h = req.headers["x-telegram-init-data"];
    if (h) return Array.isArray(h) ? h[0] : h;
    const auth = req.headers["authorization"];
    if (typeof auth === "string" && auth.toLowerCase().startsWith("tma ")) {
        return auth.slice(4);
    }
    return "";
}

function authenticate(req, res, next) {
    try {
        const result = validateTelegramInitData(getInitData(req));
        req.telegramUser = result.user;
        req.startParam = result.startParam;
        next();
    } catch (error) {
        res.status(401).json({ ok: false, error: error.message });
    }
}

/* ========================== TELEGRAM API ========================== */

async function telegram(method, body = {}) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not configured.");
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.description || "Telegram API error.");
    return data.result;
}

async function checkChannel(telegramId, channel) {
    try {
        const member = await telegram("getChatMember", {
            chat_id: channel,
            user_id: Number(telegramId)
        });
        return {
            channel,
            joined: ["creator", "administrator", "member"].includes(member.status),
            status: member.status
        };
    } catch (error) {
        return { channel, joined: false, status: "unknown", error: error.message };
    }
}

async function checkAllChannels(telegramId) {
    if (!REQUIRED_CHANNELS.length) return [];
    return Promise.all(REQUIRED_CHANNELS.map(c => checkChannel(telegramId, c)));
}

const allJoinedOf = channels => channels.length === 0 || channels.every(x => x.joined);

/* ============================== USER ============================== */

async function createOrUpdateUser(tgUser, referralCode) {
    const telegramId = String(tgUser.id);

    const existing = await pool.query(
        `SELECT telegram_id FROM mr_users WHERE telegram_id = $1`,
        [telegramId]
    );

    if (existing.rows.length) {
        await pool.query(
            `UPDATE mr_users SET username=$2, first_name=$3, last_name=$4, photo_url=$5, updated_at=NOW()
             WHERE telegram_id=$1`,
            [
                telegramId,
                tgUser.username || null,
                tgUser.first_name || null,
                tgUser.last_name || null,
                tgUser.photo_url || null
            ]
        );
        return;
    }

    let referredBy = null;
    if (referralCode) {
        const inviter = await pool.query(
            `SELECT telegram_id FROM mr_users WHERE referral_code = $1`,
            [referralCode]
        );
        if (inviter.rows.length) {
            const inviterId = String(inviter.rows[0].telegram_id);
            if (inviterId !== telegramId) referredBy = inviterId;
        }
    }

    await pool.query(
        `INSERT INTO mr_users(telegram_id, username, first_name, last_name, photo_url, referral_code, referred_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(telegram_id) DO NOTHING`,
        [
            telegramId,
            tgUser.username || null,
            tgUser.first_name || null,
            tgUser.last_name || null,
            tgUser.photo_url || null,
            crypto.randomBytes(8).toString("hex"),
            referredBy
        ]
    );
}

/* ============================ REFERRAL ============================ */

async function processReferral(userId) {
    const u = await pool.query(
        `SELECT referred_by FROM mr_users WHERE telegram_id = $1`,
        [userId]
    );
    if (!u.rows.length || !u.rows[0].referred_by) return;

    const referredBy = u.rows[0].referred_by;

    const setting = await pool.query(
        `SELECT value FROM mr_app_settings WHERE key = 'invite_reward'`
    );
    const reward = Number(setting.rows[0]?.value || 1);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // FIX: ON CONFLICT so a double request can't crash or double-pay
        const ins = await client.query(
            `INSERT INTO mr_referrals(inviter_id, invited_id, reward)
             VALUES($1,$2,$3)
             ON CONFLICT(invited_id) DO NOTHING
             RETURNING id`,
            [referredBy, userId, reward]
        );

        if (ins.rows.length) {
            await client.query(
                `UPDATE mr_users
                 SET invite_count = invite_count + 1,
                     total_invites = total_invites + 1,
                     points = points + $2,
                     updated_at = NOW()
                 WHERE telegram_id = $1`,
                [referredBy, reward]
            );
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

/* ============================== ME ============================== */

app.get("/api/me", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        let referral = null;
        if (typeof req.query.ref === "string") referral = req.query.ref.trim();
        if (!referral && req.startParam) {
            referral = req.startParam.startsWith("ref_")
                ? req.startParam.slice(4)
                : req.startParam;
        }

        const telegramId = String(req.telegramUser.id);

        await createOrUpdateUser(req.telegramUser, referral);

        try {
            await processReferral(telegramId);
        } catch (e) {
            console.error("processReferral", e.message); // never block login
        }

        const channels = await checkAllChannels(telegramId);
        const allJoined = allJoinedOf(channels);

        await pool.query(
            `UPDATE mr_users SET is_verified=$2, updated_at=NOW() WHERE telegram_id=$1`,
            [telegramId, allJoined]
        );

        const userResult = await pool.query(
            `SELECT * FROM mr_users WHERE telegram_id = $1`,
            [telegramId]
        );
        const user = userResult.rows[0];

        if (user.is_banned) {
            return res.status(403).json({ ok: false, error: "Your account is banned." });
        }

        const rankResult = await pool.query(
            `SELECT COUNT(*) + 1 AS rank FROM mr_users WHERE is_banned = FALSE AND points > $1`,
            [user.points]
        );

        const sRes = await pool.query(`SELECT key, value FROM mr_app_settings`);
        const settings = {};
        for (const r of sRes.rows) settings[r.key] = Number(r.value);

        const todayRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM mr_ad_rewards
             WHERE telegram_id = $1 AND created_at >= date_trunc('day', NOW())`,
            [telegramId]
        );

        let pendingWithdrawals = 0;
        if (telegramId === ADMIN_ID) {
            const pw = await pool.query(
                `SELECT COUNT(*)::int AS c FROM mr_withdrawals WHERE status = 'pending'`
            );
            pendingWithdrawals = pw.rows[0].c;
        }

        res.json({
            ok: true,
            settings,
            today_ads: todayRes.rows[0].c,
            pending_withdrawals: pendingWithdrawals,
            user: {
                telegram_id: user.telegram_id,
                username: user.username,
                first_name: user.first_name,
                last_name: user.last_name,
                photo_url: user.photo_url,
                ads_count: user.ads_count,
                total_ads: user.total_ads,
                invite_count: user.invite_count,
                total_invites: user.total_invites,
                points: Number(user.points),
                referral_code: user.referral_code,
                rank: Number(rankResult.rows[0].rank),
                is_verified: allJoined,
                is_admin: telegramId === ADMIN_ID
            },
            channels,
            allJoined,
            adsgram: { blockId: ADSGRAM_BLOCK_ID },
            bot: { username: BOT_USERNAME }
        });
    } catch (error) {
        console.error("/api/me", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================ CHANNELS ============================ */

app.get("/api/channels", authenticate, async (req, res) => {
    try {
        const channels = await checkAllChannels(String(req.telegramUser.id));
        res.json({ ok: true, channels, allJoined: allJoinedOf(channels) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* =========================== AD REWARD =========================== */

app.post("/api/ad-reward", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        const telegramId = String(req.telegramUser.id);

        const rewardKey =
            typeof req.body?.rewardKey === "string" ? req.body.rewardKey.trim() : "";

        if (!rewardKey || rewardKey.length > 120) {
            return res.status(400).json({ ok: false, error: "rewardKey is required." });
        }

        const me = await pool.query(
            `SELECT is_banned FROM mr_users WHERE telegram_id = $1`,
            [telegramId]
        );
        if (!me.rows.length) {
            return res.status(404).json({ ok: false, error: "User not found. Reopen the app." });
        }
        if (me.rows[0].is_banned) {
            return res.status(403).json({ ok: false, error: "Your account is banned." });
        }

        const channels = await checkAllChannels(telegramId);
        if (!allJoinedOf(channels)) {
            return res.status(403).json({ ok: false, error: "Join all required channels first." });
        }

        // cooldown: stops people spamming the endpoint with fake keys
        const last = await pool.query(
            `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) AS secs
             FROM mr_ad_rewards WHERE telegram_id = $1`,
            [telegramId]
        );
        const secs = last.rows[0].secs;
        if (secs !== null && Number(secs) < AD_COOLDOWN_SECONDS) {
            return res.status(429).json({ ok: false, error: "Too fast. Please wait a moment." });
        }

        const limitResult = await pool.query(
            `SELECT value FROM mr_app_settings WHERE key = 'max_ads_per_day'`
        );
        const maxAds = Number(limitResult.rows[0]?.value || 100);

        const todayResult = await pool.query(
            `SELECT COUNT(*)::int AS count FROM mr_ad_rewards
             WHERE telegram_id = $1 AND created_at >= date_trunc('day', NOW())`,
            [telegramId]
        );
        if (Number(todayResult.rows[0].count) >= maxAds) {
            return res.status(429).json({ ok: false, error: "Daily ad limit reached." });
        }

        const rewardResult = await pool.query(
            `SELECT value FROM mr_app_settings WHERE key = 'ad_reward'`
        );
        const reward = Number(rewardResult.rows[0]?.value || 1);
        if (!Number.isFinite(reward) || reward < 0) {
            throw new Error("Invalid ad reward configuration.");
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            await client.query(
                `INSERT INTO mr_ad_rewards(telegram_id, reward, reward_key) VALUES($1,$2,$3)`,
                [telegramId, reward, `${telegramId}:${rewardKey}`]
            );

            await client.query(
                `UPDATE mr_users
                 SET ads_count = ads_count + 1,
                     total_ads = total_ads + 1,
                     points = points + $2,
                     updated_at = NOW()
                 WHERE telegram_id = $1`,
                [telegramId, reward]
            );

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") {
                return res.status(409).json({ ok: false, error: "This reward was already claimed." });
            }
            throw error;
        } finally {
            client.release();
        }

        const updated = await pool.query(
            `SELECT points, ads_count, total_ads FROM mr_users WHERE telegram_id = $1`,
            [telegramId]
        );

        res.json({
            ok: true,
            reward,
            user: { ...updated.rows[0], points: Number(updated.rows[0].points) }
        });
    } catch (error) {
        console.error("/api/ad-reward", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* =========================== LEADERBOARD =========================== */

app.get("/api/leaderboard", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        const result = await pool.query(`
            SELECT telegram_id, username, first_name, last_name, photo_url,
                   points, total_ads, total_invites
            FROM mr_users
            WHERE is_banned = FALSE
            ORDER BY points DESC, total_ads DESC, total_invites DESC, created_at ASC
            LIMIT 30
        `);

        res.json({
            ok: true,
            leaderboard: result.rows.map((u, i) => ({
                rank: i + 1,
                telegram_id: u.telegram_id,
                username: u.username,
                first_name: u.first_name,
                last_name: u.last_name,
                photo_url: u.photo_url,
                points: Number(u.points),
                ads: u.total_ads,
                invites: u.total_invites
            }))
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================= REWARDS ============================= */

app.get("/api/rewards", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const result = await pool.query(`
            SELECT position, title, description, enabled
            FROM mr_rewards WHERE enabled = TRUE ORDER BY position ASC
        `);
        res.json({ ok: true, rewards: result.rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================== ADMIN ============================== */

function requireAdmin(req, res, next) {
    if (!ADMIN_ID || String(req.telegramUser.id) !== ADMIN_ID) {
        return res.status(403).json({ ok: false, error: "Admin access required." });
    }
    next();
}

app.post("/api/admin/settings", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();

        const { ad_reward, invite_reward, max_ads_per_day, min_withdraw } = req.body || {};
        const settings = { ad_reward, invite_reward, max_ads_per_day, min_withdraw };

        for (const [key, value] of Object.entries(settings)) {
            if (value === undefined || value === null) continue;
            if (!Number.isFinite(Number(value)) || Number(value) < 0) {
                return res.status(400).json({ ok: false, error: `${key} must be a number >= 0.` });
            }
            await pool.query(
                `INSERT INTO mr_app_settings(key, value, updated_at) VALUES($1,$2,NOW())
                 ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, String(value)]
            );
        }

        await pool.query(
            `INSERT INTO mr_admin_logs(admin_id, action, details) VALUES($1,$2,$3)`,
            [ADMIN_ID, "update_settings", JSON.stringify(settings)]
        );

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/reward", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();

        const { position, title, description, enabled } = req.body || {};
        const pos = Number(position);

        if (!Number.isInteger(pos) || pos < 1 || pos > 30) {
            return res.status(400).json({ ok: false, error: "Position must be between 1 and 30." });
        }
        if (typeof title !== "string" || !title.trim()) {
            return res.status(400).json({ ok: false, error: "Reward title is required." });
        }

        await pool.query(
            `INSERT INTO mr_rewards(position, title, description, enabled, updated_at)
             VALUES($1,$2,$3,$4,NOW())
             ON CONFLICT(position) DO UPDATE SET
                title = EXCLUDED.title,
                description = EXCLUDED.description,
                enabled = EXCLUDED.enabled,
                updated_at = NOW()`,
            [pos, title.trim(), String(description || ""), enabled !== false]
        );

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================ WITHDRAW ============================ */

const WITHDRAW_METHODS = ["CBE", "Telebirr", "M-Pesa"];

async function notifyUser(telegramId, text) {
    try {
        await telegram("sendMessage", { chat_id: Number(telegramId), text });
    } catch (e) {
        console.error("notifyUser", e.message); // user may not have started the bot
    }
}

app.post("/api/withdraw", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        const telegramId = String(req.telegramUser.id);
        const amount = Number(req.body?.amount);
        const method = String(req.body?.method || "").trim();
        const address = String(req.body?.address || "").trim();
        const accountName = String(req.body?.accountName || "").trim();

        if (!WITHDRAW_METHODS.includes(method)) {
            return res.status(400).json({ ok: false, error: "Choose a valid payout method." });
        }
        if (accountName.length < 2 || accountName.length > 100) {
            return res.status(400).json({ ok: false, error: "Enter the account owner name." });
        }
        if (address.length < 3 || address.length > 200) {
            return res.status(400).json({ ok: false, error: "Enter a valid account number." });
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ ok: false, error: "Enter a valid amount." });
        }

        const minRes = await pool.query(
            `SELECT value FROM mr_app_settings WHERE key = 'min_withdraw'`
        );
        const minWithdraw = Number(minRes.rows[0]?.value || 100);
        if (amount < minWithdraw) {
            return res.status(400).json({ ok: false, error: `Minimum withdrawal is ${minWithdraw}.` });
        }
        if (!allJoinedOf(await checkAllChannels(telegramId))) {
            return res.status(403).json({ ok: false, error: "Join all required channels first." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            const u = await client.query(
                `SELECT points, is_banned FROM mr_users WHERE telegram_id = $1 FOR UPDATE`,
                [telegramId]
            );
            if (!u.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ ok: false, error: "User not found." });
            }
            if (u.rows[0].is_banned) {
                await client.query("ROLLBACK");
                return res.status(403).json({ ok: false, error: "Your account is banned." });
            }
            if (Number(u.rows[0].points) < amount) {
                await client.query("ROLLBACK");
                return res.status(400).json({ ok: false, error: "Not enough points." });
            }

            const pending = await client.query(
                `SELECT 1 FROM mr_withdrawals WHERE telegram_id = $1 AND status = 'pending' LIMIT 1`,
                [telegramId]
            );
            if (pending.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "You already have a pending request." });
            }

            await client.query(
                `UPDATE mr_users SET points = points - $2, updated_at = NOW() WHERE telegram_id = $1`,
                [telegramId, amount]
            );
            await client.query(
                `INSERT INTO mr_withdrawals(telegram_id, amount, method, address, account_name) VALUES($1,$2,$3,$4,$5)`,
                [telegramId, amount, method, address, accountName]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }

        const after = await pool.query(
            `SELECT points FROM mr_users WHERE telegram_id = $1`,
            [telegramId]
        );
        res.json({ ok: true, points: Number(after.rows[0].points) });
    } catch (error) {
        console.error("/api/withdraw", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/withdrawals", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT id, amount, method, address, account_name, status, admin_note, created_at, processed_at
             FROM mr_withdrawals WHERE telegram_id = $1 ORDER BY id DESC LIMIT 30`,
            [String(req.telegramUser.id)]
        );
        res.json({
            ok: true,
            withdrawals: r.rows.map(w => ({ ...w, amount: Number(w.amount) }))
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/withdrawals", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const status = String(req.query.status || "pending");
        const params = [];
        let where = "";
        if (["pending", "approved", "rejected"].includes(status)) {
            where = "WHERE w.status = $1";
            params.push(status);
        }
        const r = await pool.query(
            `SELECT w.id, w.telegram_id, w.amount, w.method, w.address, w.account_name, w.status,
                    w.admin_note, w.created_at, w.processed_at,
                    u.username, u.first_name, u.last_name
             FROM mr_withdrawals w
             LEFT JOIN mr_users u ON u.telegram_id = w.telegram_id
             ${where}
             ORDER BY w.id DESC LIMIT 100`,
            params
        );
        res.json({
            ok: true,
            withdrawals: r.rows.map(w => ({ ...w, amount: Number(w.amount) }))
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/withdrawals/:id", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();

        const id = String(req.params.id);
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ ok: false, error: "Invalid id." });
        }
        const action = String(req.body?.action || "");
        if (!["approve", "reject"].includes(action)) {
            return res.status(400).json({ ok: false, error: "Action must be approve or reject." });
        }
        const note = String(req.body?.note || "").slice(0, 300);

        const client = await pool.connect();
        let w;
        try {
            await client.query("BEGIN");

            const found = await client.query(
                `SELECT * FROM mr_withdrawals WHERE id = $1 FOR UPDATE`,
                [id]
            );
            if (!found.rows.length) {
                await client.query("ROLLBACK");
                return res.status(404).json({ ok: false, error: "Request not found." });
            }
            w = found.rows[0];
            if (w.status !== "pending") {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "Already processed." });
            }

            const newStatus = action === "approve" ? "approved" : "rejected";

            await client.query(
                `UPDATE mr_withdrawals SET status = $2, admin_note = $3, processed_at = NOW() WHERE id = $1`,
                [id, newStatus, note || null]
            );

            if (action === "reject") {
                // give the held points back
                await client.query(
                    `UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`,
                    [w.telegram_id, w.amount]
                );
            }

            await client.query(
                `INSERT INTO mr_admin_logs(admin_id, action, details) VALUES($1,$2,$3)`,
                [ADMIN_ID, `withdraw_${newStatus}`, JSON.stringify({ id, amount: w.amount, user: w.telegram_id })]
            );

            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }

        const amt = Number(w.amount);
        if (action === "approve") {
            await notifyUser(w.telegram_id, `Your withdrawal of ${amt} has been approved.`);
        } else {
            await notifyUser(
                w.telegram_id,
                `Your withdrawal of ${amt} was rejected and the points were returned.` + (note ? `\nReason: ${note}` : "")
            );
        }

        res.json({ ok: true });
    } catch (error) {
        console.error("/api/admin/withdrawals", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================== TASKS ============================== */

const isId = v => /^\d+$/.test(String(v));

app.get("/api/tasks", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT t.id, t.title, t.description, t.url, t.channel, t.reward,
                    (c.completed_at IS NOT NULL) AS completed,
                    (c.started_at IS NOT NULL) AS started
             FROM mr_tasks t
             LEFT JOIN mr_task_claims c ON c.task_id = t.id AND c.telegram_id = $1
             WHERE t.enabled = TRUE
             ORDER BY t.id DESC`,
            [String(req.telegramUser.id)]
        );
        res.json({ ok: true, tasks: r.rows.map(t => ({ ...t, reward: Number(t.reward) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/tasks/:id/start", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid id." });
        const telegramId = String(req.telegramUser.id);

        if (!allJoinedOf(await checkAllChannels(telegramId))) {
            return res.status(403).json({ ok: false, error: "Join all required channels first." });
        }
        const t = await pool.query(`SELECT id FROM mr_tasks WHERE id = $1 AND enabled = TRUE`, [req.params.id]);
        if (!t.rows.length) return res.status(404).json({ ok: false, error: "Task not found." });

        await pool.query(
            `INSERT INTO mr_task_claims(task_id, telegram_id) VALUES($1,$2)
             ON CONFLICT(task_id, telegram_id) DO NOTHING`,
            [req.params.id, telegramId]
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/tasks/:id/claim", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid id." });
        const telegramId = String(req.telegramUser.id);

        if (!allJoinedOf(await checkAllChannels(telegramId))) {
            return res.status(403).json({ ok: false, error: "Join all required channels first." });
        }

        const me = await pool.query(`SELECT is_banned FROM mr_users WHERE telegram_id = $1`, [telegramId]);
        if (!me.rows.length || me.rows[0].is_banned) {
            return res.status(403).json({ ok: false, error: "Account not allowed." });
        }

        const tr = await pool.query(`SELECT * FROM mr_tasks WHERE id = $1 AND enabled = TRUE`, [req.params.id]);
        if (!tr.rows.length) return res.status(404).json({ ok: false, error: "Task not found." });
        const task = tr.rows[0];

        const cr = await pool.query(
            `SELECT completed_at, EXTRACT(EPOCH FROM (NOW() - started_at)) AS secs
             FROM mr_task_claims WHERE task_id = $1 AND telegram_id = $2`,
            [task.id, telegramId]
        );
        if (!cr.rows.length) return res.status(400).json({ ok: false, error: "Start the task first." });
        if (cr.rows[0].completed_at) return res.status(409).json({ ok: false, error: "Task already completed." });

        if (task.channel) {
            const chk = await checkChannel(telegramId, task.channel);
            if (!chk.joined) return res.status(400).json({ ok: false, error: "Join the channel first, then claim." });
        } else if (Number(cr.rows[0].secs) < 8) {
            return res.status(400).json({ ok: false, error: "Please complete the task first." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const upd = await client.query(
                `UPDATE mr_task_claims SET completed_at = NOW()
                 WHERE task_id = $1 AND telegram_id = $2 AND completed_at IS NULL RETURNING id`,
                [task.id, telegramId]
            );
            if (!upd.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "Task already completed." });
            }
            await client.query(
                `UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`,
                [telegramId, task.reward]
            );
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }

        res.json({ ok: true, reward: Number(task.reward) });
    } catch (error) {
        console.error("/api/tasks/claim", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/tasks", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT t.id, t.title, t.description, t.url, t.channel, t.reward, t.enabled,
                    (SELECT COUNT(*)::int FROM mr_task_claims c WHERE c.task_id = t.id AND c.completed_at IS NOT NULL) AS completions
             FROM mr_tasks t ORDER BY t.id DESC LIMIT 100`
        );
        res.json({ ok: true, tasks: r.rows.map(t => ({ ...t, reward: Number(t.reward) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/tasks", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const title = String(req.body?.title || "").trim();
        const description = String(req.body?.description || "").trim().slice(0, 200);
        const url = String(req.body?.url || "").trim();
        const channel = String(req.body?.channel || "").trim();
        const reward = Number(req.body?.reward);

        if (!title || title.length > 80) {
            return res.status(400).json({ ok: false, error: "Title is required (max 80 characters)." });
        }
        if (!/^https?:\/\/\S+$/i.test(url)) {
            return res.status(400).json({ ok: false, error: "Link must start with http:// or https://" });
        }
        if (channel && !/^(@[A-Za-z0-9_]{4,}|-100\d+)$/.test(channel)) {
            return res.status(400).json({ ok: false, error: "Channel must look like @channelname." });
        }
        if (!Number.isFinite(reward) || reward <= 0 || reward > 100000) {
            return res.status(400).json({ ok: false, error: "Reward must be greater than 0." });
        }

        await pool.query(
            `INSERT INTO mr_tasks(title, description, url, channel, reward) VALUES($1,$2,$3,$4,$5)`,
            [title, description, url, channel || null, reward]
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/tasks/:id/delete", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid id." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DELETE FROM mr_task_claims WHERE task_id = $1`, [req.params.id]);
            await client.query(`DELETE FROM mr_tasks WHERE id = $1`, [req.params.id]);
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================= FRONTEND ============================= */

// Unknown API routes -> JSON 404 (must come BEFORE the HTML fallback)
app.use("/api", (req, res) => {
    res.status(404).json({ ok: false, error: "API route not found." });
});

const BLOCKED_FILES = new Set(["/server.js", "/package.json", "/package-lock.json", "/vercel.json"]);
const staticFiles = express.static(__dirname, { index: false, dotfiles: "deny" });
app.use((req, res, next) => {
    if (BLOCKED_FILES.has(req.path.toLowerCase())) return res.status(404).end();
    staticFiles(req, res, next);
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.use((req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

/* ======================= LOCAL RUN + VERCEL ======================= */

if (!process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
}

export default app;
