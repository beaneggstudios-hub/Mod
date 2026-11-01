'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PREFIX = '?';
const PERIOD_MS = 10 * 60 * 60 * 1000; // fixed 10-hour period
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord timeout cap

const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

// Channel for message logs (deleted and edited messages).
const MESSAGE_LOG_CHANNEL_ID = process.env.MESSAGE_LOG_CHANNEL_ID || '1564665733114236988';
// Set LOG_ALL_MESSAGES=true to also log every message that is sent.
const LOG_ALL_MESSAGES = String(process.env.LOG_ALL_MESSAGES || '').toLowerCase() === 'true';

// Joke: this user gets roasted when they use ?help without holding a staff rank.
const PEASANT_USER_ID = '1561335564341346335';

// Persistent storage location. On hosts with an ephemeral filesystem
// (for example Render without a disk), point DATA_DIR to a persistent disk.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'limits.json');

// Stored warnings (kept separately from the limit counters).
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');

// Staff ranks, highest first. Identified by configured role IDs, never by name.
const RANK_DEFINITIONS = [
  {
    key: 'owner',
    name: 'Owner',
    level: 5,
    roleId: process.env.OWNER_ROLE_ID,
    limits: { ban: Infinity, kick: Infinity, mute: Infinity, warn: Infinity },
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    level: 4,
    roleId: process.env.SUPERVISOR_ROLE_ID,
    limits: { ban: 5, kick: 7, mute: 12, warn: 15 },
  },
  {
    key: 'senior_moderator',
    name: 'Senior Moderator',
    level: 3,
    roleId: process.env.SENIOR_MODERATOR_ROLE_ID,
    limits: { ban: 3, kick: 5, mute: 8, warn: 10 },
  },
  {
    key: 'moderator',
    name: 'Moderator',
    level: 2,
    roleId: process.env.MODERATOR_ROLE_ID,
    limits: { ban: 2, kick: 3, mute: 5, warn: 6 },
  },
  {
    key: 'trial_moderator',
    name: 'Trial Moderator',
    level: 1,
    roleId: process.env.TRIAL_MODERATOR_ROLE_ID,
    limits: { ban: 1, kick: 2, mute: 3, warn: 4 },
  },
];

const RANKS = RANK_DEFINITIONS.filter((rank) => {
  if (!rank.roleId) {
    console.warn(`[config] Missing role ID for rank "${rank.name}". This rank is disabled.`);
    return false;
  }
  return true;
});

