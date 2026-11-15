const {
    Client,
    GatewayIntentBits,
    EmbedBuilder
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const http = require("http");

require("dotenv").config();

// ==========================================
// MAIN CONFIGURATION
// ==========================================

const PREFIX = "?";
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error("ERROR: DISCORD_TOKEN is missing from environment variables.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration
    ]
});

// ==========================================
// STAFF ROLES
// ==========================================

const STAFF_ROLES = {
    OWNER: process.env.OWNER_ROLE_ID,
    SUPERVISOR: process.env.SUPERVISOR_ROLE_ID,
    SENIOR_MODERATOR: process.env.SENIOR_MODERATOR_ROLE_ID,
    MODERATOR: process.env.MODERATOR_ROLE_ID,
    TRIAL_MODERATOR: process.env.TRIAL_MODERATOR_ROLE_ID
};

const RANK_LEVELS = {
    OWNER: 5,
    SUPERVISOR: 4,
    SENIOR_MODERATOR: 3,
    MODERATOR: 2,
    TRIAL_MODERATOR: 1
};

const ACTION_LIMITS = {
    OWNER: Infinity,
    SUPERVISOR: 30,
    SENIOR_MODERATOR: 20,
    MODERATOR: 12,
    TRIAL_MODERATOR: 5
};

const LIMIT_DURATION = 10 * 60 * 60 * 1000;

// ==========================================
// DATA FILES
// ==========================================

const DATA_FOLDER = path.join(__dirname, "data");

if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
}

const LIMITS_FILE = path.join(DATA_FOLDER, "limits.json");
const WARNINGS_FILE = path.join(DATA_FOLDER, "warnings.json");
const SANCTIONS_FILE = path.join(DATA_FOLDER, "sanctions.json");
const DEPARTED_FILE = path.join(DATA_FOLDER, "departed.json");

function loadJSON(file, defaultValue = {}) {
    try {
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(defaultValue, null, 4));
            return defaultValue;
        }

        const content = fs.readFileSync(file, "utf8");

        if (!content.trim()) {
            return defaultValue;
        }

        return JSON.parse(content);
    } catch (error) {
        console.error(`Failed to load ${path.basename(file)}:`, error);
        return defaultValue;
    }
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 4));
    } catch (error) {
        console.error(`Failed to save ${path.basename(file)}:`, error);
    }
}

// ==========================================
// DATABASES
// ==========================================

let limitsData = {};
let warningsData = {};
let sanctionsData = {};
let departedData = {};

function loadAllData() {
    limitsData = loadJSON(LIMITS_FILE, {});
    warningsData = loadJSON(WARNINGS_FILE, {});
    sanctionsData = loadJSON(SANCTIONS_FILE, {});
    departedData = loadJSON(DEPARTED_FILE, {});

    console.log("All moderation databases loaded.");
}

function saveAllData() {
    saveJSON(LIMITS_FILE, limitsData);
    saveJSON(WARNINGS_FILE, warningsData);
    saveJSON(SANCTIONS_FILE, sanctionsData);
    saveJSON(DEPARTED_FILE, departedData);
}

// ==========================================
// STAFF RANK SYSTEM
// ==========================================

function getStaffRank(member) {
    if (!member) return null;

    if (STAFF_ROLES.OWNER && member.roles.cache.has(STAFF_ROLES.OWNER)) {
        return "OWNER";
    }

    if (STAFF_ROLES.SUPERVISOR && member.roles.cache.has(STAFF_ROLES.SUPERVISOR)) {
        return "SUPERVISOR";
    }

    if (
        STAFF_ROLES.SENIOR_MODERATOR &&
        member.roles.cache.has(STAFF_ROLES.SENIOR_MODERATOR)
    ) {
        return "SENIOR_MODERATOR";
    }

    if (STAFF_ROLES.MODERATOR && member.roles.cache.has(STAFF_ROLES.MODERATOR)) {
        return "MODERATOR";
    }

    if (
        STAFF_ROLES.TRIAL_MODERATOR &&
        member.roles.cache.has(STAFF_ROLES.TRIAL_MODERATOR)
    ) {
        return "TRIAL_MODERATOR";
    }

    return null;
}

function hasPermission(rank, minimumRank) {
    if (!rank || !RANK_LEVELS[rank]) return false;

    return RANK_LEVELS[rank] >= RANK_LEVELS[minimumRank];
}

// ==========================================
// MODERATION HISTORY
// ==========================================

