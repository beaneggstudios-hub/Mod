const fs = require("fs");
const path = require("path");
const { EmbedBuilder } = require("discord.js");

// ==========================================
// ANALYST MODULE - détection d'alts / ban evasion
// ==========================================

const ALERT_THRESHOLD = 50;                       // score minimum pour une alerte
const DEPARTED_RETENTION = 90 * 24 * 60 * 60 * 1000; // on garde les départs 90 jours
const REJOIN_WINDOW = 7 * 24 * 60 * 60 * 1000;    // revenu dans les 7 jours = suspect
const NEW_ACCOUNT_AGE = 14 * 24 * 60 * 60 * 1000; // compte < 14 jours = bonus

function setupAnalyst({ client, dataFolder }) {
    const FILE = path.join(dataFolder, "departed.json");
    let departed = {};

    try {
        if (fs.existsSync(FILE)) departed = JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
    } catch (e) {
        console.error("Failed to load departed.json:", e);
    }

    function save() {
        try { fs.writeFileSync(FILE, JSON.stringify(departed, null, 4)); }
        catch (e) { console.error("Failed to save departed.json:", e); }
    }

    function prune() {
        const limit = Date.now() - DEPARTED_RETENTION;
        for (const id of Object.keys(departed)) {
            if (departed[id].leftAt < limit) delete departed[id];
        }
    }

    // ---------- helpers ----------
    function norm(str) {
        return (str || "")
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]/g, "")
            .replace(/\d+$/, ""); // enlève les chiffres de fin (user123 -> user)
    }

    function levenshtein(a, b) {
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
                );
            }
        }
        return dp[a.length][b.length];
    }

    function similarity(a, b) {
        if (!a || !b) return 0;
        return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    }

    function profileFromUser(user, member) {
        return {
            id: user.id,
            tag: user.tag,
            username: user.username,
            displayName: member?.displayName || user.globalName || user.username,
            avatar: user.avatar || null,
            createdAt: user.createdTimestamp,
            joinedAt: member?.joinedTimestamp || null
        };
    }

    // ---------- scoring ----------
    // `old` = compte parti/banni/autre membre, `cur` = compte suspect
    function scorePair(old, cur) {
        let score = 0;
        const reasons = [];

        if (old.avatar && old.avatar === cur.avatar) {
            score += 40;
            reasons.push("Même avatar personnalisé");
        }

        const a = norm(old.username);
        const b = norm(cur.username);

        if (a.length >= 3 && b.length >= 3) {
            if (a === b) {
                score += 40;
                reasons.push("Pseudo identique (hors chiffres/symboles)");
            } else {
                const sim = similarity(a, b);
                if (sim >= 0.8) {
                    score += 30;
                    reasons.push(`Pseudo très similaire (${Math.round(sim * 100)}%)`);
                }
            }
        }

        const da = norm(old.displayName);
        const db = norm(cur.displayName);
        if (da.length >= 3 && da === db && old.displayName !== old.username) {
            score += 15;
            reasons.push("Même nom d'affichage");
        }

        if (score > 0) {
            if (old.leftAt && cur.joinedAt && cur.joinedAt > old.leftAt &&
                cur.joinedAt - old.leftAt <= REJOIN_WINDOW) {
                score += 15;
                reasons.push("Rejoint peu après le départ de l'ancien compte");
            }

            if (Date.now() - cur.createdAt < NEW_ACCOUNT_AGE) {
                score += 10;
                reasons.push("Compte Discord récent");
            }
        }

        return { score, reasons };
    }

    function buildIndex(profiles) {
        const index = new Map();
        const add = (key, p) => {
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(p);
        };
        for (const p of profiles) {
            if (p.avatar) add("av:" + p.avatar, p);
            const n = norm(p.username);
            if (n.length >= 3) {
                add("nm:" + n, p);
                add("px:" + n.slice(0, 4), p);
            }
            const d = norm(p.displayName);
            if (d.length >= 3) add("dn:" + d, p);
        }
        return index;
    }

    function candidatesFor(index, p) {
        const keys = [];
        if (p.avatar) keys.push("av:" + p.avatar);
        const n = norm(p.username);
        if (n.length >= 3) keys.push("nm:" + n, "px:" + n.slice(0, 4));
        const d = norm(p.displayName);
        if (d.length >= 3) keys.push("dn:" + d);

        const found = new Map();
        for (const k of keys) {
            for (const c of (index.get(k) || []).slice(0, 50)) {
                if (c.id !== p.id) found.set(c.id, c);
            }
        }
        return [...found.values()];
    }

    // ---------- tracking ----------
    client.on("guildMemberRemove", (member) => {
        if (!member.user) return;
        departed[member.id] = {
            ...profileFromUser(member.user, member),
            leftAt: Date.now()
        };
        prune();
        save();
    });

    // Alerte en direct quand quelqu'un rejoint
    client.on("guildMemberAdd", async (member) => {
        try {
            const cur = profileFromUser(member.user, member);
            const banned = await member.guild.bans.fetch().catch(() => null);

            const pool = Object.values(departed).map(d => ({ ...d, source: "A QUITTÉ" }));
            if (banned) {
                for (const ban of banned.values()) {
                    pool.push({ ...profileFromUser(ban.user), source: "BANNI", leftAt: null });
                }
            }

            const index = buildIndex(pool);
            const hits = candidatesFor(index, cur)
                .map(old => ({ old, ...scorePair(old, cur) }))
                .filter(h => h.score >= ALERT_THRESHOLD)
                .sort((a, b) => b.score - a.score);

            if (hits.length === 0) return;

            await sendAlert(member.guild, [{ cur, hits }], "Alerte : possible alt à l'arrivée");
        } catch (e) {
            console.error("Analyst join check error:", e);
        }
    });

    // ---------- alert output ----------
    async function sendAlert(guild, findings, title) {
        const channelId = process.env.ANALYST_CHANNEL_ID;
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (!channel) return false;

        for (const chunk of chunkFindings(findings, 5)) {
            await channel.send({ embeds: [buildEmbed(title, chunk)] }).catch(() => {});
        }
        return true;
    }

    function chunkFindings(findings, size) {
        const out = [];
        for (let i = 0; i < findings.length; i += size) out.push(findings.slice(i, i + size));
        return out;
    }

    function buildEmbed(title, findings) {
        const description = findings.map(({ cur, hits }) => {
            const top = hits.slice(0, 3).map(h =>
                `• **${h.old.source || "MEMBRE"}** ${h.old.tag} (\`${h.old.id}\`) — score **${h.score}**\n` +
                `  ${h.reasons.join(", ")}`
            ).join("\n");
            return `⚠️ <@${cur.id}> (${cur.tag})\n${top}`;
        }).join("\n\n");

        return new EmbedBuilder()
            .setTitle(title)
            .setDescription(description.slice(0, 4000))
            .setColor(0xED4245)
            .setTimestamp();
    }

    // ---------- ?analyst all ----------
    async function handleAnalyst(message, args) {
        if ((args[0] || "").toLowerCase() !== "all") {
            return message.reply("Usage: `?analyst all`");
        }

        const status = await message.reply("🔍 Analyse en cours, cela peut prendre un moment...");

        const guild = message.guild;
        const members = await guild.members.fetch();
        const banned = await guild.bans.fetch().catch(() => null);

        const current = members
            .filter(m => !m.user.bot)
            .map(m => profileFromUser(m.user, m));

        // Pool de comparaison : partis + bannis + autres membres actuels
        const departedPool = Object.values(departed).map(d => ({ ...d, source: "A QUITTÉ" }));
        const bannedPool = banned
            ? [...banned.values()].map(b => ({ ...profileFromUser(b.user), source: "BANNI", leftAt: null }))
            : [];

        const pastIndex = buildIndex([...departedPool, ...bannedPool]);
        const currentIndex = buildIndex(current.map(c => ({ ...c, source: "MEMBRE ACTUEL" })));

        const findings = [];
        const seenPairs = new Set();

        for (const cur of current) {
            const hits = [];

            for (const old of candidatesFor(pastIndex, cur)) {
                const r = scorePair(old, cur);
                if (r.score >= ALERT_THRESHOLD) hits.push({ old, ...r });
            }

            for (const other of candidatesFor(currentIndex, cur)) {
                const key = [cur.id, other.id].sort().join("-");
                if (seenPairs.has(key)) continue;
                seenPairs.add(key);

                const r = scorePair(other, cur);
                // entre deux comptes actifs, on exige un signal plus fort
                if (r.score >= ALERT_THRESHOLD + 10) {
                    hits.push({ old: { ...other, source: "MEMBRE ACTUEL" }, ...r });
                }
            }

            if (hits.length) {
                hits.sort((a, b) => b.score - a.score);
                findings.push({ cur, hits });
            }
        }

        findings.sort((a, b) => b.hits[0].score - a.hits[0].score);

        const summary =
            `✅ Analyse terminée.\n` +
            `**Membres analysés :** ${current.length}\n` +
            `**Anciens comptes comparés :** ${departedPool.length + bannedPool.length}\n` +
            `**Comptes suspects :** ${findings.length}`;

        await status.edit(summary).catch(() => message.reply(summary));

        if (findings.length === 0) return;

        const sentToChannel = await sendAlert(guild, findings.slice(0, 25), "Rapport d'analyse : alts suspects");

        if (!sentToChannel) {
            for (const chunk of chunkFindings(findings.slice(0, 15), 5)) {
                await message.channel.send({ embeds: [buildEmbed("Rapport d'analyse : alts suspects", chunk)] });
            }
        } else {
            await message.channel.send("📨 Le rapport détaillé a été envoyé dans le salon d'alertes.");
        }
    }

    return { handleAnalyst };
}

module.exports = { setupAnalyst };