// Optional: extra staff roles (for example Community Manager). Members with one of
// these roles count as staff for ?help, but they get no moderation permissions or
// limits from it. Comma-separated role IDs.
const EXTRA_STAFF_ROLE_IDS = (process.env.EXTRA_STAFF_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Optional: extra roles that can never be targeted by moderation commands.
const PROTECTED_ROLE_IDS = (process.env.PROTECTED_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const ACTION_LABELS = { ban: 'Ban', kick: 'Kick', mute: 'Mute', warn: 'Warn' };
const ACTION_PLURALS = { ban: 'Bans', kick: 'Kicks', mute: 'Mutes', warn: 'Warns' };
const ACTION_PAST = { ban: 'banned', kick: 'kicked', mute: 'muted', warn: 'warned' };

/* ------------------------------------------------------------------ */
/* Persistent storage                                                  */
/* ------------------------------------------------------------------ */

let store = {};

function loadStore() {
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (typeof store !== 'object' || store === null || Array.isArray(store)) {
      throw new Error('Invalid store format');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[storage] Could not read the limits file. Starting from an empty store.', error.message);
      try {
        fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt-${Date.now()}`);
      } catch (_) {
        /* ignore backup failure */
      }
    }
    store = {};
  }
}

// Atomic write: write to a temporary file, then rename over the real one.
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let warnings = {};

function loadWarnings() {
  try {
    warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
    if (typeof warnings !== 'object' || warnings === null || Array.isArray(warnings)) {
      throw new Error('Invalid warnings format');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[storage] Could not read the warnings file.', error.message);
    warnings = {};
  }
}

function saveWarnings() {
  fs.mkdirSync(path.dirname(WARNINGS_FILE), { recursive: true });
  const tmp = `${WARNINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(warnings, null, 2));
  fs.renameSync(tmp, WARNINGS_FILE);
}

function addWarning(targetId, moderatorId, reason) {
  if (!Array.isArray(warnings[targetId])) warnings[targetId] = [];
  warnings[targetId].push({ moderatorId, reason, timestamp: Date.now() });
  saveWarnings();
}

// Returns the staff member's record, starting a new 10-hour period when needed.
function getRecord(userId) {
  const now = Date.now();
  let record = store[userId];
  if (!record || typeof record.resetAt !== 'number' || now >= record.resetAt) {
    record = { resetAt: now + PERIOD_MS, ban: 0, kick: 0, mute: 0, warn: 0 };
    store[userId] = record;
    saveStore();
  }
  if (typeof record.warn !== 'number') record.warn = 0;
  return record;
}

function resetTimestamp(record) {
  return Math.floor(record.resetAt / 1000);
}

/* ------------------------------------------------------------------ */
/* Per-moderator lock (prevents race conditions)                       */
/* ------------------------------------------------------------------ */

const locks = new Map();

function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

function getRank(member) {
  if (!member) return null;
  for (const rank of RANKS) {
    if (member.roles.cache.has(rank.roleId)) return rank;
  }
  return null;
}

function hasExtraStaffRole(member) {
  return EXTRA_STAFF_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId));
}

function formatLimit(value) {
  return value === Infinity ? 'Unlimited' : String(value);
}

function parseUserId(arg) {
  if (!arg) return null;
  const match = arg.match(/^<@!?(\d{17,20})>$/) || arg.match(/^(\d{17,20})$/);
  return match ? match[1] : null;
}

function parseDuration(arg) {
  if (!arg) return null;
  const match = arg.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  const ms = value * multipliers[unit];
  if (ms < 1000 || ms > MAX_TIMEOUT_MS) return null;
  return ms;
}

function infoEmbed(title, description, color = 0x2b2d31) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

function errorEmbed(description) {
  return infoEmbed('Error', description, 0xed4245);
}

async function sendLog(guild, embed, channelId = LOG_CHANNEL_ID) {
  if (!channelId) return;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (error) {
    console.error('[logs] Could not send a log message:', error.message);
  }
}

function buildLogEmbed({ title, color, moderator, rank, type, target, usage, status, reason, record }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'Moderator', value: `<@${moderator.id}> (${moderator.username}, ${moderator.id})` },
      { name: 'Rank', value: rank.name, inline: true },
      { name: 'Action', value: ACTION_LABELS[type], inline: true },
      { name: 'Usage', value: usage, inline: true },
      { name: 'Status', value: status, inline: true }
    )
    .setTimestamp();

  if (target) embed.addFields({ name: 'Target', value: `${target.tag || 'Unknown user'} (${target.id})` });
  if (reason) embed.addFields({ name: 'Reason', value: reason });
  if (record && rank.limits[type] !== Infinity) {
    embed.addFields({ name: 'Next reset', value: `<t:${resetTimestamp(record)}:R>` });
  }
  return embed;
}

/* ------------------------------------------------------------------ */
/* Target validation (hierarchy and protection checks)                 */
/* ------------------------------------------------------------------ */

async function resolveTarget(guild, arg) {
  const id = parseUserId(arg);
  if (!id) return null;
  const member = await guild.members.fetch(id).catch(() => null);
  let user = member ? member.user : null;
  if (!user) user = await client.users.fetch(id).catch(() => null);
  return { id, member, user };
}

