import express from "express";
import crypto from "crypto";
import pg from "pg";
import path from "path";
import { ethers } from "ethers";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ============================ ENV ============================ */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = String(process.env.BOT_USERNAME || "").replace(/^@/, "");
const APP_URL = String(process.env.APP_URL || "https://mini-reward-bot.vercel.app").replace(/\/+$/, "");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const PROOF_CHANNEL = String(process.env.PROOF_CHANNEL || "").trim();
const PROOF_MASK = String(process.env.PROOF_MASK || "true").toLowerCase() !== "false";
const PROOF_HANDLE = String(process.env.PROOF_HANDLE || "@abdu_monye2").trim();

const ADSGRAM_SECRET = String(process.env.ADSGRAM_SECRET || "");
const STRICT_ADS = ADSGRAM_SECRET.length > 0;
const MONETAG_ZONE_ID = String(process.env.MONETAG_ZONE_ID || "11984693").trim();
const MONETAG_SECRET = String(process.env.MONETAG_SECRET || "");
const STRICT_MONETAG = MONETAG_SECRET.length > 0;

const APP_BUTTON_TEXT = process.env.APP_BUTTON_TEXT || "Adewa Eran";
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADSGRAM_BLOCK_ID = String(process.env.ADSGRAM_BLOCK_ID || "52630");
const ADSGRAM_TASK_BLOCK_ID = String(process.env.ADSGRAM_TASK_BLOCK_ID || "").trim();
const ADSGRAM_INTERSTITIAL_BLOCK_ID = String(process.env.ADSGRAM_INTERSTITIAL_BLOCK_ID || "").trim();
const AD_COOLDOWN_SECONDS = Number(process.env.AD_COOLDOWN_SECONDS || 15);

/* ---- BNB / USDT BEP20 auto payment ---- */
const BSC_RPC_URL = String(process.env.BSC_RPC_URL || "").trim();
const PAYOUT_PRIVATE_KEY = String(process.env.PAYOUT_PRIVATE_KEY || "").trim();
const BSC_CHAIN_ID = Number(process.env.BSC_CHAIN_ID || 56);
const TOKEN_DECIMALS = 18;
const TOKEN_SYMBOL = "USDT";
const USDT_CONTRACT = String(process.env.USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955").trim();
const ERC20_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];
const EXPLORER_TX = String(process.env.EXPLORER_TX_URL || "https://bscscan.com/tx/");
const PAY_READY = !!(BSC_RPC_URL && PAYOUT_PRIVATE_KEY);

const REQUIRED_CHANNELS = String(process.env.REQUIRED_CHANNELS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

const isId = v => /^\d+$/.test(String(v));

const WITHDRAW_TZ = String(process.env.WITHDRAW_TZ || "Africa/Addis_Ababa");
const WITHDRAW_TZ_LABEL = String(process.env.WITHDRAW_TZ_LABEL || "EAT");
const DAY_TZ = /^[A-Za-z_\/+-]+$/.test(WITHDRAW_TZ) ? WITHDRAW_TZ : "Africa/Addis_Ababa";

function fmtServerDate(ms) {
    try {
        return new Date(ms).toLocaleString("en-GB", {
            timeZone: WITHDRAW_TZ, day: "numeric", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false
        }) + " " + WITHDRAW_TZ_LABEL;
    } catch (e) {
        return new Date(ms).toISOString();
    }
}
function fmtServerDay(ms) {
    try {
        return new Date(ms).toLocaleDateString("en-GB", { timeZone: WITHDRAW_TZ, day: "numeric", month: "short", year: "numeric" });
    } catch (e) {
        return new Date(ms).toISOString().slice(0, 10);
    }
}
function fmtWait(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
    const parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (mi && !d) parts.push(mi + "m");
    return parts.join(" ") || "1m";
}

/* ========================== DATABASE ========================== */

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 4,
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
                    task_boost_percent NUMERIC NOT NULL DEFAULT 0,
                    last_mined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    referral_code TEXT UNIQUE,
                    referred_by BIGINT,
                    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    is_banned BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`ALTER TABLE mr_users ADD COLUMN IF NOT EXISTS task_boost_percent NUMERIC NOT NULL DEFAULT 0;`);
            await pool.query(`ALTER TABLE mr_users ADD COLUMN IF NOT EXISTS last_mined_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);

            await pool.query(`
                CREATE TABLE IF NOT EXISTS fraud_users (
                    telegram_id BIGINT PRIMARY KEY,
                    username TEXT NOT NULL DEFAULT '',
                    first_name TEXT NOT NULL DEFAULT '',
                    ip_hash TEXT NOT NULL DEFAULT '',
                    device_hash TEXT NOT NULL DEFAULT '',
                    vpn_detected BOOLEAN NOT NULL DEFAULT FALSE,
                    proxy_detected BOOLEAN NOT NULL DEFAULT FALSE,
                    risk_score INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending',
                    ban_reason TEXT NOT NULL DEFAULT '',
                    verification_message_sent BOOLEAN NOT NULL DEFAULT FALSE,
                    ban_message_sent BOOLEAN NOT NULL DEFAULT FALSE,
                    admin_exempt BOOLEAN NOT NULL DEFAULT FALSE,
                    checked_at TIMESTAMPTZ,
                    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    request_count INTEGER NOT NULL DEFAULT 0
                );
            `);
            await pool.query(`ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS admin_exempt BOOLEAN NOT NULL DEFAULT FALSE`);
            await pool.query(`ALTER TABLE fraud_users ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ`);
            await pool.query(`CREATE INDEX IF NOT EXISTS fraud_users_device_idx ON fraud_users(device_hash)`);
            await pool.query(`CREATE INDEX IF NOT EXISTS fraud_users_ip_idx ON fraud_users(ip_hash)`);
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
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS fee NUMERIC NOT NULL DEFAULT 0;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS final_amount NUMERIC;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS tx_hash TEXT;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS token_amount NUMERIC;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS admin_msg_id BIGINT;`);
            await pool.query(`ALTER TABLE mr_withdrawals ADD COLUMN IF NOT EXISTS usd_amount NUMERIC;`);
            await pool.query(`ALTER TABLE mr_referrals ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT TRUE;`);
            await pool.query(`ALTER TABLE mr_referrals ALTER COLUMN verified SET DEFAULT FALSE;`);
            await pool.query(`ALTER TABLE mr_referrals ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`);
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
                CREATE TABLE IF NOT EXISTS mr_ad_credits (
                    id BIGSERIAL PRIMARY KEY,
                    telegram_id BIGINT NOT NULL,
                    used BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`ALTER TABLE mr_ad_credits ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'adsgram';`);
            await pool.query(`CREATE INDEX IF NOT EXISTS mr_ad_credits_user ON mr_ad_credits(telegram_id, used);`);
            await pool.query(`ALTER TABLE mr_users ADD COLUMN IF NOT EXISTS last_broadcast BIGINT NOT NULL DEFAULT 0;`);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_broadcasts (
                    id BIGSERIAL PRIMARY KEY,
                    text TEXT NOT NULL,
                    admin_id TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_promo_codes (
                    code TEXT PRIMARY KEY,
                    reward NUMERIC NOT NULL,
                    max_uses INTEGER NOT NULL,
                    used_count INTEGER NOT NULL DEFAULT 0,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_promo_redemptions (
                    id BIGSERIAL PRIMARY KEY,
                    code TEXT NOT NULL,
                    telegram_id BIGINT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(code, telegram_id)
                );
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS mr_milestone_claims (
                    id BIGSERIAL PRIMARY KEY,
                    telegram_id BIGINT NOT NULL,
                    milestone INTEGER NOT NULL,
                    reward NUMERIC NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(telegram_id, milestone)
                );
            `);
            await pool.query(`ALTER TABLE mr_users ADD COLUMN IF NOT EXISTS last_active TIMESTAMPTZ`);
            await pool.query(`ALTER TABLE mr_users ADD COLUMN IF NOT EXISTS last_remind_day TEXT`);
            await pool.query(`ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 0`);
            await pool.query(`ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS sponsored BOOLEAN NOT NULL DEFAULT FALSE`);
            await pool.query(`ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS sponsor_owner BIGINT`);
            await pool.query(`ALTER TABLE mr_task_claims ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ`);
            await pool.query(`ALTER TABLE mr_task_claims ADD COLUMN IF NOT EXISTS penalty NUMERIC NOT NULL DEFAULT 0`);
            await pool.query(`ALTER TABLE mr_task_claims ADD COLUMN IF NOT EXISTS last_check TIMESTAMPTZ`);
            await pool.query(`ALTER TABLE mr_task_claims ADD COLUMN IF NOT EXISTS was_member BOOLEAN NOT NULL DEFAULT FALSE`);
            await pool.query(`ALTER TABLE mr_tasks ADD COLUMN IF NOT EXISTS announce_pending BOOLEAN NOT NULL DEFAULT FALSE`);
            await pool.query(`CREATE TABLE IF NOT EXISTS mr_partner_tasks (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, provider TEXT NOT NULL DEFAULT 'adsgram', reward NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await pool.query(`CREATE INDEX IF NOT EXISTS mr_partner_tasks_user ON mr_partner_tasks(telegram_id, created_at)`);
            await pool.query(`ALTER TABLE mr_partner_tasks ADD COLUMN IF NOT EXISTS task_key TEXT`);
            await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS mr_partner_tasks_once ON mr_partner_tasks(telegram_id, task_key) WHERE task_key IS NOT NULL`);
            await pool.query(`CREATE TABLE IF NOT EXISTS mr_task_msgs (task_id BIGINT NOT NULL, chat_id BIGINT NOT NULL, message_id BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (task_id, chat_id))`);
            await pool.query(`CREATE TABLE IF NOT EXISTS mr_spins (id BIGSERIAL PRIMARY KEY, telegram_id BIGINT NOT NULL, prize NUMERIC NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await pool.query(`CREATE INDEX IF NOT EXISTS mr_spins_user ON mr_spins(telegram_id, created_at)`);

            // Seed default settings for the mining system ($0.1 per day, 10% for 50 ads, 1% per invite)
            await pool.query(`
                INSERT INTO mr_app_settings(key, value)
                VALUES ('mining_daily_usd','0.10'),
                       ('ad_50_mining_percent','10'),
                       ('invite_mining_percent','1'),
                       ('max_ads_per_day','100'),
                       ('min_withdraw','0.10'),
                       ('verify_ads','1'),
                       ('daily_withdraw_limit','0'),
                       ('milestone_5','0.05'),
                       ('milestone_10','0.15'),
                       ('milestone_25','0.50'),
                       ('withdraw_fee_percent','25'),
                       ('auto_ad_seconds','0'),
                       ('withdraw_hourly_limit','0'),
                       ('daily_bot_budget','0'),
                       ('withdraw_cooldown_hours','0'),
                       ('withdraw_closed_until','0'),
                       ('spin_enabled','1'),
                       ('spin_max_extra','3'),
                       ('spin_scale','1'),
                       ('remind_enabled','1'),
                       ('adsgram_task_reward','2'),
                       ('adsgram_task_daily','10'),
                       ('partner_required','1')
                ON CONFLICT(key) DO NOTHING;
            `);
        })().catch(err => {
            schemaPromise = null;
            throw err;
        });
    }
    return schemaPromise;
}