function addSanction(targetId, type, moderatorId, reason) {
    if (!sanctionsData[targetId]) {
        sanctionsData[targetId] = [];
    }

    sanctionsData[targetId].push({
        type,
        moderatorId,
        reason: reason || "No reason provided",
        timestamp: Date.now()
    });

    saveJSON(SANCTIONS_FILE, sanctionsData);
}

function addWarning(targetId, moderatorId, reason) {
    if (!warningsData[targetId]) {
        warningsData[targetId] = [];
    }

    const warning = {
        moderatorId,
        reason: reason || "No reason provided",
        timestamp: Date.now()
    };

    warningsData[targetId].push(warning);

    addSanction(
        targetId,
        "WARN",
        moderatorId,
        reason
    );

    saveJSON(WARNINGS_FILE, warningsData);

    return warning;
}

// ==========================================
// GENERAL UTILITIES
// ==========================================

function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short"
    });
}

function getUserId(input) {
    if (!input) return null;

    const mention = input.match(/^<@!?(\d+)>$/);

    if (mention) return mention[1];

    if (/^\d{17,20}$/.test(input)) return input;

    return null;
}

function createEmbed(title, description, color = 0x2B2D31) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

function isStaff(member) {
    return Boolean(getStaffRank(member));
}

// ==========================================
// STAFF ACTION LIMITS
// ==========================================

function getStaffUsage(userId) {
    const now = Date.now();
    let record = limitsData[userId];

    if (!record || now >= record.resetAt) {
        record = {
            count: 0,
            resetAt: now + LIMIT_DURATION
        };

        limitsData[userId] = record;
        saveJSON(LIMITS_FILE, limitsData);
    }

    return record;
}

function getRemainingActions(rank, userId) {
    if (rank === "OWNER") return Infinity;

    const limit = ACTION_LIMITS[rank];
    const usage = getStaffUsage(userId);

    return Math.max(0, limit - usage.count);
}

async function runLimitedAction(
    message,
    rank,
    target,
    type,
    reason,
    perform
) {
    const limit = ACTION_LIMITS[rank];

    if (limit !== Infinity) {
        const usage = getStaffUsage(message.author.id);

        if (usage.count >= limit) {
            return message.reply(
                `You have reached your ${limit} moderation actions limit.`
            );
        }

        usage.count++;
        saveJSON(LIMITS_FILE, limitsData);
    }

    try {
        await perform();

        if (type !== "WARN") {
            addSanction(
                target.id,
                type,
                message.author.id,
                reason
            );
        }

        const embed = createEmbed(
            "Moderation Action",
            `**Action:** ${type}\n` +
            `**Member:** ${target.user?.tag || target.tag || target.id}\n` +
            `**Moderator:** ${message.author.tag}\n` +
            `**Reason:** ${reason}`,
            0x57F287
        );

        await message.reply({ embeds: [embed] });

    } catch (error) {
        console.error(`Moderation error (${type}):`, error);

        const usage = getStaffUsage(message.author.id);

        if (limit !== Infinity && usage.count > 0) {
            usage.count--;
            saveJSON(LIMITS_FILE, limitsData);
        }

        await message.reply(
            "An error occurred while executing this moderation action."
        );
    }
}

// ==========================================
// ARGUMENT HELPERS
// ==========================================

function getTargetFromMessage(message, args) {
    const targetId = getUserId(args[0]);

    if (!targetId) return null;

    return message.guild.members.cache.get(targetId) || null;
}

function getReason(args, startIndex = 1) {
    return args.slice(startIndex).join(" ") || "No reason provided";
}

async function checkStaff(message, minimumRank = "TRIAL_MODERATOR") {
    const rank = getStaffRank(message.member);

    if (!rank || !hasPermission(rank, minimumRank)) {
        await message.reply("You do not have permission to use this command.");
        return null;
    }

    return rank;
}

// ==========================================
// ANALYST SYSTEM - ALT ACCOUNT DETECTION
// ?analyst all
// ==========================================

const ANALYST_ALERT_THRESHOLD = 50;                          // Minimum score to raise an alert
const ANALYST_DEPARTED_RETENTION = 90 * 24 * 60 * 60 * 1000; // Departed members are kept for 90 days
const ANALYST_REJOIN_WINDOW = 7 * 24 * 60 * 60 * 1000;       // Rejoin within 7 days is suspicious
const ANALYST_NEW_ACCOUNT_AGE = 14 * 24 * 60 * 60 * 1000;    // Accounts younger than 14 days