// Returns an error string, or null when the target is valid.
// The same checks apply whether the target was given as a mention or a raw ID.
function checkTarget(guild, moderatorMember, moderatorRank, target, type) {
  if (target.id === moderatorMember.id) return 'You cannot moderate yourself.';
  if (target.id === client.user.id) return 'You cannot moderate the bot.';
  if (target.id === guild.ownerId) return 'This user is protected and cannot be moderated.';

  if (!target.member) {
    if (type === 'kick' || type === 'mute' || type === 'warn') return 'This user is not a member of the server.';
    return null; // ban by ID for a user who is not in the server
  }

  const member = target.member;

  if (PROTECTED_ROLE_IDS.some((roleId) => member.roles.cache.has(roleId))) {
    return 'This user is protected and cannot be moderated.';
  }

  const targetRank = getRank(member);
  if (targetRank && targetRank.level >= moderatorRank.level) {
    return 'You cannot moderate a member of equal or higher staff rank.';
  }

  const isGuildOwner = moderatorMember.id === guild.ownerId;
  if (!isGuildOwner && moderatorMember.roles.highest.position <= member.roles.highest.position) {
    return 'You cannot moderate a member whose highest role is equal to or above yours.';
  }

  if (type === 'ban' && !member.bannable) return 'I am not able to ban this member.';
  if (type === 'kick' && !member.kickable) return 'I am not able to kick this member.';
  if (type === 'mute' && !member.moderatable) return 'I am not able to mute this member.';

  return null;
}

/* ------------------------------------------------------------------ */
/* Limited action runner                                               */
/* ------------------------------------------------------------------ */

