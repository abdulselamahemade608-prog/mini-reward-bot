import express from "express";
import crypto from "crypto";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const app = express();

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_USERNAME = process.env.BOT_USERNAME || "";
const ADMIN_ID = String(process.env.ADMIN_ID || "");

const DATABASE_URL = process.env.DATABASE_URL || "";

const MINI_APP_URL =
    process.env.MINI_APP_URL ||
    "";

const ADSGRAM_BLOCK_ID =
    process.env.ADSGRAM_BLOCK_ID ||
    "52614";

const REQUIRED_CHANNELS =
    (process.env.REQUIRED_CHANNELS || "")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    })
    : null;


/* =========================================================
   BASIC
========================================================= */

app.get("/api/health", async (req, res) => {

    let database = false;

    try {

        if (pool) {
            await pool.query("SELECT 1");
            database = true;
        }

    } catch (error) {

        database = false;

    }

    res.json({
        ok: true,
        app: "Telegram Reward Mini App",
        database,
        adsgramBlock: ADSGRAM_BLOCK_ID
    });

});


/* =========================================================
   TELEGRAM INIT DATA VALIDATION
========================================================= */

function validateTelegramInitData(initData) {

    if (!initData) {
        throw new Error("Telegram initData missing");
    }

    if (!BOT_TOKEN) {
        throw new Error("BOT_TOKEN is not configured");
    }

    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
        throw new Error("Telegram hash missing");
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    const validHash =
        calculatedHash.length === hash.length &&
        crypto.timingSafeEqual(
            Buffer.from(calculatedHash),
            Buffer.from(hash)
        );

    if (!validHash) {
        throw new Error("Invalid Telegram initData");
    }

    const authDate = Number(params.get("auth_date"));

    if (!authDate) {
        throw new Error("auth_date missing");
    }

    const age = Math.floor(Date.now() / 1000) - authDate;

    // 24 hour maximum age
    if (age > 86400) {
        throw new Error("Telegram initData expired");
    }

    const userRaw = params.get("user");

    if (!userRaw) {
        throw new Error("Telegram user missing");
    }

    const user = JSON.parse(userRaw);

    if (!user.id) {
        throw new Error("Telegram user ID missing");
    }

    return user;
}


/* =========================================================
   AUTH MIDDLEWARE
========================================================= */

async function authenticate(req, res, next) {

    try {

        const initData =
            req.headers["x-telegram-init-data"];

        const user =
            validateTelegramInitData(initData);

        req.telegramUser = user;

        next();

    } catch (error) {

        return res.status(401).json({
            ok: false,
            error: error.message
        });

    }

}


/* =========================================================
   TELEGRAM BOT API
========================================================= */

async function telegram(method, body = {}) {

    if (!BOT_TOKEN) {
        throw new Error("BOT_TOKEN is not configured");
    }

    const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        }
    );

    const data = await response.json();

    if (!data.ok) {
        throw new Error(
            data.description || "Telegram API error"
        );
    }

    return data.result;
}


/* =========================================================
   CHANNEL MEMBERSHIP
========================================================= */

async function checkChannelMembership(
    telegramId,
    channel
) {

    try {

        const member = await telegram(
            "getChatMember",
            {
                chat_id: channel,
                user_id: telegramId
            }
        );

        const allowed = [
            "creator",
            "administrator",
            "member"
        ];

        return {
            channel,
            joined: allowed.includes(member.status),
            status: member.status
        };

    } catch (error) {

        return {
            channel,
            joined: false,
            status: "unknown",
            error: error.message
        };

    }
}


async function checkAllChannels(telegramId) {

    const results = [];

    for (const channel of REQUIRED_CHANNELS) {

        const result =
            await checkChannelMembership(
                telegramId,
                channel
            );

        results.push(result);

    }

    return results;
}


/* =========================================================
   DATABASE USER
========================================================= */