function pruneDeparted() {
    const limit = Date.now() - ANALYST_DEPARTED_RETENTION;

    for (const id of Object.keys(departedData)) {
        if (departedData[id].leftAt < limit) {
            delete departedData[id];
        }
    }
}

function normalizeName(str) {
    return (str || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]/g, "")
        .replace(/\d+$/, ""); // Strip trailing digits (user123 -> user)
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

function nameSimilarity(a, b) {
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

// `old` = previous account (left / banned / other member), `cur` = account under review
function scorePair(old, cur) {
    let score = 0;
    const reasons = [];

    if (old.avatar && old.avatar === cur.avatar) {
        score += 40;
        reasons.push("Identical custom avatar");
    }

    const a = normalizeName(old.username);
    const b = normalizeName(cur.username);

    if (a.length >= 3 && b.length >= 3) {
        if (a === b) {
            score += 40;
            reasons.push("Identical username (ignoring digits and symbols)");
        } else {
            const sim = nameSimilarity(a, b);

            if (sim >= 0.8) {
                score += 30;
                reasons.push(`Highly similar username (${Math.round(sim * 100)}%)`);
            }
        }
    }

    const da = normalizeName(old.displayName);
    const db = normalizeName(cur.displayName);

    if (da.length >= 3 && da === db && old.displayName !== old.username) {
        score += 15;
        reasons.push("Identical display name");
    }

    if (score > 0) {
        if (
            old.leftAt &&
            cur.joinedAt &&
            cur.joinedAt > old.leftAt &&
            cur.joinedAt - old.leftAt <= ANALYST_REJOIN_WINDOW
        ) {
            score += 15;
            reasons.push("Joined shortly after the previous account left");
        }

        if (Date.now() - cur.createdAt < ANALYST_NEW_ACCOUNT_AGE) {
            score += 10;
            reasons.push("Recently created Discord account");
        }
    }

    return { score, reasons };
}

function buildIndex(profiles) {
    const index = new Map();

    const add = (key, profile) => {
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(profile);
    };

    for (const p of profiles) {
        if (p.avatar) add("av:" + p.avatar, p);

        const n = normalizeName(p.username);

        if (n.length >= 3) {
            add("nm:" + n, p);
            add("px:" + n.slice(0, 4), p);
        }

        const d = normalizeName(p.displayName);

        if (d.length >= 3) add("dn:" + d, p);
    }

    return index;
}

function candidatesFor(index, p) {
    const keys = [];

    if (p.avatar) keys.push("av:" + p.avatar);

    const n = normalizeName(p.username);

    if (n.length >= 3) keys.push("nm:" + n, "px:" + n.slice(0, 4));

    const d = normalizeName(p.displayName);

    if (d.length >= 3) keys.push("dn:" + d);

    const found = new Map();

    for (const key of keys) {
        for (const candidate of (index.get(key) || []).slice(0, 50)) {
            if (candidate.id !== p.id) found.set(candidate.id, candidate);
        }
    }

    return [...found.values()];
}

function chunkFindings(findings, size) {
    const out = [];

    for (let i = 0; i < findings.length; i += size) {
        out.push(findings.slice(i, i + size));
    }

    return out;
}

function buildAnalystEmbed(title, findings) {
    const description = findings.map(({ cur, hits }) => {
        const top = hits.slice(0, 3).map(h =>
            `- **${h.old.source || "MEMBER"}:** ${h.old.tag} (\`${h.old.id}\`) | Score: **${h.score}**\n` +
            `  ${h.reasons.join("; ")}`
        ).join("\n");

        return `**Flagged account:** <@${cur.id}> (${cur.tag})\n${top}`;
    }).join("\n\n");

    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description.slice(0, 4000))
        .setColor(0xED4245)
        .setTimestamp();
}

async function sendAnalystAlert(guild, findings, title) {
    const channelId = process.env.ANALYST_CHANNEL_ID;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;

    if (!channel) return false;

    for (const chunk of chunkFindings(findings, 5)) {
        await channel.send({ embeds: [buildAnalystEmbed(title, chunk)] }).catch(() => {});
    }

    return true;
}

// Record members who leave the server
client.on("guildMemberRemove", (member) => {
    if (!member.user) return;

    departedData[member.id] = {
        ...profileFromUser(member.user, member),
        leftAt: Date.now()
    };

    pruneDeparted();
    saveJSON(DEPARTED_FILE, departedData);
});