// Checks the allowance, reserves it, runs the sanction, and rolls back if it fails.
// The whole sequence runs under a per-moderator lock so concurrent commands
// cannot exceed a limit.
function runLimitedAction({ message, rank, type, target, reason, perform }) {
  const moderator = message.author;

  return withLock(moderator.id, async () => {
    const limit = rank.limits[type];
    const unlimited = limit === Infinity;
    const record = unlimited ? null : getRecord(moderator.id);

    if (!unlimited && record[type] >= limit) {
      const usage = `${record[type]}/${limit}`;
      const embed = infoEmbed(
        'Moderation Limit Reached',
        `You have reached your ${type} limit for this 10-hour period.\n\n` +
          `**Current usage:** ${usage}\n` +
          `**Next reset:** <t:${resetTimestamp(record)}:R>\n\n` +
          'You may use other moderation commands if their independent limits have not been reached.',
        0xed4245
      );
      await message.reply({ embeds: [embed] }).catch(() => {});

      await sendLog(
        message.guild,
        buildLogEmbed({
          title: 'Moderation Limit Reached',
          color: 0xed4245,
          moderator,
          rank,
          type,
          target,
          usage,
          status: 'Rejected',
          reason: `Maximum ${type} allowance reached.`,
          record,
        })
      );
      return false;
    }

    // Reserve the allowance before executing, and persist it immediately.
    if (!unlimited) {
      record[type] += 1;
      saveStore();
    }

    try {
      await perform();
    } catch (error) {
      // Failed sanctions never consume an allowance.
      if (!unlimited) {
        record[type] = Math.max(0, record[type] - 1);
        saveStore();
      }
      console.error(`[${type}] Action failed:`, error.message);
      await message
        .reply({
          embeds: [errorEmbed('The action could not be completed. No moderation allowance was used.')],
        })
        .catch(() => {});
      return false;
    }

    const usage = unlimited ? 'Unlimited' : `${record[type]}/${limit}`;
    const embed = infoEmbed(
      `${ACTION_LABELS[type]} Successful`,
      `${target.tag || target.id} has been ${ACTION_PAST[type]}.\n\n` +
        `**Reason:** ${reason}\n**${ACTION_PLURALS[type]} used:** ${usage}` +
        (unlimited ? '' : `\n**Next reset:** <t:${resetTimestamp(record)}:R>`),
      0x57f287
    );
    await message.reply({ embeds: [embed] }).catch(() => {});

    await sendLog(
      message.guild,
      buildLogEmbed({
        title: `Moderation Action: ${ACTION_LABELS[type]}`,
        color: 0x57f287,
        moderator,
        rank,
        type,
        target,
        usage,
        status: 'Allowed',
        reason,
        record,
      })
    );
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function handleBan(message, args, rank) {
  const target = await resolveTarget(message.guild, args[0]);
  if (!target) {
    return message.reply({ embeds: [errorEmbed('Usage: `?ban <user mention or ID> [reason]`')] });
  }
  const reason = args.slice(1).join(' ') || 'No reason provided';

  const problem = checkTarget(message.guild, message.member, rank, target, 'ban');
  if (problem) return message.reply({ embeds: [errorEmbed(problem)] });

  const targetInfo = { id: target.id, tag: target.user ? target.user.tag : null };
  return runLimitedAction({
    message,
    rank,
    type: 'ban',
    target: targetInfo,
    reason,
    perform: () =>
      message.guild.members.ban(target.id, {
        reason: `${message.author.tag}: ${reason}`,
        deleteMessageSeconds: 0,
      }),
  });
}

async function handleKick(message, args, rank) {
  const target = await resolveTarget(message.guild, args[0]);
  if (!target) {
    return message.reply({ embeds: [errorEmbed('Usage: `?kick <user mention or ID> [reason]`')] });
  }
  const reason = args.slice(1).join(' ') || 'No reason provided';

  const problem = checkTarget(message.guild, message.member, rank, target, 'kick');
  if (problem) return message.reply({ embeds: [errorEmbed(problem)] });

  const targetInfo = { id: target.id, tag: target.user ? target.user.tag : null };
  return runLimitedAction({
    message,
    rank,
    type: 'kick',
    target: targetInfo,
    reason,
    perform: () => target.member.kick(`${message.author.tag}: ${reason}`),
  });
}

async function handleMute(message, args, rank) {
  const target = await resolveTarget(message.guild, args[0]);
  const duration = parseDuration(args[1]);
  if (!target || !duration) {
    return message.reply({
      embeds: [
        errorEmbed(
          'Usage: `?mute <user mention or ID> <duration> [reason]`\n' +
            'Duration examples: `30m`, `2h`, `1d` (maximum 28d).'
        ),
      ],
    });
  }
  const reason = args.slice(2).join(' ') || 'No reason provided';

  const problem = checkTarget(message.guild, message.member, rank, target, 'mute');
  if (problem) return message.reply({ embeds: [errorEmbed(problem)] });

  const targetInfo = { id: target.id, tag: target.user ? target.user.tag : null };
  return runLimitedAction({
    message,
    rank,
    type: 'mute',
    target: targetInfo,
    reason,
    perform: () => target.member.timeout(duration, `${message.author.tag}: ${reason}`),
  });
}

async function handleWarn(message, args, rank) {
  const target = await resolveTarget(message.guild, args[0]);
  const reason = args.slice(1).join(' ').trim();
  if (!target || !reason) {
    return message.reply({
      embeds: [errorEmbed('Usage: `?warn <user mention or ID> <reason>` (a reason is required)')],
    });
  }

  const problem = checkTarget(message.guild, message.member, rank, target, 'warn');
  if (problem) return message.reply({ embeds: [errorEmbed(problem)] });

  const targetInfo = { id: target.id, tag: target.user ? target.user.tag : null };
  return runLimitedAction({
    message,
    rank,
    type: 'warn',
    target: targetInfo,
    reason,
    perform: async () => {
      addWarning(target.id, message.author.id, reason);
      // Notify the member. A closed DM never makes the warning fail.
      await target.user
        .send({
          embeds: [
            infoEmbed(
              'You have received a warning',
              `**Server:** ${message.guild.name}\n**Reason:** ${reason}`,
              0xfee75c
            ),
          ],
        })
        .catch(() => {});
    },
  });
}

// Unban and unmute never consume an allowance.
async function handleUnban(message, args) {
  const id = parseUserId(args[0]);
  if (!id) {
    return message.reply({ embeds: [errorEmbed('Usage: `?unban <user ID> [reason]`')] });
  }
  const reason = args.slice(1).join(' ') || 'No reason provided';
  try {
    await message.guild.bans.remove(id, `${message.author.tag}: ${reason}`);
    await message.reply({ embeds: [infoEmbed('Unban Successful', `User ${id} has been unbanned.`, 0x57f287)] });
    await sendLog(
      message.guild,
      infoEmbed(
        'Moderation Action: Unban',
        `Moderator: <@${message.author.id}> (${message.author.username}, ${message.author.id})\n` +
          `Target ID: ${id}\nReason: ${reason}`,
        0x57f287
      ).setTimestamp()
    );
  } catch (error) {
    console.error('[unban] Action failed:', error.message);
    await message.reply({ embeds: [errorEmbed('The user could not be unbanned.')] }).catch(() => {});
  }
}

async function handleUnmute(message, args) {
  const target = await resolveTarget(message.guild, args[0]);
  if (!target || !target.member) {
    return message.reply({ embeds: [errorEmbed('Usage: `?unmute <user mention or ID> [reason]`')] });
  }
  const reason = args.slice(1).join(' ') || 'No reason provided';
  try {
    await target.member.timeout(null, `${message.author.tag}: ${reason}`);
    await message.reply({
      embeds: [infoEmbed('Unmute Successful', `${target.user.tag} has been unmuted.`, 0x57f287)],
    });
    await sendLog(
      message.guild,
      infoEmbed(
        'Moderation Action: Unmute',
        `Moderator: <@${message.author.id}> (${message.author.username}, ${message.author.id})\n` +
          `Target: ${target.user.tag} (${target.id})\nReason: ${reason}`,
        0x57f287
      ).setTimestamp()
    );
  } catch (error) {
    console.error('[unmute] Action failed:', error.message);
    await message.reply({ embeds: [errorEmbed('The user could not be unmuted.')] }).catch(() => {});
  }
}

async function handleLimits(message, args, rank) {
  let subjectMember = message.member;
  let subjectRank = rank;

  // Only the Owner rank may inspect another moderator's limits.
  if (args[0]) {
    if (rank.key !== 'owner') return null;
    const id = parseUserId(args[0]);
    const member = id ? await message.guild.members.fetch(id).catch(() => null) : null;
    const memberRank = getRank(member);
    if (!member || !memberRank) {
      return message.reply({ embeds: [errorEmbed('That user does not hold a configured staff role.')] });
    }
    subjectMember = member;
    subjectRank = memberRank;
  }

  const isSelf = subjectMember.id === message.author.id;
  const title = isSelf ? 'Your Moderation Limits' : `Moderation Limits: ${subjectMember.user.tag}`;

  if (subjectRank.key === 'owner') {
    return message.reply({
      embeds: [
        infoEmbed(
          title,
          `**${subjectRank.name}**\n\n- Bans: Unlimited\n- Kicks: Unlimited\n- Mutes: Unlimited\n- Warns: Unlimited`
        ),
      ],
    });
  }

  const record = getRecord(subjectMember.id);
  const lines = ['ban', 'kick', 'mute', 'warn']
    .map((type) => `- ${ACTION_PLURALS[type]}: ${record[type]}/${formatLimit(subjectRank.limits[type])} used`)
    .join('\n');

  return message.reply({
    embeds: [
      infoEmbed(
        title,
        `**${subjectRank.name}**\n\n${lines}\n\nNext reset: <t:${resetTimestamp(record)}:R> (<t:${resetTimestamp(record)}:F>)`
      ),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Fun command: ?CheckThisFemboy                                       */
/* ------------------------------------------------------------------ */

const FEMBOY_ITEMS = [
  'Thigh highs (x7)',
  'A suspicious number of hoodies',
  'This bro is 30 yrs old',
];

const FEMBOY_VERDICTS = [
  'Certified by the Council of Femboys.',
  'Scientists are still studying this case.',
  'The FBI agent in the walls approves.',
  'Cannot be explained by modern science.',
  'This result has been verified by 3 Discord kittens.',
  'The bot got scared and double-checked its math.',
];

function femboyComment(percent) {
  if (percent === 100) return ' Absolute legend.';
  if (percent >= 90) return 'Basically a walking femboy.';
  if (percent >= 70) return 'Strong femboy energy.';
  if (percent >= 50) return 'Half femboy, half mystery.';
  if (percent >= 30) return 'A little spark of femboy.';
  if (percent >= 10) return 'Mostly normal... but the bot has doubts.';
  return 'Is this person even human? like, 0 femboy detected, lil bro.';
}

function femboyBar(percent) {
  const filled = Math.round(Math.min(percent, 100) / 10);
  return `${'🟪'.repeat(filled)}${'⬛'.repeat(10 - filled)}`;
}

async function handleCheckFemboy(message, args) {
  const target = await resolveTarget(message.guild, args[0]);
  if (!target || !target.user) {
    return message.reply({ embeds: [errorEmbed('Usage: `?CheckThisFemboy <user mention or ID>`')] });
  }

  const isBot = target.id === client.user.id;
  const percent = isBot ? 1000 : Math.floor(Math.random() * 101);

  // Funny thing #1: a funny comment depending on the percentage.
  const comment = isBot ? 'The bot is the ultimate femboy,lollll.' : femboyComment(percent);

  // Funny thing #2: random "evidence" items found in the user's room.
  const shuffled = [...FEMBOY_ITEMS].sort(() => Math.random() - 0.5).slice(0, 3);

  // Funny thing #3: a random official verdict.
  const verdict = FEMBOY_VERDICTS[Math.floor(Math.random() * FEMBOY_VERDICTS.length)];

  const embed = new EmbedBuilder()
    .setTitle(' Femboy Scanner Bro not a troll')
    .setColor(0xff69b4)
    .setDescription(
      `Scan result for **${target.user.tag}**\n\n` +
        `${femboyBar(percent)}\n**${percent}% femboy**\n\n` +
        `*${comment}*`
    )
    .addFields(
      { name: '🔍 Evidence found', value: shuffled.map((item) => `- ${item}`).join('\n') },
      { name: '📜 Official verdict', value: verdict }
    )
    .setFooter({ text: 'This scan is 100% scientific. Trust me bro.' })
    .setTimestamp();

  return message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
}

async function handleHelp(message, rank) {
  const lines = [
    '`?ban <@user or ID> [reason]` - Ban a user (uses a ban)',
    '`?kick <@user or ID> [reason]` - Kick a member (uses a kick)',
    '`?mute <@user or ID> <duration> [reason]` - Mute a member (uses a mute)',
    '`?warn <@user or ID> <reason>` - Warn a member (uses a warn)',
    '`?unban <user ID> [reason]` - Unban a user',
    '`?unmute <@user or ID> [reason]` - Remove a mute',
    '`?limits` - Show your moderation limits and next reset',
  ];

  if (rank) {
    lines.push('`?CheckThisFemboy <@user or ID>` - Check how much of a femboy someone is');
  }

  if (rank && rank.key === 'owner') {
    lines.push("`?limits <@user or ID>` - Show another staff member's limits");
  }

  lines.push('`?help` - Show this message');

  const rankLabel = rank ? rank.name : 'Staff (no moderation rank)';
  const note = rank
    ? 'Mute durations: `30m`, `2h`, `1d` (maximum 28d).'
    : 'Your staff role does not grant access to the moderation commands above.';

  return message.reply({
    embeds: [infoEmbed('Moderation Commands', `**Your rank:** ${rankLabel}\n\n${lines.join('\n')}\n\n${note}`)],
  });
}

/* ------------------------------------------------------------------ */
/* Message handler                                                     */
/* ------------------------------------------------------------------ */

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();

    const known = ['ban', 'kick', 'mute', 'unban', 'unmute', 'limits', 'help', 'warn', 'checkthisfemboy'];
    if (!known.includes(command)) return;

    // Make sure the member and their roles are fresh.
    // message.member is read-only. Fetching caches the member, which fills the getter.
    if (!message.member) await message.guild.members.fetch(message.author.id).catch(() => null);
    const member = message.member;
    if (!member) return;

    const rank = getRank(member);

    // Joke: one specific user gets roasted if they try ?help without a staff rank.
    if (command === 'help' && message.author.id === PEASANT_USER_ID && !rank) {
      return await message.reply('Shut up peasant, grind roles and come back after you got Trial Mod 💀');
    }

    // Non-staff members are ignored silently. Staff information is never exposed.
    // getRank uses the highest configured rank, so extra roles never lower it.
    if (!rank && !hasExtraStaffRole(member)) return;

    // ?help is available to every staff member.
    if (command === 'help') return await handleHelp(message, rank);

    // Everything else requires a moderation rank (Trial Moderator and above).
    if (!rank) return;

    switch (command) {
      case 'ban':
        return await handleBan(message, args, rank);
      case 'kick':
        return await handleKick(message, args, rank);
      case 'mute':
        return await handleMute(message, args, rank);
      case 'warn':
        return await handleWarn(message, args, rank);
      case 'unban':
        return await handleUnban(message, args);
      case 'unmute':
        return await handleUnmute(message, args);
      case 'limits':
        return await handleLimits(message, args, rank);
      case 'checkthisfemboy':
        return await handleCheckFemboy(message, args);
      default:
        return null;
    }
  } catch (error) {
    console.error('[messageCreate] Unexpected error:', error.message);
  }
});

/* ------------------------------------------------------------------ */
/* Message logs                                                        */
/* ------------------------------------------------------------------ */

function truncate(text, max = 1000) {
  if (!text) return '(no text content)';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function describeAuthor(author) {
  return author ? `<@${author.id}> (${author.tag}, ${author.id})` : 'Unknown (message was not cached)';
}

function attachmentList(message) {
  if (!message.attachments || message.attachments.size === 0) return null;
  return truncate([...message.attachments.values()].map((a) => a.url).join('\n'));
}

client.on('messageDelete', async (message) => {
  try {
    if (!message.guild || message.channelId === MESSAGE_LOG_CHANNEL_ID) return;
    if (message.author && message.author.bot) return;

    const embed = new EmbedBuilder()
      .setTitle('Message Deleted')
      .setColor(0xed4245)
      .addFields(
        { name: 'Author', value: describeAuthor(message.author) },
        { name: 'Channel', value: `<#${message.channelId}>` },
        { name: 'Content', value: truncate(message.content) }
      )
      .setTimestamp();
    const files = attachmentList(message);
    if (files) embed.addFields({ name: 'Attachments', value: files });

    await sendLog(message.guild, embed, MESSAGE_LOG_CHANNEL_ID);
  } catch (error) {
    console.error('[messageDelete] Unexpected error:', error.message);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (newMessage.partial) await newMessage.fetch().catch(() => null);
    if (!newMessage.guild || newMessage.channelId === MESSAGE_LOG_CHANNEL_ID) return;
    if (newMessage.author && newMessage.author.bot) return;
    if (oldMessage.content === newMessage.content) return; // embeds or pins, not an edit

    const embed = new EmbedBuilder()
      .setTitle('Message Edited')
      .setColor(0xfee75c)
      .addFields(
        { name: 'Author', value: describeAuthor(newMessage.author) },
        { name: 'Channel', value: `<#${newMessage.channelId}> ([jump to message](${newMessage.url}))` },
        { name: 'Before', value: truncate(oldMessage.content) },
        { name: 'After', value: truncate(newMessage.content) }
      )
      .setTimestamp();

    await sendLog(newMessage.guild, embed, MESSAGE_LOG_CHANNEL_ID);
  } catch (error) {
    console.error('[messageUpdate] Unexpected error:', error.message);
  }
});

// Optional: log every message that is sent (LOG_ALL_MESSAGES=true).
client.on('messageCreate', async (message) => {
  try {
    if (!LOG_ALL_MESSAGES) return;
    if (!message.guild || message.author.bot || message.channelId === MESSAGE_LOG_CHANNEL_ID) return;

    const embed = new EmbedBuilder()
      .setTitle('Message Sent')
      .setColor(0x5865f2)
      .addFields(
        { name: 'Author', value: describeAuthor(message.author) },
        { name: 'Channel', value: `<#${message.channelId}> ([jump to message](${message.url}))` },
        { name: 'Content', value: truncate(message.content) }
      )
      .setTimestamp();
    const files = attachmentList(message);
    if (files) embed.addFields({ name: 'Attachments', value: files });

    await sendLog(message.guild, embed, MESSAGE_LOG_CHANNEL_ID);
  } catch (error) {
    console.error('[messageCreate log] Unexpected error:', error.message);
  }
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

// Minimal HTTP server so Render detects an open port (Web Service hosting).
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running.');
  })
  .listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

process.on('unhandledRejection', (error) => {
  console.error('[process] Unhandled rejection:', error && error.message ? error.message : error);
});

if (!TOKEN) {
  console.error('Missing TOKEN environment variable.');
  process.exit(1);
}

// Country collecting game (slash commands, spawns in its own channel).
// Needs countries.js in the same folder as this file.


loadStore();
loadWarnings();
client.login(TOKEN);