async function requireDatabase() {
    if (!pool) throw new Error("DATABASE_URL is not configured.");
    await ensureDatabase();
}

/* ===================== MINING SYSTEM ENGINE ===================== */

async function settingsMap() {
    const r = await pool.query(`SELECT key, value FROM mr_app_settings`);
    const s = {};
    for (const x of r.rows) s[x.key] = Number(x.value);
    return s;
}

// Computes mining rates and boosts based on tasks, 50-ads tiers, and referrals
function calculateMiningRates(user, settings) {
    const baseDaily = Number(settings.mining_daily_usd ?? 0.10);
    const ad50BoostPct = Number(settings.ad_50_mining_percent ?? 10);
    const invBoostPct = Number(settings.invite_mining_percent ?? 1);

    // Requirement: watching 50 ads increases mining rate by 10%
    const totalAds = Number(user.total_ads || 0);
    const adBoost = Math.floor(totalAds / 50) * ad50BoostPct;

    // Requirement: inviting one person increases mining rate by 1%
    const totalInvites = Number(user.total_invites || 0);
    const invBoost = totalInvites * invBoostPct;

    // Completing tasks increases the mining percentage
    const taskBoost = Number(user.task_boost_percent || 0);

    const totalBoostPercent = adBoost + invBoost + taskBoost;
    const effectiveDailyUsd = baseDaily * (1 + totalBoostPercent / 100);
    const effectiveHourlyUsd = effectiveDailyUsd / 24;
    const perSecondUsd = effectiveDailyUsd / 86400;

    return {
        baseDaily,
        totalBoostPercent,
        effectiveDailyUsd,
        effectiveHourlyUsd,
        perSecondUsd,
        adBoost,
        invBoost,
        taskBoost
    };
}

// Accrues mined USD into the user's balance based on elapsed seconds since last_mined_at
async function accrueMining(db, telegramId) {
    const st = await settingsMap();
    const u = await db.query(
        `SELECT points, total_ads, total_invites, task_boost_percent, last_mined_at
         FROM mr_users WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId]
    );
    if (!u.rows.length) return null;
    const row = u.rows[0];

    const rates = calculateMiningRates(row, st);
    const lastMinedAt = row.last_mined_at ? new Date(row.last_mined_at).getTime() : Date.now();
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - lastMinedAt) / 1000);

    const minedAmount = elapsedSeconds * rates.perSecondUsd;
    if (minedAmount > 0) {
        await db.query(
            `UPDATE mr_users
             SET points = points + $2,
                 last_mined_at = NOW(),
                 updated_at = NOW()
             WHERE telegram_id = $1`,
            [telegramId, minedAmount]
        );
    }

    return {
        ...rates,
        minedAmount,
        points: Number(row.points) + minedAmount
    };
}

/* ===================== PAYOUT LIMITS ===================== */

const DAY_START = `date_trunc('day', NOW() AT TIME ZONE '${DAY_TZ}') AT TIME ZONE '${DAY_TZ}'`;

async function getPayoutLimits(db, st) {
    const hourlyLimit = Number(st.withdraw_hourly_limit) || 0;
    const budgetLimit = Number(st.daily_bot_budget) || 0;
    const r = await db.query(
        `SELECT
            (SELECT COUNT(*)::int FROM mr_withdrawals
              WHERE status <> 'rejected' AND created_at >= NOW() - INTERVAL '1 hour') AS h,
            (SELECT COALESCE(SUM(amount),0) FROM mr_withdrawals
              WHERE status <> 'rejected' AND created_at >= ${DAY_START}) AS d`
    );
    const hourlyUsed = Number(r.rows[0].h);
    const budgetUsed = Number(r.rows[0].d);
    return {
        hourly: { limit: hourlyLimit, used: hourlyUsed, full: hourlyLimit > 0 && hourlyUsed >= hourlyLimit },
        budget: {
            limit: budgetLimit,
            used: budgetUsed,
            left: Math.max(0, budgetLimit - budgetUsed),
            full: budgetLimit > 0 && budgetUsed >= budgetLimit
        }
    };
}

async function nextWithdrawAt(db, telegramId) {
    const r = await db.query(
        `SELECT MAX(created_at) AS t, ${DAY_START} AS d0
         FROM mr_withdrawals WHERE telegram_id = $1 AND status <> 'rejected'`,
        [telegramId]
    );
    if (!r.rows[0] || !r.rows[0].t) return 0;
    const last = new Date(r.rows[0].t).getTime();
    const dayStart = new Date(r.rows[0].d0).getTime();
    if (last >= dayStart) return dayStart + 24 * 3600 * 1000;
    return 0;
}

function partnerNeeded(st) {
    if (!ADSGRAM_TASK_BLOCK_ID) return 0;
    let need = Math.max(0, Math.floor(st.partner_required ?? 1));
    const daily = Math.floor(st.adsgram_task_daily ?? 10);
    if (daily > 0) need = Math.min(need, daily);
    return need;
}

async function getWithdrawRequirements(db, telegramId, maxAds, partnerNeed = 0) {
    const max = Number.isFinite(Number(maxAds)) ? Number(maxAds) : 100;
    const r = await db.query(
        `SELECT
            (SELECT COUNT(*)::int FROM mr_ad_rewards
              WHERE telegram_id = $1 AND created_at >= ${DAY_START}) AS ads,
            (SELECT COUNT(*)::int FROM mr_tasks t
              WHERE t.enabled = TRUE
                AND NOT EXISTS (
                  SELECT 1 FROM mr_task_claims c
                  WHERE c.task_id = t.id AND c.telegram_id = $1
                    AND (c.completed_at IS NOT NULL OR c.was_member = TRUE))
                AND (t.max_users = 0 OR t.max_users > (SELECT COUNT(*) FROM mr_task_claims x WHERE x.task_id = t.id AND x.completed_at IS NOT NULL))) AS tasks,
            (SELECT COUNT(*)::int FROM mr_partner_tasks p
              WHERE p.telegram_id = $1 AND p.created_at >= ${DAY_START}) AS partner`,
        [telegramId]
    );
    return { adsToday: r.rows[0].ads, maxAds: max, tasksLeft: r.rows[0].tasks, partnerDone: r.rows[0].partner, partnerNeed: Math.max(0, Math.floor(partnerNeed || 0)) };
}

/* ===================== AUTH & TELEGRAM API ===================== */

const esc = s => String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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
    if (typeof auth === "string" && auth.toLowerCase().startsWith("tma ")) return auth.slice(4);
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

async function notifyUser(telegramId, text, extra = {}) {
    try {
        await telegram("sendMessage", {
            chat_id: Number(telegramId),
            text,
            disable_web_page_preview: true,
            ...extra
        });
    } catch (e) {
        console.error("notifyUser", e.message);
    }
}

/* ================= SECURITY & FRAUD ================= */

const SECURITY_RECHECK_MS = 10 * 60 * 1000;
const sha256 = v => crypto.createHash("sha256").update(String(v || "")).digest("hex");

function getClientIP(req) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(Array.isArray(fwd) ? fwd[0] : fwd).split(",")[0].trim();
    return String(req.headers["x-real-ip"] || req.socket?.remoteAddress || "");
}

async function trySend(chatId, text) {
    try {
        await telegram("sendMessage", { chat_id: Number(chatId), text, disable_web_page_preview: true });
        return true;
    } catch (e) {
        console.error("trySend", e.message);
        return false;
    }
}

function banTypeOf(reason) {
    const r = String(reason || "").toLowerCase();
    if (r.startsWith("admin")) return "other";
    if (/\b(vpn|proxy|tor)\b/.test(r)) return "vpn";
    if (r.includes("multiple") || r.includes("multi account")) return "multi";
    return "other";
}
const banHead = type => type === "vpn" ? "VPN/Proxy detected." : type === "multi" ? "Multiple accounts detected." : "";
const banDm = type => (banHead(type) ? banHead(type) + "\n\n" : "") + "Your account has been permanently banned from Adewa.";
const banApiText = type => (banHead(type) ? banHead(type) + " " : "") + "Your account has been permanently banned.";

async function detectVPNProxy(ip) {
    const result = { checked: false, vpn: false, proxy: false, tor: false, detected: false };
    const clean = String(ip || "").replace(/^::ffff:/, "").trim();
    if (!clean || clean === "127.0.0.1" || clean === "::1" || clean.startsWith("10.") || clean.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return result;
    try {
        const r = await fetch(`https://ipwho.is/${encodeURIComponent(clean)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        if (!r.ok) return result;
        const data = await r.json();
        if (!data || data.success === false) return result;
        result.checked = true;
        const s = data.security || {};
        result.vpn = s.vpn === true; result.proxy = s.proxy === true; result.tor = s.tor === true;
        result.detected = result.vpn || result.proxy || result.tor;
    } catch (e) { console.error("VPN check", e.message); }
    return result;
}