// Automatic alert when a new member joins
client.on("guildMemberAdd", async (member) => {
    try {
        if (member.user.bot) return;

        const cur = profileFromUser(member.user, member);
        const banned = await member.guild.bans.fetch().catch(() => null);

        const pool = Object.values(departedData).map(d => ({ ...d, source: "LEFT SERVER" }));

        if (banned) {
            for (const ban of banned.values()) {
                pool.push({
                    ...profileFromUser(ban.user),
                    source: "BANNED",
                    leftAt: null
                });
            }
        }

        const index = buildIndex(pool);

        const hits = candidatesFor(index, cur)
            .map(old => ({ old, ...scorePair(old, cur) }))
            .filter(h => h.score >= ANALYST_ALERT_THRESHOLD)
            .sort((a, b) => b.score - a.score);

        if (hits.length === 0) return;

        await sendAnalystAlert(
            member.guild,
            [{ cur, hits }],
            "Alt Account Alert - New Member"
        );
    } catch (error) {
        console.error("Analyst join check error:", error);
    }
});

async function handleAnalyst(message, args) {
    if ((args[0] || "").toLowerCase() !== "all") {
        return message.reply("Usage: `?analyst all`");
    }

    const status = await message.reply("Analysis in progress. This may take a moment.");

    const guild = message.guild;
    const members = await guild.members.fetch();
    const banned = await guild.bans.fetch().catch(() => null);

    const current = members
        .filter(m => !m.user.bot)
        .map(m => profileFromUser(m.user, m));

    const departedPool = Object.values(departedData).map(d => ({ ...d, source: "LEFT SERVER" }));

    const bannedPool = banned
        ? [...banned.values()].map(b => ({
            ...profileFromUser(b.user),
            source: "BANNED",
            leftAt: null
        }))
        : [];

    const pastIndex = buildIndex([...departedPool, ...bannedPool]);
    const currentIndex = buildIndex(current.map(c => ({ ...c, source: "CURRENT MEMBER" })));

    const findings = [];
    const seenPairs = new Set();

    for (const cur of current) {
        const hits = [];

        // Compare against previous accounts (left / banned)
        for (const old of candidatesFor(pastIndex, cur)) {
            const result = scorePair(old, cur);

            if (result.score >= ANALYST_ALERT_THRESHOLD) {
                hits.push({ old, ...result });
            }
        }

        // Compare against other current members (stricter threshold)
        for (const other of candidatesFor(currentIndex, cur)) {
            const key = [cur.id, other.id].sort().join("-");

            if (seenPairs.has(key)) continue;
            seenPairs.add(key);

            const result = scorePair(other, cur);

            if (result.score >= ANALYST_ALERT_THRESHOLD + 10) {
                hits.push({ old: { ...other, source: "CURRENT MEMBER" }, ...result });
            }
        }

        if (hits.length) {
            hits.sort((a, b) => b.score - a.score);
            findings.push({ cur, hits });
        }
    }

    findings.sort((a, b) => b.hits[0].score - a.hits[0].score);

    const summary =
        `**Analysis complete.**\n` +
        `Members analyzed: ${current.length}\n` +
        `Previous accounts compared: ${departedPool.length + bannedPool.length}\n` +
        `Suspicious accounts found: ${findings.length}`;

    await status.edit(summary).catch(() => message.reply(summary));

    if (findings.length === 0) return;

    const sentToChannel = await sendAnalystAlert(
        guild,
        findings.slice(0, 25),
        "Analysis Report - Suspected Alt Accounts"
    );

    if (!sentToChannel) {
        for (const chunk of chunkFindings(findings.slice(0, 15), 5)) {
            await message.channel.send({
                embeds: [buildAnalystEmbed("Analysis Report - Suspected Alt Accounts", chunk)]
            });
        }
    } else {
        await message.channel.send("The detailed report has been sent to the alert channel.");
    }
}

// ==========================================
// BAN COMMAND (by ID, even if not in the server)
// ?ban @member|USER_ID reason
// ?ipban @member|USER_ID reason  (alias)
// ==========================================

