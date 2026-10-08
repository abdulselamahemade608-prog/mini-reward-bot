import express from "express";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const app = express();

app.use(express.json());
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});


/* =========================================
   TELEGRAM INIT DATA VALIDATION
========================================= */

function validateTelegramInitData(initData) {

    if (!initData) {
        throw new Error("Missing Telegram initData");
    }

    const params = new URLSearchParams(initData);

    const hash = params.get("hash");

    if (!hash) {
        throw new Error("Missing hash");
    }

    params.delete("hash");

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(process.env.BOT_TOKEN)
        .digest();

    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (calculatedHash !== hash) {
        throw new Error("Invalid Telegram initData");
    }

    const authDate = Number(params.get("auth_date"));

    if (!authDate) {
        throw new Error("Missing auth_date");
    }

    const now = Math.floor(Date.now() / 1000);

    if (now - authDate > 86400) {
        throw new Error("Expired Telegram session");
    }

    const user = JSON.parse(params.get("user"));

    return user;
}


/* =========================================
   AUTH MIDDLEWARE
========================================= */

async function auth(req, res, next) {

    try {

        const initData =
            req.headers["x-telegram-init-data"];

        const telegramUser =
            validateTelegramInitData(initData);

        req.telegramUser = telegramUser;

        next();

    } catch (error) {

        res.status(401).json({
            ok: false,
            error: error.message
        });
    }
}


/* =========================================
   GET /api/me
========================================= */

app.get("/api/me", auth, async (req, res) => {

    try {

        const u = req.telegramUser;

        const result = await pool.query(
            `
            INSERT INTO users
            (
                telegram_id,
                username,
                first_name,
                last_name,
                photo_url,
                referral_code
            )
            VALUES ($1,$2,$3,$4,$5,$6)

            ON CONFLICT (telegram_id)
            DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                photo_url = EXCLUDED.photo_url,
                updated_at = NOW()

            RETURNING *
            `,
            [
                u.id,
                u.username || null,
                u.first_name || "",
                u.last_name || null,
                u.photo_url || null,
                `ref_${u.id}`
            ]
        );

        res.json({
            ok: true,
            user: result.rows[0]
        });

    } catch (error) {

        res.status(500).json({
            ok: false,
            error: "Database error"
        });
    }
});


/* =========================================
   GET LEADERBOARD
========================================= */

app.get("/api/leaderboard", auth, async (req, res) => {

    try {

        const result = await pool.query(`
            SELECT
                telegram_id,
                username,
                first_name,
                photo_url,
                ads_count,
                invite_count,
                points,

                ROW_NUMBER() OVER (
                    ORDER BY points DESC
                ) AS rank

            FROM users

            WHERE is_banned = FALSE

            ORDER BY points DESC

            LIMIT 30
        `);

        res.json({
            ok: true,
            users: result.rows
        });

    } catch {

        res.status(500).json({
            ok: false,
            error: "Leaderboard error"
        });
    }
});


/* =========================================
   PROFILE STATS
========================================= */

app.get("/api/profile", auth, async (req, res) => {

    try {

        const id = req.telegramUser.id;

        const userResult = await pool.query(
            `
            SELECT *
            FROM users
            WHERE telegram_id = $1
            `,
            [id]
        );

        const rankResult = await pool.query(
            `
            SELECT rank
            FROM (
                SELECT
                    telegram_id,
                    ROW_NUMBER() OVER (
                        ORDER BY points DESC
                    ) AS rank
                FROM users
                WHERE is_banned = FALSE
            ) ranked

            WHERE telegram_id = $1
            `,
            [id]
        );

        res.json({
            ok: true,
            user: userResult.rows[0],
            rank: rankResult.rows[0]?.rank || null
        });

    } catch {

        res.status(500).json({
            ok: false,
            error: "Profile error"
        });
    }
});


/* =========================================
   AD REWARD
========================================= */

app.post("/api/ad-reward", auth, async (req, res) => {

    const client = await pool.connect();

    try {

        const telegramId = req.telegramUser.id;

        const rewardToken =
            req.body.rewardToken;

        if (!rewardToken) {

            return res.status(400).json({
                ok: false,
                error: "Missing reward token"
            });
        }

        const setting = await client.query(
            `
            SELECT value
            FROM app_settings
            WHERE key = 'ad_reward'
            `
        );

        const reward =
            Number(setting.rows[0]?.value || 1);

        await client.query("BEGIN");

        const insertReward = await client.query(
            `
            INSERT INTO ad_rewards
            (
                telegram_id,
                reward_points,
                reward_token
            )
            VALUES ($1,$2,$3)

            ON CONFLICT (reward_token)
            DO NOTHING

            RETURNING id
            `,
            [
                telegramId,
                reward,
                rewardToken
            ]
        );

        if (insertReward.rowCount === 0) {

            await client.query("ROLLBACK");

            return res.json({
                ok: false,
                error: "Reward already claimed"
            });
        }

        await client.query(
            `
            UPDATE users

            SET
                ads_count = ads_count + 1,
                total_ads = total_ads + 1,
                points = points + $1,
                updated_at = NOW()

            WHERE telegram_id = $2
            `,
            [
                reward,
                telegramId
            ]
        );

        await client.query("COMMIT");

        res.json({
            ok: true,
            reward
        });

    } catch (error) {

        await client.query("ROLLBACK");

        res.status(500).json({
            ok: false,
            error: "Reward failed"
        });

    } finally {

        client.release();
    }
});


/* =========================================
   HEALTH
========================================= */

app.get("/api/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.json({
            ok: true,
            status: "online"
        });

    } catch {

        res.status(500).json({
            ok: false,
            status: "database_error"
        });
    }
});


app.get("*", (req, res) => {
    res.sendFile(process.cwd() + "/index.html");
});


app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
});