async function detectMultiAccount(id, ipHash, deviceHash, firstSeen) {
    const since = firstSeen ? new Date(firstSeen) : new Date();
    if (deviceHash) {
        const d = await pool.query(`SELECT 1 FROM fraud_users WHERE device_hash = $1 AND telegram_id <> $2 AND first_seen < $3 LIMIT 1`, [deviceHash, id, since]);
        if (d.rows.length) return { detected: true, reason: "Multiple Telegram accounts detected on the same device." };
    }
    if (ipHash && deviceHash) {
        const i = await pool.query(`SELECT 1 FROM fraud_users WHERE ip_hash = $1 AND telegram_id <> $2 AND status = 'verified' AND first_seen < $3 AND device_hash <> '' AND device_hash <> $4 LIMIT 1`, [ipHash, id, since, deviceHash]);
        if (i.rows.length) return { detected: true, reason: "Multiple Telegram accounts detected from the same IP address." };
    }
    return { detected: false, reason: "" };
}

async function saveFraud(tgUser, f) {
    await pool.query(
        `INSERT INTO fraud_users (telegram_id, username, first_name, ip_hash, device_hash, vpn_detected, proxy_detected, risk_score, status, ban_reason, checked_at, last_seen, request_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW(),1)
         ON CONFLICT (telegram_id) DO UPDATE SET
            username = EXCLUDED.username, first_name = EXCLUDED.first_name, ip_hash = EXCLUDED.ip_hash, device_hash = EXCLUDED.device_hash,
            vpn_detected = EXCLUDED.vpn_detected, proxy_detected = EXCLUDED.proxy_detected, risk_score = EXCLUDED.risk_score, status = EXCLUDED.status,
            ban_reason = EXCLUDED.ban_reason, checked_at = NOW(), last_seen = NOW(), request_count = fraud_users.request_count + 1`,
        [String(tgUser.id), tgUser.username || "", tgUser.first_name || "", f.ipHash, f.deviceHash, !!f.vpn, !!f.proxy, f.risk, f.status, f.reason]
    );
}

async function setFraudBan(id, banned, reason) {
    if (banned) {
        await pool.query(
            `INSERT INTO fraud_users (telegram_id, status, ban_reason, risk_score, admin_exempt, ban_message_sent)
             VALUES ($1,'banned',$2,100,FALSE,FALSE)
             ON CONFLICT (telegram_id) DO UPDATE SET status = 'banned', ban_reason = $2, risk_score = 100, admin_exempt = FALSE, ban_message_sent = FALSE, last_seen = NOW()`,
            [String(id), reason || "Admin ban"]
        );
    } else {
        await pool.query(
            `INSERT INTO fraud_users (telegram_id, status, ban_reason, risk_score, admin_exempt, ban_message_sent)
             VALUES ($1,'verified','',0,TRUE,FALSE)
             ON CONFLICT (telegram_id) DO UPDATE SET status = 'verified', ban_reason = '', vpn_detected = FALSE, proxy_detected = FALSE, risk_score = 0, admin_exempt = TRUE, ban_message_sent = FALSE, last_seen = NOW()`,
            [String(id)]
        );
    }
}

async function getBanState(id) {
    const f = await pool.query(`SELECT status, ban_reason FROM fraud_users WHERE telegram_id = $1`, [String(id)]);
    if (f.rows[0]?.status === "banned") return { banned: true, reason: f.rows[0].ban_reason || "" };
    const m = await pool.query(`SELECT is_banned FROM mr_users WHERE telegram_id = $1`, [String(id)]);
    if (m.rows[0]?.is_banned) return { banned: true, reason: "" };
    return { banned: false, reason: "" };
}

async function securityGate(req, tgUser) {
    const id = String(tgUser.id);
    if (ADMIN_ID && id === ADMIN_ID) return { ok: true };
    const ip = getClientIP(req);
    const ipHash = ip ? sha256(ip) : "";
    const device = String(req.headers["x-device"] || "").trim().slice(0, 100);
    const deviceHash = device ? sha256(device) : "";

    const ex = await pool.query(`SELECT * FROM fraud_users WHERE telegram_id = $1`, [id]);
    const row = ex.rows[0] || null;

    if (row && row.status === "banned") {
        const type = banTypeOf(row.ban_reason);
        await pool.query(`UPDATE mr_users SET is_banned = TRUE WHERE telegram_id = $1 AND is_banned = FALSE`, [id]);
        if (!row.ban_message_sent) {
            if (await trySend(id, banDm(type))) {
                await pool.query(`UPDATE fraud_users SET ban_message_sent = TRUE WHERE telegram_id = $1`, [id]);
            }
        }
        return { ok: false, reason: row.ban_reason, message: banApiText(type) };
    }

    if (row && row.admin_exempt) {
        await pool.query(`UPDATE fraud_users SET last_seen = NOW() WHERE telegram_id = $1`, [id]);
        return { ok: true };
    }

    const fresh = row && row.status === "verified" && row.checked_at &&
        Date.now() - new Date(row.checked_at).getTime() < SECURITY_RECHECK_MS &&
        row.ip_hash === ipHash && (!deviceHash || row.device_hash === deviceHash);
    if (fresh) {
        await pool.query(`UPDATE fraud_users SET last_seen = NOW() WHERE telegram_id = $1`, [id]);
        return { ok: true };
    }

    const net = await detectVPNProxy(ip);
    const multi = net.detected ? { detected: false, reason: "" } : await detectMultiAccount(id, ipHash, deviceHash, row ? row.first_seen : null);

    if (net.detected || multi.detected) {
        const type = net.detected ? "vpn" : "multi";
        const reason = net.detected ? (net.vpn ? "VPN detected" : net.proxy ? "Proxy detected" : "Tor detected") : multi.reason;
        await saveFraud(tgUser, { ipHash, deviceHash, vpn: net.vpn || net.tor, proxy: net.proxy, risk: 100, status: "banned", reason });
        await pool.query(`UPDATE mr_users SET is_banned = TRUE, updated_at = NOW() WHERE telegram_id = $1`, [id]);
        if (await trySend(id, banDm(type))) {
            await pool.query(`UPDATE fraud_users SET ban_message_sent = TRUE WHERE telegram_id = $1`, [id]);
        }
        return { ok: false, reason, message: banApiText(type) };
    }

    await saveFraud(tgUser, { ipHash, deviceHash, vpn: false, proxy: false, risk: 0, status: "verified", reason: "" });
    if (!row || !row.verification_message_sent) {
        if (await trySend(id, "\u2705 Your verification is successful.")) {
            await pool.query(`UPDATE fraud_users SET verification_message_sent = TRUE WHERE telegram_id = $1`, [id]);
        }
    }
    return { ok: true };
}