async function handleBan(message, args, rank) {
    if (!args[0]) {
        return message.reply("Usage: `?ban @member|USER_ID [reason]`");
    }

    const targetId = getUserId(args[0]);

    if (!targetId) {
        return message.reply("Please provide a valid mention or user ID.");
    }

    if (targetId === message.author.id) {
        return message.reply("You cannot ban yourself.");
    }

    if (targetId === client.user.id) {
        return message.reply("I cannot ban myself.");
    }

    // Already banned?
    const existingBan = await message.guild.bans.fetch(targetId).catch(() => null);

    if (existingBan) {
        return message.reply("This user is already banned.");
    }

    // Is the member in the server? (if not, ban by ID anyway)
    const member = await message.guild.members.fetch(targetId).catch(() => null);

    if (member) {
        if (!member.bannable) {
            return message.reply("I cannot ban this member. Check my role position and permissions.");
        }

        if (
            rank !== "OWNER" &&
            message.member.roles.highest.position <= member.roles.highest.position
        ) {
            return message.reply("You cannot ban a member with an equal or higher role than yours.");
        }
    }

    // Fetch the Discord user (even if not in the server)
    const user = await client.users.fetch(targetId).catch(() => null);

    if (!user) {
        return message.reply("This user ID does not exist on Discord.");
    }

    const reason = getReason(args);

    await runLimitedAction(
        message,
        rank,
        user,
        "BAN",
        reason,
        async () => {
            await message.guild.members.ban(targetId, { reason });
        }
    );
}

// ==========================================
// KICK COMMAND
// ?kick @member reason
// ==========================================

async function handleKick(message, args, rank) {
    if (!args[0]) {
        return message.reply("Usage: `?kick @member [reason]`");
    }

    const target = getTargetFromMessage(message, args);

    if (!target) {
        return message.reply("Member not found in this server.");
    }

    if (target.id === message.author.id) {
        return message.reply("You cannot kick yourself.");
    }

    if (!target.kickable) {
        return message.reply("I cannot kick this member. Check my role position and permissions.");
    }

    const reason = getReason(args);

    await runLimitedAction(
        message,
        rank,
        target,
        "KICK",
        reason,
        async () => {
            await target.kick(reason);
        }
    );
}

// ==========================================
// MUTE COMMAND
// ?mute @member duration reason
// ==========================================

function parseDuration(input) {
    if (!input) return null;

    const match = input.match(/^(\d+)(s|m|h|d)$/i);

    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();

    const multipliers = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000
    };

    return amount * multipliers[unit];
}

async function handleMute(message, args, rank) {
    if (!args[0] || !args[1]) {
        return message.reply(
            "Usage: `?mute @member 10m [reason]`"
        );
    }

    const target = getTargetFromMessage(message, args);

    if (!target) {
        return message.reply("Member not found in this server.");
    }

    if (target.id === message.author.id) {
        return message.reply("You cannot mute yourself.");
    }

    if (!target.moderatable) {
        return message.reply("I cannot timeout this member.");
    }

    const duration = parseDuration(args[1]);

    if (!duration || duration > 28 * 24 * 60 * 60 * 1000) {
        return message.reply(
            "Invalid duration. Use `10m`, `2h`, or `1d` (maximum 28 days)."
        );
    }

    const reason = getReason(args, 2);

    await runLimitedAction(
        message,
        rank,
        target,
        "MUTE",
        reason,
        async () => {
            await target.timeout(duration, reason);
        }
    );
}

// ==========================================
// WARN COMMAND
// ?warn @member reason
// ==========================================

async function handleWarn(message, args, rank) {
    if (!args[0]) {
        return message.reply("Usage: `?warn @member [reason]`");
    }

    const target = getTargetFromMessage(message, args);

    if (!target) {
        return message.reply("Member not found in this server.");
    }

    if (target.id === message.author.id) {
        return message.reply("You cannot warn yourself.");
    }

    const reason = getReason(args);

    await runLimitedAction(
        message,
        rank,
        target,
        "WARN",
        reason,
        async () => {
            addWarning(
                target.id,
                message.author.id,
                reason
            );
        }
    );
}

// ==========================================
// UNBAN COMMAND
// ?unban USER_ID reason
// ==========================================

async function handleUnban(message, args, rank) {
    if (!args[0]) {
        return message.reply("Usage: `?unban USER_ID [reason]`");
    }

    const userId = getUserId(args[0]);

    if (!userId) {
        return message.reply("Please provide a valid user ID.");
    }

    const reason = getReason(args);

    try {
        await message.guild.members.unban(userId, reason);

        await message.reply({
            embeds: [
                createEmbed(
                    "Member Unbanned",
                    `**User ID:** ${userId}\n` +
                    `**Moderator:** ${message.author.tag}\n` +
                    `**Reason:** ${reason}`,
                    0x57F287
                )
            ]
        });

    } catch (error) {
        console.error("Unban error:", error);
        await message.reply("Could not unban this user. They may not be banned.");
    }
}