async function createOrUpdateUser(
    telegramUser,
    referralCode = null
) {

    if (!pool) {
        throw new Error("DATABASE_URL is not configured");
    }

    const telegramId =
        String(telegramUser.id);

    const existing =
        await pool.query(
            `
            SELECT *
            FROM users
            WHERE telegram_id = $1
            `,
            [telegramId]
        );

    if (existing.rows.length > 0) {

        await pool.query(
            `
            UPDATE users
            SET
                username = $2,
                first_name = $3,
                last_name = $4,
                photo_url = $5,
                updated_at = NOW()
            WHERE telegram_id = $1
            `,
            [
                telegramId,
                telegramUser.username || null,
                telegramUser.first_name || null,
                telegramUser.last_name || null,
                telegramUser.photo_url || null
            ]
        );

        return existing.rows[0];
    }

    const generatedCode =
        `u${telegramId}`;

    let referredBy = null;

    if (referralCode) {

        const inviter =
            await pool.query(
                `
                SELECT telegram_id
                FROM users
                WHERE referral_code = $1
                `,
                [referralCode]
            );

        if (
            inviter.rows.length > 0 &&
            String(inviter.rows[0].telegram_id) !== telegramId
        ) {
            referredBy =
                String(inviter.rows[0].telegram_id);
        }
    }

    const result =
        await pool.query(
            `
            INSERT INTO users(
                telegram_id,
                username,
                first_name,
                last_name,
                photo_url,
                referral_code,
                referred_by
            )
            VALUES(
                $1,$2,$3,$4,$5,$6,$7
            )
            RETURNING *
            `,
            [
                telegramId,
                telegramUser.username || null,
                telegramUser.first_name || null,
                telegramUser.last_name || null,
                telegramUser.photo_url || null,
                generatedCode,
                referredBy
            ]
        );

    return result.rows[0];
}


/* =========================================================
   REFERRAL PROCESSING
========================================================= */

async function processReferral(userId) {

    if (!pool) return;

    const userResult =
        await pool.query(
            `
            SELECT referred_by
            FROM users
            WHERE telegram_id = $1
            `,
            [userId]
        );

    if (
        userResult.rows.length === 0 ||
        !userResult.rows[0].referred_by
    ) {
        return;
    }

    const inviterId =
        String(userResult.rows[0].referred_by);

    const already =
        await pool.query(
            `
            SELECT id
            FROM referrals
            WHERE invited_id = $1
            `,
            [userId]
        );

    if (already.rows.length > 0) {
        return;
    }

    const setting =
        await pool.query(
            `
            SELECT value
            FROM app_settings
            WHERE key = 'invite_reward'
            `
        );

    const reward =
        Number(setting.rows[0]?.value || 1);

    await pool.query("BEGIN");

    try {

        await pool.query(
            `
            INSERT INTO referrals(
                inviter_id,
                invited_id,
                reward
            )
            VALUES($1,$2,$3)
            `,
            [
                inviterId,
                userId,
                reward
            ]
        );

        await pool.query(
            `
            UPDATE users
            SET
                invite_count = invite_count + 1,
                total_invites = total_invites + 1,
                points = points + $2,
                updated_at = NOW()
            WHERE telegram_id = $1
            `,
            [
                inviterId,
                reward
            ]
        );

        await pool.query("COMMIT");

    } catch (error) {

        await pool.query("ROLLBACK");

        throw error;

    }
}


/* =========================================================
   /api/me
========================================================= */