/* ================= USER & REFERRAL CREATION ================= */

async function createOrUpdateUser(tgUser, referralCode) {
    const telegramId = String(tgUser.id);
    const existing = await pool.query(`SELECT telegram_id FROM mr_users WHERE telegram_id = $1`, [telegramId]);
    if (existing.rows.length) {
        await pool.query(
            `UPDATE mr_users SET username=$2, first_name=$3, last_name=$4, photo_url=$5, updated_at=NOW() WHERE telegram_id=$1`,
            [telegramId, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || null]
        );
        return;
    }

    let referredBy = null;
    if (referralCode) {
        const inviter = await pool.query(`SELECT telegram_id FROM mr_users WHERE referral_code = $1 OR telegram_id::text = $1`, [referralCode]);
        if (inviter.rows.length && String(inviter.rows[0].telegram_id) !== telegramId) {
            referredBy = String(inviter.rows[0].telegram_id);
        }
    }

    await pool.query(
        `INSERT INTO mr_users(telegram_id, username, first_name, last_name, photo_url, referral_code, referred_by, last_mined_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT(telegram_id) DO NOTHING`,
        [telegramId, tgUser.username || null, tgUser.first_name || null, tgUser.last_name || null, tgUser.photo_url || null, crypto.randomBytes(8).toString("hex"), referredBy]
    );
}

async function processReferral(userId) {
    const u = await pool.query(`SELECT referred_by FROM mr_users WHERE telegram_id = $1`, [userId]);
    if (!u.rows.length || !u.rows[0].referred_by) return;
    await pool.query(
        `INSERT INTO mr_referrals(inviter_id, invited_id, reward, verified) VALUES($1,$2,0,FALSE) ON CONFLICT(invited_id) DO NOTHING`,
        [u.rows[0].referred_by, userId]
    );
}