// ==========================================
// UNMUTE COMMAND
// ?unmute @member
// ==========================================

async function handleUnmute(message, args, rank) {
    if (!args[0]) {
        return message.reply("Usage: `?unmute @member`");
    }

    const target = getTargetFromMessage(message, args);

    if (!target) {
        return message.reply("Member not found in this server.");
    }

    if (!target.moderatable) {
        return message.reply("I cannot remove this member's timeout.");
    }

    try {
        await target.timeout(null, `Unmuted by ${message.author.tag}`);

        await message.reply({
            embeds: [
                createEmbed(
                    "Member Unmuted",
                    `**Member:** ${target.user.tag}\n` +
                    `**Moderator:** ${message.author.tag}`,
                    0x57F287
                )
            ]
        });

    } catch (error) {
        console.error("Unmute error:", error);
        await message.reply("Could not unmute this member.");
    }
}

// ==========================================
// MANAGEMEMBER COMMAND
// ?managemember @member
// ==========================================

async function handleManageMember(message, args) {
    if (!args[0]) {
        return message.reply("Usage: `?managemember @member`");
    }

    const userId = getUserId(args[0]);

    if (!userId) {
        return message.reply("Please provide a valid member mention or ID.");
    }

    const history = sanctionsData[userId] || [];

    const counts = {
        BAN: 0,
        KICK: 0,
        WARN: 0,
        MUTE: 0
    };

    for (const sanction of history) {
        if (counts[sanction.type] !== undefined) {
            counts[sanction.type]++;
        }
    }

    let username = `User ID: ${userId}`;

    try {
        const user = await client.users.fetch(userId);
        username = `${user.tag} (${user.id})`;
    } catch {}

    const embed = createEmbed(
        "Member Management",
        `**Member:** ${username}\n\n` +
        `**Moderation statistics**\n` +
        `Bans: ${counts.BAN}\n` +
        `Kicks: ${counts.KICK}\n` +
        `Warnings: ${counts.WARN}\n` +
        `Mutes: ${counts.MUTE}\n\n` +
        `**Total sanctions:** ${history.length}`,
        0x3498DB
    );

    await message.reply({ embeds: [embed] });
}

// ==========================================
// WARNINGS COMMAND
// ?warnings @member
// ==========================================

async function handleWarnings(message, args) {
    if (!args[0]) {
        return message.reply("Usage: `?warnings @member`");
    }

    const userId = getUserId(args[0]);

    if (!userId) {
        return message.reply("Please provide a valid member mention or ID.");
    }

    const warnings = warningsData[userId] || [];

    if (warnings.length === 0) {
        return message.reply("This member has no active warnings.");
    }

    const displayedWarnings = warnings.slice(-15).reverse();

    const description = displayedWarnings.map((warning, index) => {
        return (
            `**${index + 1}.** ${warning.reason}\n` +
            `Moderator: <@${warning.moderatorId}>\n` +
            `Date: ${formatDate(warning.timestamp)}`
        );
    }).join("\n\n");

    const embed = createEmbed(
        `Warnings - ${userId}`,
        `**Active warnings:** ${warnings.length}\n\n${description}`,
        0xF1C40F
    );

    await message.reply({ embeds: [embed] });
}

// ==========================================
// HISTORY COMMAND
// ?history @member
// ==========================================

async function handleHistory(message, args) {
    if (!args[0]) {
        return message.reply("Usage: `?history @member`");
    }

    const userId = getUserId(args[0]);

    if (!userId) {
        return message.reply("Please provide a valid member mention or ID.");
    }

    const history = sanctionsData[userId] || [];

    if (history.length === 0) {
        return message.reply("No moderation history found for this member.");
    }

    const displayedHistory = history.slice(-15).reverse();

    const description = displayedHistory.map((entry, index) => {
        return (
            `**${index + 1}. ${entry.type}**\n` +
            `Moderator: <@${entry.moderatorId}>\n` +
            `Reason: ${entry.reason}\n` +
            `Date: ${formatDate(entry.timestamp)}`
        );
    }).join("\n\n");

    const embed = createEmbed(
        `Moderation History - ${userId}`,
        `**Total recorded sanctions:** ${history.length}\n\n${description}`,
        0x5865F2
    );

    await message.reply({ embeds: [embed] });
}