app.get(
    "/api/me",
    authenticate,
    async (req, res) => {

        try {

            const telegramUser =
                req.telegramUser;

            const startParam =
                req.query.ref || null;

            await createOrUpdateUser(
                telegramUser,
                startParam
            );

            await processReferral(
                String(telegramUser.id)
            );

            const userResult =
                await pool.query(
                    `
                    SELECT *
                    FROM users
                    WHERE telegram_id = $1
                    `,
                    [String(telegramUser.id)]
                );

            const user =
                userResult.rows[0];

            const channels =
                await checkAllChannels(
                    String(telegramUser.id)
                );

            const allJoined =
                channels.length === 0 ||
                channels.every(x => x.joined);

            await pool.query(
                `
                UPDATE users
                SET is_verified = $2,
                    updated_at = NOW()
                WHERE telegram_id = $1
                `,
                [
                    String(telegramUser.id),
                    allJoined
                ]
            );

            const rankResult =
                await pool.query(
                    `
                    SELECT COUNT(*) + 1 AS rank
                    FROM users
                    WHERE points > $1
                    `,
                    [user.points]
                );

            res.json({
                ok: true,

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

                    points: user.points,

                    referral_code:
                        user.referral_code,

                    rank:
                        Number(rankResult.rows[0].rank),

                    is_verified:
                        allJoined,

                    is_admin:
                        String(user.telegram_id) ===
                        ADMIN_ID
                },

                channels,

                allJoined,

                adsgram: {
                    blockId: ADSGRAM_BLOCK_ID
                }
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   CHANNEL CHECK
========================================================= */

app.get(
    "/api/channels",
    authenticate,
    async (req, res) => {

        try {

            const channels =
                await checkAllChannels(
                    String(req.telegramUser.id)
                );

            res.json({
                ok: true,
                channels,
                allJoined:
                    channels.length === 0 ||
                    channels.every(x => x.joined)
            });

        } catch (error) {

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   ADS REWARD
========================================================= */

app.post(
    "/api/ad-reward",
    authenticate,
    async (req, res) => {

        const telegramId =
            String(req.telegramUser.id);

        const rewardKey =
            String(req.body.rewardKey || "");

        if (!rewardKey) {

            return res.status(400).json({
                ok: false,
                error: "rewardKey required"
            });

        }

        try {

            const channels =
                await checkAllChannels(
                    telegramId
                );

            const allJoined =
                channels.length === 0 ||
                channels.every(x => x.joined);

            if (!allJoined) {

                return res.status(403).json({
                    ok: false,
                    error: "Join all required channels first"
                });

            }

            const duplicate =
                await pool.query(
                    `
                    SELECT id
                    FROM ad_rewards
                    WHERE reward_key = $1
                    `,
                    [rewardKey]
                );

            if (duplicate.rows.length > 0) {

                return res.status(409).json({
                    ok: false,
                    error: "Reward already claimed"
                });

            }

            const setting =
                await pool.query(
                    `
                    SELECT value
                    FROM app_settings
                    WHERE key = 'max_ads_per_day'
                    `
                );

            const maxAds =
                Number(
                    setting.rows[0]?.value || 100
                );

            const today =
                await pool.query(
                    `
                    SELECT COUNT(*)::int AS count
                    FROM ad_rewards
                    WHERE telegram_id = $1
                    AND created_at >= CURRENT_DATE
                    `,
                    [telegramId]
                );

            if (
                today.rows[0].count >= maxAds
            ) {

                return res.status(429).json({
                    ok: false,
                    error:
                        "Daily ad limit reached"
                });

            }

            const rewardSetting =
                await pool.query(
                    `
                    SELECT value
                    FROM app_settings
                    WHERE key = 'ad_reward'
                    `
                );

            const reward =
                Number(
                    rewardSetting.rows[0]?.value || 1
                );

            await pool.query("BEGIN");

            try {

                await pool.query(
                    `
                    INSERT INTO ad_rewards(
                        telegram_id,
                        reward,
                        reward_key
                    )
                    VALUES($1,$2,$3)
                    `,
                    [
                        telegramId,
                        reward,
                        rewardKey
                    ]
                );

                await pool.query(
                    `
                    UPDATE users
                    SET
                        ads_count = ads_count + 1,
                        total_ads = total_ads + 1,
                        points = points + $2,
                        updated_at = NOW()
                    WHERE telegram_id = $1
                    `,
                    [
                        telegramId,
                        reward
                    ]
                );

                await pool.query("COMMIT");

            } catch (error) {

                await pool.query("ROLLBACK");

                throw error;

            }

            const updated =
                await pool.query(
                    `
                    SELECT points,
                           ads_count,
                           total_ads
                    FROM users
                    WHERE telegram_id = $1
                    `,
                    [telegramId]
                );

            res.json({
                ok: true,
                reward,
                user: updated.rows[0]
            });

        } catch (error) {

            console.error(error);

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   LEADERBOARD
========================================================= */

app.get(
    "/api/leaderboard",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        telegram_id,
                        username,
                        first_name,
                        last_name,
                        photo_url,
                        points,
                        total_ads,
                        total_invites
                    FROM users
                    WHERE is_banned = FALSE
                    ORDER BY points DESC, created_at ASC
                    LIMIT 30
                    `
                );

            const leaderboard =
                result.rows.map(
                    (user, index) => ({
                        rank: index + 1,
                        telegram_id:
                            user.telegram_id,
                        username:
                            user.username,
                        first_name:
                            user.first_name,
                        last_name:
                            user.last_name,
                        photo_url:
                            user.photo_url,
                        points:
                            user.points,
                        ads:
                            user.total_ads,
                        invites:
                            user.total_invites
                    })
                );

            res.json({
                ok: true,
                leaderboard
            });

        } catch (error) {

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   REWARDS
========================================================= */

app.get(
    "/api/rewards",
    authenticate,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM rewards
                    WHERE enabled = TRUE
                    ORDER BY position ASC
                    `
                );

            res.json({
                ok: true,
                rewards: result.rows
            });

        } catch (error) {

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   ADMIN AUTH
========================================================= */

function isAdmin(req) {

    return (
        String(req.telegramUser.id) ===
        ADMIN_ID
    );

}


function requireAdmin(req, res, next) {

    if (!isAdmin(req)) {

        return res.status(403).json({
            ok: false,
            error: "Admin only"
        });

    }

    next();
}


/* =========================================================
   ADMIN SETTINGS
========================================================= */

app.post(
    "/api/admin/settings",
    authenticate,
    requireAdmin,
    async (req, res) => {

        try {

            const {
                ad_reward,
                invite_reward,
                max_ads_per_day
            } = req.body;

            const settings = {
                ad_reward,
                invite_reward,
                max_ads_per_day
            };

            for (
                const [key, value]
                of Object.entries(settings)
            ) {

                if (
                    value !== undefined &&
                    value !== null
                ) {

                    await pool.query(
                        `
                        INSERT INTO app_settings(
                            key,
                            value
                        )
                        VALUES($1,$2)
                        ON CONFLICT(key)
                        DO UPDATE SET
                            value = EXCLUDED.value,
                            updated_at = NOW()
                        `,
                        [
                            key,
                            String(value)
                        ]
                    );

                }

            }

            await pool.query(
                `
                INSERT INTO admin_logs(
                    admin_id,
                    action,
                    details
                )
                VALUES($1,$2,$3)
                `,
                [
                    ADMIN_ID,
                    "update_settings",
                    JSON.stringify(settings)
                ]
            );

            res.json({
                ok: true
            });

        } catch (error) {

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   ADMIN REWARDS
========================================================= */

app.post(
    "/api/admin/reward",
    authenticate,
    requireAdmin,
    async (req, res) => {

        try {

            const {
                position,
                title,
                description,
                enabled
            } = req.body;

            if (!position || !title) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "position and title required"
                });

            }

            await pool.query(
                `
                INSERT INTO rewards(
                    position,
                    title,
                    description,
                    enabled,
                    updated_at
                )
                VALUES($1,$2,$3,$4,NOW())
                ON CONFLICT(position)
                DO UPDATE SET
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                `,
                [
                    Number(position),
                    String(title),
                    String(description || ""),
                    enabled !== false
                ]
            );

            await pool.query(
                `
                INSERT INTO admin_logs(
                    admin_id,
                    action,
                    details
                )
                VALUES($1,$2,$3)
                `,
                [
                    ADMIN_ID,
                    "update_reward",
                    JSON.stringify(req.body)
                ]
            );

            res.json({
                ok: true
            });

        } catch (error) {

            res.status(500).json({
                ok: false,
                error: error.message
            });

        }

    }
);


/* =========================================================
   FRONTEND
========================================================= */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(__dirname, "index.html")
    );

});


app.use(
    express.static(__dirname)
);


app.listen(PORT, () => {

    console.log(
        `Server running on port ${PORT}`
    );

});