async function tryVerifyReferral(userId, joined) {
    if (!joined) return;
    const r = await pool.query(
        `SELECT r.inviter_id, u.total_ads FROM mr_referrals r JOIN mr_users u ON u.telegram_id = r.invited_id
         WHERE r.invited_id = $1 AND r.verified = FALSE`,
        [userId]
    );
    if (!r.rows.length) return;

    const sRes = await pool.query(`SELECT key, value FROM mr_app_settings WHERE key IN ('verify_ads','invite_mining_percent','milestone_5','milestone_10','milestone_25')`);
    const set = {};
    for (const x of sRes.rows) set[x.key] = Number(x.value);
    const needAds = Number.isFinite(set.verify_ads) ? set.verify_ads : 1;
    const invPct = Number.isFinite(set.invite_mining_percent) ? set.invite_mining_percent : 1;

    if (Number(r.rows[0].total_ads) < needAds) return;
    const inviterId = r.rows[0].inviter_id;

    let verifiedNow = false;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Accrue any pending mining before boost changes
        await accrueMining(client, inviterId);

        const upd = await client.query(
            `UPDATE mr_referrals SET verified = TRUE, verified_at = NOW(), reward = $2
             WHERE invited_id = $1 AND verified = FALSE RETURNING id`,
            [userId, invPct]
        );
        if (upd.rows.length) {
            await client.query(
                `UPDATE mr_users SET invite_count = invite_count + 1, total_invites = total_invites + 1, updated_at = NOW() WHERE telegram_id = $1`,
                [inviterId]
            );
            verifiedNow = true;

            const cnt = await client.query(`SELECT total_invites FROM mr_users WHERE telegram_id = $1`, [inviterId]);
            const total = Number(cnt.rows[0].total_invites);
            for (const m of [5, 10, 25]) {
                const bonus = Number(set["milestone_" + m]);
                if (total >= m && Number.isFinite(bonus) && bonus > 0) {
                    const ins = await client.query(
                        `INSERT INTO mr_milestone_claims(telegram_id, milestone, reward) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
                        [inviterId, m, bonus]
                    );
                    if (ins.rows.length) {
                        await client.query(`UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`, [inviterId, bonus]);
                    }
                }
            }
        }
        await client.query("COMMIT");
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
    } finally {
        client.release();
    }

    if (verifiedNow) {
        notifyUser(inviterId, `\u26A1 A friend is verified! Your mining rate increased by +${invPct}%.`);
    }
}

/* ============================== ME ============================== */

app.get("/api/me", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        let referral = null;
        if (typeof req.query.ref === "string") referral = req.query.ref.trim();
        if (!referral && req.startParam) {
            referral = req.startParam.startsWith("ref_") ? req.startParam.slice(4) : req.startParam;
        }

        const telegramId = String(req.telegramUser.id);
        const gate = await securityGate(req, req.telegramUser);
        if (!gate.ok) {
            return res.status(403).json({ ok: false, status: "banned", reason: gate.reason, error: gate.message });
        }

        await createOrUpdateUser(req.telegramUser, referral);
        pool.query(`UPDATE mr_users SET last_active = NOW() WHERE telegram_id = $1`, [telegramId]).catch(() => {});

        try { await processReferral(telegramId); } catch (e) { console.error("processReferral", e.message); }

        const channels = await checkAllChannels(telegramId);
        const allJoined = allJoinedOf(channels);

        try { await tryVerifyReferral(telegramId, allJoined); } catch (e) { console.error("tryVerifyReferral", e.message); }

        await pool.query(`UPDATE mr_users SET is_verified=$2, updated_at=NOW() WHERE telegram_id=$1`, [telegramId, allJoined]);

        // Accrue real-time passive mining earnings
        const miningData = await accrueMining(pool, telegramId);

        const userResult = await pool.query(`SELECT * FROM mr_users WHERE telegram_id = $1`, [telegramId]);
        const user = userResult.rows[0];

        if (user.is_banned) {
            return res.status(403).json({ ok: false, error: "Your account is banned." });
        }

        const rankResult = await pool.query(`SELECT COUNT(*) + 1 AS rank FROM mr_users WHERE is_banned = FALSE AND points > $1`, [user.points]);
        const settings = await settingsMap();

        const todayRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM mr_ad_rewards WHERE telegram_id = $1 AND created_at >= ${DAY_START}`,
            [telegramId]
        );

        let limits = null;
        try { limits = await getPayoutLimits(pool, settings); } catch (e) { console.error("limits", e.message); }

        let withdrawNextAt = 0;
        try { withdrawNextAt = await nextWithdrawAt(pool, telegramId); } catch (e) { console.error("withdrawNextAt", e.message); }

        let withdrawReq = null;
        try { withdrawReq = await getWithdrawRequirements(pool, telegramId, settings.max_ads_per_day, partnerNeeded(settings)); } catch (e) { console.error("withdrawReq", e.message); }

        let partner = { today: 0, points: 0, total: 0 };
        try {
            const pr = await pool.query(
                `SELECT COUNT(*) FILTER (WHERE created_at >= ${DAY_START})::int AS today,
                        COALESCE(SUM(reward) FILTER (WHERE created_at >= ${DAY_START}), 0) AS points,
                        COUNT(*)::int AS total
                 FROM mr_partner_tasks WHERE telegram_id = $1`, [telegramId]);
            partner = { today: pr.rows[0].today, points: Number(pr.rows[0].points), total: pr.rows[0].total };
        } catch (e) { console.error("partner stats", e.message); }

        res.json({
            ok: true,
            settings,
            partner,
            withdraw_next_at: withdrawNextAt,
            withdraw_req: withdrawReq,
            today_ads: todayRes.rows[0].c,
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
                mining_percent: miningData.totalBoostPercent,
                mining_hourly_usd: miningData.effectiveHourlyUsd,
                mining_daily_usd: miningData.effectiveDailyUsd,
                mining_per_second: miningData.perSecondUsd,
                referral_code: user.referral_code,
                rank: Number(rankResult.rows[0].rank),
                is_verified: allJoined,
                is_admin: telegramId === ADMIN_ID
            },
            channels,
            allJoined,
            adsgram: { blockId: ADSGRAM_BLOCK_ID, interBlockId: ADSGRAM_INTERSTITIAL_BLOCK_ID, taskBlockId: ADSGRAM_TASK_BLOCK_ID },
            monetag: { zoneId: MONETAG_ZONE_ID },
            payout: { symbol: TOKEN_SYMBOL, ready: PAY_READY, explorer: EXPLORER_TX, limits },
            bot: { username: BOT_USERNAME }
        });
    } catch (error) {
        console.error("/api/me", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* =========================== AD REWARD =========================== */

app.post("/api/ad-reward", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        const telegramId = String(req.telegramUser.id);
        const provider = req.body?.provider === "monetag" ? "monetag" : "adsgram";
        const strict = provider === "monetag" ? STRICT_MONETAG : STRICT_ADS;

        const rewardKey = typeof req.body?.rewardKey === "string" ? req.body.rewardKey.trim() : "";
        if (!rewardKey || rewardKey.length > 120) return res.status(400).json({ ok: false, error: "rewardKey is required." });

        const me = await pool.query(`SELECT is_banned FROM mr_users WHERE telegram_id = $1`, [telegramId]);
        if (!me.rows.length || me.rows[0].is_banned) return res.status(403).json({ ok: false, error: "Your account is banned." });

        if (strict) {
            const has = await pool.query(
                `SELECT 1 FROM mr_ad_credits WHERE telegram_id = $1 AND provider = $2 AND used = FALSE AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
                [telegramId, provider]
            );
            if (!has.rows.length) return res.status(409).json({ ok: false, pending: true, error: "Waiting for ad confirmation..." });
        }

        const channels = await checkAllChannels(telegramId);
        if (!allJoinedOf(channels)) return res.status(403).json({ ok: false, error: "Join all required channels first." });

        const limitResult = await pool.query(`SELECT value FROM mr_app_settings WHERE key = 'max_ads_per_day'`);
        const maxAds = Number(limitResult.rows[0]?.value || 100);

        const todayResult = await pool.query(
            `SELECT COUNT(*)::int AS count FROM mr_ad_rewards WHERE telegram_id = $1 AND created_at >= ${DAY_START}`,
            [telegramId]
        );
        if (Number(todayResult.rows[0].count) >= maxAds) return res.status(429).json({ ok: false, error: "Daily ad limit reached." });

        let unlockedBoost = false;
        let newTotalAds = 0;

        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            // Accrue pending mining before ad count changes
            await accrueMining(client, telegramId);

            let finalKey = `${provider}:${telegramId}:${rewardKey}`;
            if (strict) {
                const credit = await client.query(
                    `UPDATE mr_ad_credits SET used = TRUE
                     WHERE id = (
                         SELECT id FROM mr_ad_credits
                         WHERE telegram_id = $1 AND provider = $2 AND used = FALSE AND created_at > NOW() - INTERVAL '15 minutes'
                         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
                     ) RETURNING id`,
                    [telegramId, provider]
                );
                if (!credit.rows.length) {
                    await client.query("ROLLBACK");
                    return res.status(409).json({ ok: false, pending: true, error: "Waiting for ad confirmation..." });
                }
                finalKey = `credit:${credit.rows[0].id}`;
            }

            await client.query(`INSERT INTO mr_ad_rewards(telegram_id, reward, reward_key) VALUES($1,1,$2)`, [telegramId, finalKey]);

            const up = await client.query(
                `UPDATE mr_users
                 SET ads_count = ads_count + 1,
                     total_ads = total_ads + 1,
                     updated_at = NOW()
                 WHERE telegram_id = $1
                 RETURNING total_ads`,
                [telegramId]
            );

            newTotalAds = Number(up.rows[0].total_ads);
            // Check if exactly hit a 50 ads milestone
            if (newTotalAds > 0 && newTotalAds % 50 === 0) {
                unlockedBoost = true;
            }

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            if (error.code === "23505") return res.status(409).json({ ok: false, error: "This reward was already claimed." });
            throw error;
        } finally {
            client.release();
        }

        try { await tryVerifyReferral(telegramId, true); } catch (e) { console.error("tryVerifyReferral", e.message); }

        res.json({
            ok: true,
            total_ads: newTotalAds,
            unlocked_boost: unlockedBoost
        });
    } catch (error) {
        console.error("/api/ad-reward", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ===================== TASKS (BOOST MINING) ===================== */

app.get("/api/tasks", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT t.id, t.title, t.description, t.url, t.channel, t.reward, t.sponsored, t.max_users,
                    (c.completed_at IS NOT NULL) AS completed,
                    (c.started_at IS NOT NULL) AS started,
                    COALESCE(c.was_member, FALSE) AS was_member
             FROM mr_tasks t
             LEFT JOIN mr_task_claims c ON c.task_id = t.id AND c.telegram_id = $1
             WHERE t.enabled = TRUE
               AND (t.max_users = 0 OR c.completed_at IS NOT NULL OR t.max_users > (SELECT COUNT(*) FROM mr_task_claims x WHERE x.task_id = t.id AND x.completed_at IS NOT NULL))
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
        if (!allJoinedOf(await checkAllChannels(telegramId))) return res.status(403).json({ ok: false, error: "Join all required channels first." });

        const t = await pool.query(`SELECT id, channel FROM mr_tasks WHERE id = $1 AND enabled = TRUE`, [req.params.id]);
        if (!t.rows.length) return res.status(404).json({ ok: false, error: "Task not found." });

        let wasMember = false;
        if (t.rows[0].channel) wasMember = (await checkChannel(telegramId, t.rows[0].channel)).joined;

        const ins = await pool.query(
            `INSERT INTO mr_task_claims(task_id, telegram_id, was_member) VALUES($1,$2,$3)
             ON CONFLICT(task_id, telegram_id) DO UPDATE SET task_id = EXCLUDED.task_id
             RETURNING was_member`,
            [req.params.id, telegramId, wasMember]
        );
        res.json({ ok: true, already_member: !!ins.rows[0].was_member });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/tasks/:id/claim", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: "Invalid id." });
        const telegramId = String(req.telegramUser.id);

        if (!allJoinedOf(await checkAllChannels(telegramId))) return res.status(403).json({ ok: false, error: "Join all required channels first." });

        const tr = await pool.query(`SELECT * FROM mr_tasks WHERE id = $1 AND enabled = TRUE`, [req.params.id]);
        if (!tr.rows.length) return res.status(404).json({ ok: false, error: "Task not found." });
        const task = tr.rows[0];

        const cr = await pool.query(
            `SELECT completed_at, was_member, EXTRACT(EPOCH FROM (NOW() - started_at)) AS secs
             FROM mr_task_claims WHERE task_id = $1 AND telegram_id = $2`,
            [task.id, telegramId]
        );
        if (!cr.rows.length) return res.status(400).json({ ok: false, error: "Start the task first." });
        if (cr.rows[0].completed_at) return res.status(409).json({ ok: false, error: "Task already completed." });
        if (cr.rows[0].was_member) {
            return res.status(400).json({ ok: false, error: "You were already a member of this channel, so it gives no reward." });
        }

        if (task.channel) {
            const chk = await checkChannel(telegramId, task.channel);
            if (!chk.joined) return res.status(400).json({ ok: false, error: "Join the channel first, then claim." });
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            // Accrue mining up to this moment
            await accrueMining(client, telegramId);

            const upd = await client.query(
                `UPDATE mr_task_claims SET completed_at = NOW() WHERE task_id = $1 AND telegram_id = $2 AND completed_at IS NULL RETURNING id`,
                [task.id, telegramId]
            );
            if (!upd.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "Task already completed." });
            }

            // Task reward increases the mining percentage!
            await client.query(
                `UPDATE mr_users SET task_boost_percent = task_boost_percent + $2, updated_at = NOW() WHERE telegram_id = $1`,
                [telegramId, Number(task.reward)]
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

/* ===================== WITHDRAWALS ===================== */

let payer = null;
function getPayer() {
    if (!PAY_READY) throw new Error("Payments are not configured.");
    if (!payer) {
        const provider = new ethers.JsonRpcProvider(BSC_RPC_URL, BSC_CHAIN_ID, { staticNetwork: true });
        const wallet = new ethers.Wallet(PAYOUT_PRIVATE_KEY, provider);
        payer = { wallet, provider };
    }
    return payer;
}

async function sendPayout(to, tokenAmount, onSent) {
    const { wallet, provider } = getPayer();
    const token = new ethers.Contract(USDT_CONTRACT, ERC20_ABI, wallet);
    const lock = await pool.connect();
    try {
        await lock.query("SELECT pg_advisory_lock(778899)");
        const amt = ethers.parseUnits(Number(tokenAmount).toFixed(8), TOKEN_DECIMALS);
        const tokBal = await token.balanceOf(wallet.address);
        if (tokBal < amt) throw new Error("Payout wallet has not enough " + TOKEN_SYMBOL + ".");

        let gasLimit;
        try {
            gasLimit = ((await token.transfer.estimateGas(to, amt)) * 12n) / 10n;
        } catch (e) {
            throw new Error("Transfer estimation failed: " + (e.shortMessage || e.message));
        }
        const feeData = await provider.getFeeData();
        const bnbBal = await provider.getBalance(wallet.address);
        if (bnbBal < gasLimit * (feeData.gasPrice || 0n)) {
            throw new Error("Payout wallet has not enough BNB for the network gas fee.");
        }

        const tx = await token.transfer(to, amt, { gasLimit });
        if (typeof onSent === "function") {
            try { await onSent(tx.hash); } catch (e) { console.error("onSent", e.message); }
        }
        return tx.hash;
    } finally {
        await lock.query("SELECT pg_advisory_unlock(778899)").catch(() => {});
        lock.release();
    }
}

async function approveWithdrawal(id, adminId) {
    const c = await pool.query(
        `UPDATE mr_withdrawals SET status = 'processing', processing_at = NOW()
         WHERE id = $1 AND (status = 'pending' OR (status = 'processing' AND (processing_at IS NULL OR processing_at < NOW() - INTERVAL '3 minutes')))
         RETURNING *`,
        [id]
    );
    if (!c.rows.length) return { ok: false, error: "Request not found or already processed." };
    const row = c.rows[0];

    let txHash = row.tx_hash || null;
    if (!txHash) {
        try {
            const amountUsd = Number(row.token_amount || row.final_amount);
            if (!(amountUsd > 0)) throw new Error("Amount is too small.");
            txHash = await sendPayout(row.address, amountUsd, async h => {
                await pool.query(`UPDATE mr_withdrawals SET tx_hash = $2 WHERE id = $1`, [id, h]);
            });
        } catch (e) {
            console.error("payout failed", e.message);
            await pool.query(`UPDATE mr_withdrawals SET status = 'pending' WHERE id = $1 AND tx_hash IS NULL`, [id]).catch(() => {});
            return { ok: false, error: "Payment failed: " + e.message };
        }
    }

    await pool.query(
        `UPDATE mr_withdrawals SET status='approved', tx_hash=$2, admin_note='Approved', processed_at=NOW() WHERE id=$1`,
        [id, txHash]
    );

    return { ok: true, tx_hash: txHash };
}

async function rejectWithdrawal(id, adminId, note) {
    const client = await pool.connect();
    let w;
    try {
        await client.query("BEGIN");
        const u = await client.query(
            `UPDATE mr_withdrawals SET status='rejected', admin_note=$2, processed_at=NOW()
             WHERE id=$1 AND (status='pending' OR (status='processing' AND tx_hash IS NULL))
             RETURNING telegram_id, amount`,
            [id, note]
        );
        if (!u.rows.length) {
            await client.query("ROLLBACK");
            return { ok: false, error: "Request not found or already processed." };
        }
        w = u.rows[0];
        await client.query(`UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`, [w.telegram_id, w.amount]);
        await client.query("COMMIT");
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    await notifyUser(w.telegram_id, `\u274C Your withdrawal request #${id} was rejected. $${Number(w.amount).toFixed(2)} USD returned to your balance.`);
    return { ok: true };
}

app.post("/api/withdraw", authenticate, async (req, res) => {
    try {
        await requireDatabase();

        const telegramId = String(req.telegramUser.id);
        const amount = Number(req.body?.amount);
        const rawAddr = String(req.body?.address || "").trim();

        if (!PAY_READY) return res.status(503).json({ ok: false, error: "Withdrawals are temporarily unavailable." });
        if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddr) || !ethers.isAddress(rawAddr)) {
            return res.status(400).json({ ok: false, error: "Enter a valid BEP20 address (0x + 40 characters)." });
        }
        const address = ethers.getAddress(rawAddr.toLowerCase());
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Enter a valid amount." });

        const S = await settingsMap();
        const closedUntil = (Number(S.withdraw_closed_until) || 0) * 1000;
        if (closedUntil > Date.now()) {
            return res.status(403).json({ ok: false, error: "Withdraw requests are closed for today. They will open on " + fmtServerDay(closedUntil) + "." });
        }

        const nextAt = await nextWithdrawAt(pool, telegramId);
        if (nextAt > Date.now()) {
            return res.status(429).json({ ok: false, error: "Only one withdraw request per day for each account. You can send the next one in " + fmtWait(nextAt - Date.now()) + "." });
        }

        const reqs = await getWithdrawRequirements(pool, telegramId, S.max_ads_per_day, partnerNeeded(S));
        if (reqs.maxAds > 0 && reqs.adsToday < reqs.maxAds) return res.status(400).json({ ok: false, error: `Watch all of today's ads first: ${reqs.adsToday} / ${reqs.maxAds} done.` });
        if (reqs.tasksLeft > 0) return res.status(400).json({ ok: false, error: `Complete all tasks first: ${reqs.tasksLeft} task(s) left.` });
        if (reqs.partnerNeed > 0 && reqs.partnerDone < reqs.partnerNeed) return res.status(400).json({ ok: false, error: `Complete the Partner tasks first: ${reqs.partnerDone} / ${reqs.partnerNeed} done today.` });

        const minWithdraw = Number.isFinite(S.min_withdraw) ? S.min_withdraw : 0.10;
        if (amount < minWithdraw) return res.status(400).json({ ok: false, error: `Minimum withdrawal is $${minWithdraw} USD.` });

        let feePct = Number.isFinite(S.withdraw_fee_percent) ? S.withdraw_fee_percent : 25;
        feePct = Math.min(Math.max(feePct, 0), 90);
        const fee = Math.round(amount * feePct) / 100;
        const finalAmount = Math.max(0, Math.round((amount - fee) * 10000) / 10000);

        let wid;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock(778800)");

            // Accrue all mining before checking balance
            await accrueMining(client, telegramId);

            const u = await client.query(`SELECT points, is_banned FROM mr_users WHERE telegram_id = $1 FOR UPDATE`, [telegramId]);
            if (!u.rows.length || u.rows[0].is_banned) { await client.query("ROLLBACK"); return res.status(403).json({ ok: false, error: "Account not allowed." }); }
            if (Number(u.rows[0].points) < amount) { await client.query("ROLLBACK"); return res.status(400).json({ ok: false, error: "Not enough mining balance." }); }

            const pending = await client.query(`SELECT 1 FROM mr_withdrawals WHERE telegram_id = $1 AND status IN ('pending','processing') LIMIT 1`, [telegramId]);
            if (pending.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ ok: false, error: "You already have a payout in progress." }); }

            await client.query(`UPDATE mr_users SET points = points - $2, updated_at = NOW() WHERE telegram_id = $1`, [telegramId, amount]);
            const ins = await client.query(
                `INSERT INTO mr_withdrawals(telegram_id, amount, method, address, fee, final_amount, token_amount, usd_amount)
                 VALUES($1,$2,'BEP20',$3,$4,$5,$5,$5) RETURNING id`,
                [telegramId, amount, address, fee, finalAmount]
            );
            wid = ins.rows[0].id;
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }

        const displayName = [req.telegramUser.first_name, req.telegramUser.last_name].filter(Boolean).join(" ") || "User";

        if (ADMIN_ID) {
            await telegram("sendMessage", {
                chat_id: Number(ADMIN_ID),
                text: `\u26A1 <b>Withdrawal Request #${wid}</b>\n\nUser: ${displayName} (ID: <code>${telegramId}</code>)\nAmount: <b>$${finalAmount.toFixed(4)} ${TOKEN_SYMBOL}</b> (after $${fee.toFixed(2)} fee)\nAddress: <code>${address}</code>`,
                parse_mode: "HTML",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "\u2705 Approve", callback_data: `wd:approve:${wid}` },
                            { text: "\u274C Reject", callback_data: `wd:reject:${wid}` }
                        ]
                    ]
                }
            }).catch(e => console.error("Admin msg err", e.message));
        }

        res.json({
            ok: true,
            pending: true,
            id: wid,
            receipt_data: {
                id: wid,
                name: displayName,
                requested_usd: amount,
                fee_usd: fee,
                final_usd: finalAmount,
                symbol: TOKEN_SYMBOL,
                gateway: TOKEN_SYMBOL + " BEP20"
            }
        });
    } catch (error) {
        console.error("/api/withdraw", error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/withdrawals", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT id, amount, fee, COALESCE(final_amount, amount) AS final_amount, token_amount, method, address, status, admin_note, tx_hash, created_at, processed_at
             FROM mr_withdrawals WHERE telegram_id = $1 ORDER BY id DESC LIMIT 30`,
            [String(req.telegramUser.id)]
        );
        res.json({ ok: true, withdrawals: r.rows.map(w => ({ ...w, amount: Number(w.amount), fee: Number(w.fee), final_amount: Number(w.final_amount), token_amount: Number(w.token_amount || 0) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ===================== ADMIN CONTROLS ===================== */

function requireAdmin(req, res, next) {
    if (!ADMIN_ID || String(req.telegramUser.id) !== ADMIN_ID) {
        return res.status(403).json({ ok: false, error: "Admin access required." });
    }
    next();
}

app.post("/api/admin/settings", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const settings = req.body || {};
        for (const [key, value] of Object.entries(settings)) {
            if (value === undefined || value === null || value === "") continue;
            await pool.query(
                `INSERT INTO mr_app_settings(key, value, updated_at) VALUES($1,$2,NOW())
                 ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, String(value)]
            );
        }
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/withdrawals", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const status = String(req.query.status || "pending");
        const params = [];
        let where = status === "pending" ? "WHERE w.status IN ('pending','processing')" : "WHERE w.status = $1";
        if (status !== "pending") params.push(status);

        const r = await pool.query(
            `SELECT w.id, w.telegram_id, w.amount, w.fee, COALESCE(w.final_amount, w.amount) AS final_amount, w.token_amount,
                    w.method, w.address, w.status, w.admin_note, w.tx_hash, w.created_at, w.processed_at,
                    u.username, u.first_name, u.last_name
             FROM mr_withdrawals w LEFT JOIN mr_users u ON u.telegram_id = w.telegram_id
             ${where} ORDER BY w.id DESC LIMIT 100`,
            params
        );
        res.json({ ok: true, withdrawals: r.rows.map(w => ({ ...w, amount: Number(w.amount), fee: Number(w.fee), final_amount: Number(w.final_amount), token_amount: Number(w.token_amount || 0) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/withdrawals/:id/approve", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const r = await approveWithdrawal(req.params.id, ADMIN_ID);
        res.status(r.ok ? 200 : 400).json(r);
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/withdrawals/:id/reject", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const r = await rejectWithdrawal(req.params.id, ADMIN_ID, req.body?.note || "Rejected by admin");
        res.status(r.ok ? 200 : 400).json(r);
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/stats", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(`
            SELECT
                (SELECT COUNT(*)::int FROM mr_users) AS total_users,
                (SELECT COUNT(*)::int FROM mr_users WHERE created_at >= ${DAY_START}) AS new_today,
                (SELECT COUNT(*)::int FROM mr_users WHERE is_banned = TRUE) AS banned,
                (SELECT COUNT(*)::int FROM mr_ad_rewards WHERE created_at >= ${DAY_START}) AS ads_today,
                (SELECT COUNT(*)::int FROM mr_ad_rewards) AS ads_total,
                (SELECT COALESCE(SUM(amount),0) FROM mr_withdrawals WHERE status = 'approved') AS paid_total,
                (SELECT COALESCE(SUM(amount),0) FROM mr_withdrawals WHERE status = 'approved' AND processed_at >= ${DAY_START}) AS paid_today,
                (SELECT COUNT(*)::int FROM mr_withdrawals WHERE status IN ('pending','processing')) AS pending_count,
                (SELECT COUNT(*)::int FROM mr_referrals WHERE verified = TRUE) AS verified_refs,
                (SELECT COALESCE(SUM(amount),0) FROM mr_withdrawals WHERE status <> 'rejected' AND created_at >= ${DAY_START}) AS budget_used
        `);
        res.json({ ok: true, stats: r.rows[0] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/users", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const q = String(req.query.q || "").trim().slice(0, 50);
        let r;
        if (!q) {
            r = await pool.query(`SELECT telegram_id, username, first_name, last_name, photo_url, points, total_ads, total_invites, is_banned, created_at FROM mr_users ORDER BY created_at DESC LIMIT 20`);
        } else {
            const like = "%" + q.replace(/^@/, "") + "%";
            r = await pool.query(`SELECT telegram_id, username, first_name, last_name, photo_url, points, total_ads, total_invites, is_banned, created_at FROM mr_users WHERE telegram_id::text = $1 OR username ILIKE $2 OR first_name ILIKE $2 ORDER BY created_at DESC LIMIT 20`, [q, like]);
        }
        res.json({ ok: true, users: r.rows.map(u => ({ ...u, points: Number(u.points) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/users/:id/points", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const id = String(req.params.id);
        const amount = Number(req.body?.amount);
        const r = await pool.query(
            `UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1 AND points + $2 >= 0 RETURNING points`,
            [id, amount]
        );
        res.json({ ok: true, points: Number(r.rows[0].points) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/users/:id/ban", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const id = String(req.params.id);
        const banned = req.body?.banned === true;
        await pool.query(`UPDATE mr_users SET is_banned = $2, updated_at = NOW() WHERE telegram_id = $1`, [id, banned]);
        await setFraudBan(id, banned, "Admin ban");
        res.json({ ok: true });
    } catch (error) {
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
        const { title, description, url, channel, reward, max_users } = req.body || {};
        await pool.query(
            `INSERT INTO mr_tasks(title, description, url, channel, reward, max_users) VALUES($1,$2,$3,$4,$5,$6)`,
            [title, description || "", url, channel || null, Number(reward), Number(max_users) || 0]
        );
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/tasks/:id/delete", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        await pool.query(`DELETE FROM mr_task_claims WHERE task_id = $1`, [req.params.id]);
        await pool.query(`DELETE FROM mr_tasks WHERE id = $1`, [req.params.id]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ===================== PROMO & GROWTH ===================== */

app.post("/api/promo/redeem", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const telegramId = String(req.telegramUser.id);
        const code = String(req.body?.code || "").trim().toUpperCase();
        const client = await pool.connect();
        let reward = 0;
        try {
            await client.query("BEGIN");
            const pr = await client.query(`SELECT * FROM mr_promo_codes WHERE code = $1 FOR UPDATE`, [code]);
            if (!pr.rows.length || !pr.rows[0].enabled || pr.rows[0].used_count >= pr.rows[0].max_uses) {
                await client.query("ROLLBACK");
                return res.status(400).json({ ok: false, error: "Invalid or expired promo code." });
            }
            const ins = await client.query(`INSERT INTO mr_promo_redemptions(code, telegram_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id`, [code, telegramId]);
            if (!ins.rows.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ ok: false, error: "You already used this promo code." });
            }
            reward = Number(pr.rows[0].reward);
            await client.query(`UPDATE mr_promo_codes SET used_count = used_count + 1 WHERE code = $1`, [code]);
            await client.query(`UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`, [telegramId, reward]);
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        res.json({ ok: true, reward });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/api/admin/promos", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(`SELECT code, reward, max_uses, used_count, enabled FROM mr_promo_codes ORDER BY created_at DESC LIMIT 100`);
        res.json({ ok: true, promos: r.rows.map(p => ({ ...p, reward: Number(p.reward) })) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/promos", authenticate, requireAdmin, async (req,app.post("/api/admin/promos", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        let code = String(req.body?.code || "").trim().toUpperCase();
        const reward = Number(req.body?.reward);
        const maxUses = Number(req.body?.maxUses);

        if (!code) code = crypto.randomBytes(4).toString("hex").toUpperCase();
        if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
            return res.status(400).json({ ok: false, error: "Code must be 3-32 characters: A-Z, 0-9, _ or -" });
        }
        if (!Number.isFinite(reward) || reward <= 0) {
            return res.status(400).json({ ok: false, error: "Reward must be greater than 0." });
        }
        if (!Number.isInteger(maxUses) || maxUses < 1) {
            return res.status(400).json({ ok: false, error: "Number of uses must be 1 or more." });
        }
        await pool.query(
            `INSERT INTO mr_promo_codes(code, reward, max_uses) VALUES($1,$2,$3)`,
            [code, reward, maxUses]
        );
        res.json({ ok: true, code });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ ok: false, error: "This code already exists." });
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/promos/:code/delete", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const code = String(req.params.code || "").toUpperCase();
        await pool.query(`DELETE FROM mr_promo_redemptions WHERE code = $1`, [code]);
        await pool.query(`DELETE FROM mr_promo_codes WHERE code = $1`, [code]);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================ BROADCAST ============================ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runBroadcast(id, text) {
    let sent = 0, failed = 0;
    for (let round = 0; round < 3; round++) {
        const batch = await pool.query(
            `SELECT telegram_id FROM mr_users WHERE is_banned = FALSE AND last_broadcast < $1 ORDER BY telegram_id LIMIT 25`,
            [id]
        );
        if (!batch.rows.length) break;
        const ids = batch.rows.map(r => String(r.telegram_id));
        const results = await Promise.allSettled(
            ids.map(uid => telegram("sendMessage", { chat_id: Number(uid), text }))
        );
        for (const r of results) r.status === "fulfilled" ? sent++ : failed++;
        await pool.query(`UPDATE mr_users SET last_broadcast = $1 WHERE telegram_id = ANY($2::bigint[])`, [id, ids]);
        await sleep(1100);
    }
    const rem = await pool.query(`SELECT COUNT(*)::int AS c FROM mr_users WHERE is_banned = FALSE AND last_broadcast < $1`, [id]);
    return { sent, failed, remaining: rem.rows[0].c };
}

app.post("/api/admin/broadcast", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const text = String(req.body?.text || "").trim();
        if (!text || text.length > 1000) return res.status(400).json({ ok: false, error: "Message must be 1-1000 characters." });
        const ins = await pool.query(`INSERT INTO mr_broadcasts(text, admin_id) VALUES($1,$2) RETURNING id`, [text, ADMIN_ID]);
        const id = ins.rows[0].id;
        const out = await runBroadcast(id, text);
        res.json({ ok: true, id: String(id), ...out });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post("/api/admin/broadcast/:id/continue", authenticate, requireAdmin, async (req, res) => {
    try {
        await requireDatabase();
        const b = await pool.query(`SELECT id, text FROM mr_broadcasts WHERE id = $1`, [req.params.id]);
        if (!b.rows.length) return res.status(404).json({ ok: false, error: "Broadcast not found." });
        const out = await runBroadcast(b.rows[0].id, b.rows[0].text);
        res.json({ ok: true, id: String(b.rows[0].id), ...out });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================ MY FRIENDS ============================ */

app.get("/api/referrals", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT r.invited_id AS telegram_id, r.verified, r.created_at, u.username, u.first_name, u.last_name, u.photo_url, u.total_ads, u.is_verified AS joined
             FROM mr_referrals r JOIN mr_users u ON u.telegram_id = r.invited_id
             WHERE r.inviter_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
            [String(req.telegramUser.id)]
        );
        const cl = await pool.query(`SELECT milestone FROM mr_milestone_claims WHERE telegram_id = $1`, [String(req.telegramUser.id)]);
        res.json({ ok: true, friends: r.rows, claimed: cl.rows.map(x => x.milestone) });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/* ============================ LUCKY SPIN ============================ */

const SPIN_PRIZES = [{ p: 0.01, w: 40 }, { p: 0.02, w: 30 }, { p: 0.05, w: 18 }, { p: 0.10, w: 9 }, { p: 0.25, w: 3 }];

async function spinInfo(q, id, st) {
    const u = await q.query(`SELECT COUNT(*)::int AS c FROM mr_spins WHERE telegram_id = $1 AND created_at >= ${DAY_START}`, [id]);
    const a = await q.query(`SELECT COUNT(*)::int AS c FROM mr_ad_rewards WHERE telegram_id = $1 AND created_at >= ${DAY_START}`, [id]);
    const freeTotal = Math.max(0, Math.floor(st.spin_free ?? 1));
    const used = u.rows[0].c, ads = a.rows[0].c, maxX = Math.floor(st.spin_max_extra ?? 3);
    const extraUsed = Math.max(0, used - freeTotal);
    const free = Math.max(0, freeTotal - used);
    return {
        enabled: (st.spin_enabled ?? 1) > 0, used, free, free_total: freeTotal, max_extra: maxX,
        available: free + Math.max(0, Math.min(maxX, ads) - extraUsed),
        extra_left: Math.max(0, maxX - extraUsed),
        prizes: SPIN_PRIZES.map(x => Number((x.p * (st.spin_scale ?? 1)).toFixed(4)))
    };
}

app.get("/api/spin", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        res.json({ ok: true, ...(await spinInfo(pool, String(req.telegramUser.id), await settingsMap())) });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post("/api/spin", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const id = String(req.telegramUser.id);
        const st = await settingsMap();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [id]);
            const info = await spinInfo(client, id, st);
            if (!info.enabled || info.available < 1) {
                await client.query("ROLLBACK");
                return res.status(429).json({ ok: false, error: "No spins left. Watch an ad for an extra spin." });
            }
            let n = crypto.randomInt(SPIN_PRIZES.reduce((s, x) => s + x.w, 0)), prize = SPIN_PRIZES[0].p, index = 0;
            for (let i = 0; i < SPIN_PRIZES.length; i++) {
                const x = SPIN_PRIZES[i];
                if (n < x.w) { prize = x.p; index = i; break; }
                n -= x.w;
            }
            prize = Number((prize * (st.spin_scale ?? 1)).toFixed(4));
            await client.query(`INSERT INTO mr_spins(telegram_id, prize) VALUES($1,$2)`, [id, prize]);
            await client.query(`UPDATE mr_users SET points = points + $2, updated_at = NOW() WHERE telegram_id = $1`, [id, prize]);
            await client.query("COMMIT");
            res.json({ ok: true, prize, index });
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ============================ PROOF FEED ============================ */

app.get("/api/proof-feed", authenticate, async (req, res) => {
    try {
        await requireDatabase();
        const r = await pool.query(
            `SELECT w.method, w.amount, w.fee, w.final_amount, w.address, w.tx_hash,
                    COALESCE(w.usd_amount, w.token_amount, w.amount) AS usd, w.token_amount, w.processed_at, u.first_name, u.username
             FROM mr_withdrawals w LEFT JOIN mr_users u ON u.telegram_id = w.telegram_id
             WHERE w.status = 'approved' ORDER BY w.processed_at DESC NULLS LAST LIMIT 15`
        );
        const mask = s => { s = String(s || "User"); return s.slice(0, 2) + "***"; };
        const short = (s, a, b) => { s = String(s || ""); return s.length > a + b + 3 ? s.slice(0, a) + "..." + s.slice(-b) : s; };
        res.json({
            ok: true,
            feed: r.rows.map(x => ({
                name: mask(x.first_name || x.username),
                usd: Number(x.usd),
                method: x.method,
                points: x.amount === null ? null : Number(x.amount),
                fee: x.fee === null ? null : Number(x.fee),
                final: x.final_amount === null ? null : Number(x.final_amount),
                wallet: short(x.address, 6, 4),
                tx: short(x.tx_hash, 8, 6),
                at: x.processed_at
            }))
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/* ========================== BOT WEBHOOK ========================== */

async function registerFromStart(from, payload) {
    const id = String(from.id);
    const ex = await pool.query(`SELECT 1 FROM mr_users WHERE telegram_id = $1`, [id]);
    if (ex.rows.length) return;
    let referredBy = null;
    if (/^\d{4,15}$/.test(payload) && payload !== id) {
        const inv = await pool.query(`SELECT telegram_id FROM mr_users WHERE telegram_id = $1`, [payload]);
        if (inv.rows.length) referredBy = String(inv.rows[0].telegram_id);
    }
    await pool.query(
        `INSERT INTO mr_users(telegram_id, username, first_name, last_name, referral_code, referred_by, last_mined_at)
         VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
        [id, from.username || null, from.first_name || null, from.last_name || null, crypto.randomBytes(8).toString("hex"), referredBy]
    );
}

app.post("/api/telegram-webhook", async (req, res) => {
    if (!WEBHOOK_SECRET || req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
        return res.status(403).json({ ok: false });
    }
    try {
        const msg = req.body?.message;
        if (msg && msg.chat?.type === "private" && msg.from && !msg.from.is_bot && typeof msg.text === "string" && /^\/start/i.test(msg.text)) {
            const payload = (msg.text.split(/\s+/)[1] || "").trim();
            await requireDatabase();
            await registerFromStart(msg.from, payload);
            await telegram("sendMessage", {
                chat_id: msg.chat.id,
                text: `Welcome, ${msg.from.first_name || "miner"}!\n\nMine crypto automatically ($0.1/day base rate). Increase your mining percentage by completing tasks, watching 50 ads (+10%), and inviting friends (+1% each).\n\nTap below to open the mining app:`,
                reply_markup: {
                    inline_keyboard: [[{ text: APP_BUTTON_TEXT, web_app: { url: APP_URL }, style: "primary" }]]
                }
            });
        }
    } catch (e) {
        console.error("webhook err", e.message);
    }
    res.json({ ok: true });
});

/* ============================= FRONTEND & START ============================= */

app.use("/api", (req, res) => {
    res.status(404).json({ ok: false, error: "API route not found." });
});

const BLOCKED_FILES = new Set(["/server.js", "/package.json", "/package-lock.json", "/vercel.json"]);
const staticFiles = express.static(__dirname, { index: false, dotfiles: "deny" });
app.use((req, res, next) => {
    if (BLOCKED_FILES.has(req.path.toLowerCase())) return res.status(404).end();
    staticFiles(req, res, next);
});

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

if (!process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Mining server running on port ${port}`));
}

export default app;