// ==========================================
// CLEARWARNS COMMAND
// ?clearwarns @member [reason]
// Supervisor and Owner only
// ==========================================

async function handleClearWarns(message, args, rank) {
    if (!hasPermission(rank, "SUPERVISOR")) {
        return message.reply(
            "Only Supervisors and Owners can clear warnings."
        );
    }

    if (!args[0]) {
        return message.reply(
            "Usage: `?clearwarns @member [reason]`"
        );
    }

    const userId = getUserId(args[0]);

    if (!userId) {
        return message.reply("Please provide a valid member mention or ID.");
    }

    const warnings = warningsData[userId] || [];

    if (warnings.length === 0) {
        return message.reply("This member has no active warnings.");
    }

    const previousCount = warnings.length;
    const reason = getReason(args);

    warningsData[userId] = [];

    saveJSON(WARNINGS_FILE, warningsData);

    const embed = createEmbed(
        "Warnings Cleared",
        `**Member:** <@${userId}>\n` +
        `**Warnings removed:** ${previousCount}\n` +
        `**Moderator:** ${message.author.tag}\n` +
        `**Reason:** ${reason}\n\n` +
        "The permanent moderation history has been preserved.",
        0x57F287
    );

    await message.reply({ embeds: [embed] });
}

// ==========================================
// STAFFSTATS COMMAND
// ?staffstats [@staff]
// ==========================================

async function handleStaffStats(message, args, rank) {
    const requestedId = args[0]
        ? getUserId(args[0])
        : message.author.id;

    if (!requestedId) {
        return message.reply("Please provide a valid user mention or ID.");
    }

    if (
        requestedId !== message.author.id &&
        !hasPermission(rank, "OWNER")
    ) {
        return message.reply(
            "Only the Owner can view another staff member's statistics."
        );
    }

    const usage = getStaffUsage(requestedId);

    let staffName = requestedId;

    try {
        const user = await client.users.fetch(requestedId);
        staffName = user.tag;
    } catch {}

    const staffMember = message.guild.members.cache.get(requestedId);
    const staffRank = staffMember
        ? getStaffRank(staffMember)
        : "Unknown";

    const limit = staffRank === "OWNER"
        ? "Unlimited"
        : ACTION_LIMITS[staffRank] ?? "Unknown";

    const remaining = staffRank === "OWNER"
        ? "Unlimited"
        : typeof limit === "number"
            ? Math.max(0, limit - usage.count)
            : "Unknown";

    const embed = createEmbed(
        "Staff Statistics",
        `**Staff:** ${staffName}\n` +
        `**Rank:** ${staffRank}\n\n` +
        `**Actions used:** ${usage.count}\n` +
        `**Action limit:** ${limit}\n` +
        `**Remaining actions:** ${remaining}\n\n` +
        `**Reset:** ${formatDate(usage.resetAt)}`,
        0x3498DB
    );

    await message.reply({ embeds: [embed] });
}

// ==========================================
// HELP COMMAND
// ?help
// ==========================================

async function handleHelp(message, rank) {
    const commands = [
        "**GENERAL COMMANDS**",
        "`?help` - Display all commands",
        "",
        "**MODERATION COMMANDS**",
        "`?ban @member|USER_ID [reason]` - Ban a member (even if not in the server)",
        "`?ipban @member|USER_ID [reason]` - Alias of ?ban",
        "`?kick @member [reason]` - Kick a member",
        "`?mute @member 10m [reason]` - Timeout a member",
        "`?warn @member [reason]` - Warn a member",
        "`?unban USER_ID [reason]` - Unban a user",
        "`?unmute @member` - Remove a timeout",
        "",
        "**MEMBER MANAGEMENT**",
        "`?managemember @member` - View moderation statistics",
        "`?warnings @member` - View active warnings",
        "`?history @member` - View moderation history",
        "`?clearwarns @member [reason]` - Clear active warnings",
        "",
        "**SECURITY**",
        "`?analyst all` - Scan all members for suspected alt accounts (Supervisor and above)",
        "",
        "**STAFF COMMANDS**",
        "`?staffstats [@staff]` - View staff action statistics"
    ];

    const embed = createEmbed(
        "Moderation Bot - Commands",
        commands.join("\n"),
        0x5865F2
    );

    embed.addFields({
        name: "Your staff rank",
        value: rank || "No staff rank",
        inline: true
    });

    await message.reply({ embeds: [embed] });
}

// ==========================================
// FUN COMMAND
// ?CheckThisFemboy
// ==========================================

async function handleCheckFemboy(message, args) {
    const target = args[0]
        ? getUserId(args[0])
        : message.author.id;

    if (!target) {
        return message.reply("Please provide a valid user mention or ID.");
    }

    await message.reply(
        `Member checked: <@${target}>`
    );
}

// ==========================================
// COMMAND REGISTRY
// ==========================================

const KNOWN_COMMANDS = [
    "help",
    "ban",
    "ipban",
    "kick",
    "mute",
    "warn",
    "unban",
    "unmute",
    "managemember",
    "warnings",
    "history",
    "clearwarns",
    "staffstats",
    "analyst",
    "checkthisfemboy"
];

// ==========================================
// MESSAGE COMMAND HANDLER
// ==========================================

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    if (!command) return;

    if (!KNOWN_COMMANDS.includes(command)) return;

    const rank = getStaffRank(message.member);

    // Commands available to everyone
    if (command === "help") {
        return handleHelp(message, rank);
    }

    if (command === "checkthisfemboy") {
        return handleCheckFemboy(message, args);
    }

    // All remaining commands require staff
    if (!rank) {
        return message.reply(
            "You do not have permission to use moderation commands."
        );
    }

    try {
        switch (command) {
            case "ban":
            case "ipban":
                if (!hasPermission(rank, "TRIAL_MODERATOR")) break;
                return await handleBan(message, args, rank);

            case "kick":
                if (!hasPermission(rank, "TRIAL_MODERATOR")) break;
                return await handleKick(message, args, rank);

            case "mute":
                if (!hasPermission(rank, "TRIAL_MODERATOR")) break;
                return await handleMute(message, args, rank);

            case "warn":
                if (!hasPermission(rank, "TRIAL_MODERATOR")) break;
                return await handleWarn(message, args, rank);

            case "unban":
                if (!hasPermission(rank, "MODERATOR")) break;
                return await handleUnban(message, args, rank);

            case "unmute":
                if (!hasPermission(rank, "MODERATOR")) break;
                return await handleUnmute(message, args, rank);

            case "managemember":
                return await handleManageMember(message, args);

            case "warnings":
                return await handleWarnings(message, args);

            case "history":
                return await handleHistory(message, args);

            case "clearwarns":
                return await handleClearWarns(message, args, rank);

            case "staffstats":
                return await handleStaffStats(message, args, rank);

            case "analyst":
                if (!hasPermission(rank, "SUPERVISOR")) break;
                return await handleAnalyst(message, args);
        }

        await message.reply(
            "You do not have the required staff rank for this command."
        );

    } catch (error) {
        console.error(`Command error (${command}):`, error);

        await message.reply(
            "An unexpected error occurred while executing this command."
        ).catch(() => {});
    }
});

// ==========================================
// BOT READY EVENT
// ==========================================

client.once("clientReady", () => {
    console.log("================================");
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Prefix: ${PREFIX}`);
    console.log("Moderation system is online.");
    console.log("================================");

    client.user.setActivity("Moderation System", {
        type: 0
    });
});

// ==========================================
// RENDER HEALTH CHECK SERVER
// ==========================================

const server = http.createServer((req, res) => {
    if (req.url === "/") {
        res.writeHead(200, {
            "Content-Type": "text/plain"
        });

        return res.end("Moderation Bot is online.");
    }

    if (req.url === "/health") {
        res.writeHead(200, {
            "Content-Type": "application/json"
        });

        return res.end(JSON.stringify({
            status: "online",
            bot: client.isReady(),
            uptime: process.uptime()
        }));
    }

    res.writeHead(404);
    res.end("Not found");
});

server.listen(PORT, () => {
    console.log(`Health server running on port ${PORT}`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

async function shutdown(signal) {
    console.log(`${signal} received. Shutting down...`);

    saveAllData();

    server.close();

    try {
        client.destroy();
    } catch (error) {
        console.error("Error destroying Discord client:", error);
    }

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ==========================================
// START BOT
// ==========================================

async function startBot() {
    loadAllData();

    try {
        await client.login(TOKEN);
    } catch (error) {
        console.error("Failed to login to Discord:", error);
        process.exit(1);
    }
}

startBot();
