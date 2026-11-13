'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} = require('discord.js');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PREFIX = '?';
const PERIOD_MS = 10 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_REASON_LENGTH = 400;

const TOKEN = process.env.TOKEN;

// Role used for the peasant joke.
const MEMBER_ROLE_ID = process.env.MEMBER_ID_ROLE || process.env.MEMBER_ROLE_ID;

const PEASANT_MESSAGE =
  'Shut up peasant, come back when you will pass your mod application.';

// Persistent storage location.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'limits.json');
const WARNINGS_FILE = path.join(DATA_DIR, 'warnings.json');

// Staff ranks, highest first.
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
    console.warn(
      `[config] Missing role ID for rank "${rank.name}". This rank is disabled.`
    );
    return false;
  }

  return true;
});

// Optional extra staff roles.
const EXTRA_STAFF_ROLE_IDS = (process.env.EXTRA_STAFF_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Roles that cannot be targeted by moderation commands.
const PROTECTED_ROLE_IDS = (process.env.PROTECTED_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const ACTION_LABELS = {
  ban: 'Ban',
  kick: 'Kick',
  mute: 'Mute',
  warn: 'Warn',
};

const ACTION_PLURALS = {
  ban: 'Bans',
  kick: 'Kicks',
  mute: 'Mutes',
  warn: 'Warns',
};

const ACTION_PAST = {
  ban: 'banned',
  kick: 'kicked',
  mute: 'muted',
  warn: 'warned',
};

const KNOWN_COMMANDS = [
  'ban',
  'kick',
  'mute',
  'warn',
  'unban',
  'unmute',
  'limits',
  'help',
  'checkthisfemboy',
];

/* ------------------------------------------------------------------ */
/* Persistent storage                                                  */
/* ------------------------------------------------------------------ */

let store = {};
let warnings = {};

function readJsonFile(file, label) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (
      typeof data !== 'object' ||
      data === null ||
      Array.isArray(data)
    ) {
      throw new Error('Invalid format');
    }

    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(
        `[storage] Could not read the ${label} file. Starting from an empty one.`,
        error.message
      );

      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
      } catch (_) {
        // Ignore backup failure.
      }
    }

    return {};
  }
}

// Atomic write.
function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const tmp = `${file}.tmp`;

    fs.writeFileSync(
      tmp,
      JSON.stringify(data, null, 2)
    );

    fs.renameSync(tmp, file);
  } catch (error) {
    console.error(
      `[storage] Could not write ${path.basename(file)}:`,
      error.message
    );
  }
}

function loadStore() {
  store = readJsonFile(DATA_FILE, 'limits');
}

function saveStore() {
  writeJsonFile(DATA_FILE, store);
}

function loadWarnings() {
  warnings = readJsonFile(WARNINGS_FILE, 'warnings');
}

function saveWarnings() {
  writeJsonFile(WARNINGS_FILE, warnings);
}

function addWarning(targetId, moderatorId, reason) {
  if (!Array.isArray(warnings[targetId])) {
    warnings[targetId] = [];
  }

  warnings[targetId].push({
    moderatorId,
    reason,
    timestamp: Date.now(),
  });

  saveWarnings();
}

// Returns the staff member's record.
function getRecord(userId) {
  const now = Date.now();
  let record = store[userId];

  if (
    !record ||
    typeof record.resetAt !== 'number' ||
    now >= record.resetAt
  ) {
    record = {
      resetAt: now + PERIOD_MS,
      ban: 0,
      kick: 0,
      mute: 0,
      warn: 0,
    };

    store[userId] = record;
    saveStore();
  }

  for (const key of ['ban', 'kick', 'mute', 'warn']) {
    if (typeof record[key] !== 'number') {
      record[key] = 0;
    }
  }

  return record;
}

function resetTimestamp(record) {
  return Math.floor(record.resetAt / 1000);
}

/* ------------------------------------------------------------------ */
/* Per-moderator lock                                                  */
/* ------------------------------------------------------------------ */

const locks = new Map();

function withLock(key, task) {
  const previous = locks.get(key) || Promise.resolve();

  const run = previous.catch(() => {}).then(task);
  const tail = run.catch(() => {});

  locks.set(key, tail);

  tail.then(() => {
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  });

  return run;
}

/* ------------------------------------------------------------------ */
/* Client and helpers                                                  */
/* ------------------------------------------------------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent,
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
  ],

  allowedMentions: {
    parse: [],
    repliedUser: false,
  },
});

function getRank(member) {
  if (!member) return null;

  for (const rank of RANKS) {
    if (member.roles.cache.has(rank.roleId)) {
      return rank;
    }
  }

  return null;
}

function hasExtraStaffRole(member) {
  return EXTRA_STAFF_ROLE_IDS.some((roleId) =>
    member.roles.cache.has(roleId)
  );
}

function formatLimit(value) {
  return value === Infinity ? 'Unlimited' : String(value);
}

function parseUserId(arg) {
  if (!arg) return null;

  const match =
    arg.match(/^<@!?(\d{17,20})>$/) ||
    arg.match(/^(\d{17,20})$/);

  return match ? match[1] : null;
}

function parseDuration(arg) {
  if (!arg) return null;

  const match = arg.match(/^(\d+)(s|m|h|d)$/i);

  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();

  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const ms = value * multipliers[unit];

  if (ms < 1000 || ms > MAX_TIMEOUT_MS) {
    return null;
  }

  return ms;
}

function clip(text, max) {
  if (!text) return '';

  return text.length > max
    ? `${text.slice(0, max - 3)}...`
    : text;
}

function cleanReason(text, fallback = 'No reason provided') {
  const value = (text || '').trim();

  return value
    ? clip(value, MAX_REASON_LENGTH)
    : fallback;
}

function auditReason(moderatorTag, reason) {
  return clip(`${moderatorTag}: ${reason}`, 512);
}

function infoEmbed(title, description, color = 0x2b2d31) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color);
}

function errorEmbed(description) {
  return infoEmbed('Error', description, 0xed4245);
}

function reply(message, embed) {
  return message.reply({
    embeds: [embed],
  }).catch((error) => {
    console.error('[reply] Could not reply:', error.message);
    return null;
  });
}

// Discord message/moderation logging has been disabled.
async function sendLog() {
  return;
}
/* ------------------------------------------------------------------ */
/* Target validation                                                   */
/* ------------------------------------------------------------------ */

async function resolveTarget(guild, arg) {
  const id = parseUserId(arg);

  if (!id) return null;

  const member = await guild.members.fetch(id).catch(() => null);

  let user = member ? member.user : null;

  if (!user) {
    user = await client.users.fetch(id).catch(() => null);
  }

  return {
    id,
    member,
    user,
  };
}

// Returns an error string, or null when the target is valid.
function checkTarget(guild, moderatorMember, moderatorRank, target, type) {
  if (target.id === moderatorMember.id) {
    return 'You cannot moderate yourself.';
  }

  if (target.id === client.user.id) {
    return 'You cannot moderate the bot.';
  }

  if (target.id === guild.ownerId) {
    return 'This user is protected and cannot be moderated.';
  }

  if (!target.member) {
    if (
      type === 'kick' ||
      type === 'mute' ||
      type === 'warn'
    ) {
      return 'This user is not a member of the server.';
    }

    return null;
  }

  const member = target.member;

  if (
    PROTECTED_ROLE_IDS.some((roleId) =>
      member.roles.cache.has(roleId)
    )
  ) {
    return 'This user is protected and cannot be moderated.';
  }

  const targetRank = getRank(member);

  if (
    targetRank &&
    targetRank.level >= moderatorRank.level
  ) {
    return 'You cannot moderate a member of equal or higher staff rank.';
  }

  const isGuildOwner = moderatorMember.id === guild.ownerId;

  if (
    !isGuildOwner &&
    moderatorMember.roles.highest.position <=
      member.roles.highest.position
  ) {
    return 'You cannot moderate a member whose highest role is equal to or above yours.';
  }

  if (type === 'ban' && !member.bannable) {
    return 'I am not able to ban this member.';
  }

  if (type === 'kick' && !member.kickable) {
    return 'I am not able to kick this member.';
  }

  if (type === 'mute' && !member.moderatable) {
    return 'I am not able to mute this member.';
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Limited action runner                                               */
/* ------------------------------------------------------------------ */

function runLimitedAction({
  message,
  rank,
  type,
  target,
  reason,
  perform,
}) {
  const moderator = message.author;

  return withLock(moderator.id, async () => {
    const limit = rank.limits[type];
    const unlimited = limit === Infinity;

    const record = unlimited
      ? null
      : getRecord(moderator.id);

    if (!unlimited && record[type] >= limit) {
      const usage = `${record[type]}/${limit}`;

      await reply(
        message,
        infoEmbed(
          'Moderation Limit Reached',
          `You have reached your ${type} limit for this 10-hour period.\n\n` +
            `**Current usage:** ${usage}\n` +
            `**Next reset:** <t:${resetTimestamp(record)}:R>\n\n` +
            'You may use other moderation commands if their independent limits have not been reached.',
          0xed4245
        )
      );

      return false;
    }

    // Reserve the allowance before executing.
    if (!unlimited) {
      record[type] += 1;
      saveStore();
    }

    try {
      await perform();
    } catch (error) {
      // Failed sanctions never consume an allowance.
      if (!unlimited) {
        record[type] = Math.max(
          0,
          record[type] - 1
        );

        saveStore();
      }

      console.error(
        `[${type}] Action failed:`,
        error.message
      );

      await reply(
        message,
        errorEmbed(
          'The action could not be completed. No moderation allowance was used.'
        )
      );

      return false;
    }

    const usage = unlimited
      ? 'Unlimited'
      : `${record[type]}/${limit}`;

    await reply(
      message,
      infoEmbed(
        `${ACTION_LABELS[type]} Successful`,
        `${target.tag || target.id} has been ${ACTION_PAST[type]}.\n\n` +
          `**Reason:** ${reason}\n` +
          `**${ACTION_PLURALS[type]} used:** ${usage}` +
          (unlimited
            ? ''
            : `\n**Next reset:** <t:${resetTimestamp(record)}:R>`),
        0x57f287
      )
    );

    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Moderation commands                                                 */
/* ------------------------------------------------------------------ */

async function handleBan(message, args, rank) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  if (!target) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?ban <user mention or ID> [reason]`'
      )
    );
  }

  const reason = cleanReason(
    args.slice(1).join(' ')
  );

  const problem = checkTarget(
    message.guild,
    message.member,
    rank,
    target,
    'ban'
  );

  if (problem) {
    return reply(message, errorEmbed(problem));
  }

  const targetInfo = {
    id: target.id,
    tag: target.user ? target.user.tag : null,
  };

  return runLimitedAction({
    message,
    rank,
    type: 'ban',
    target: targetInfo,
    reason,

    perform: () =>
      message.guild.members.ban(target.id, {
        reason: auditReason(message.author.tag, reason),
        deleteMessageSeconds: 0,
      }),
  });
}

async function handleKick(message, args, rank) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  if (!target) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?kick <user mention or ID> [reason]`'
      )
    );
  }

  const reason = cleanReason(
    args.slice(1).join(' ')
  );

  const problem = checkTarget(
    message.guild,
    message.member,
    rank,
    target,
    'kick'
  );

  if (problem) {
    return reply(message, errorEmbed(problem));
  }

  const targetInfo = {
    id: target.id,
    tag: target.user ? target.user.tag : null,
  };

  return runLimitedAction({
    message,
    rank,
    type: 'kick',
    target: targetInfo,
    reason,

    perform: () =>
      target.member.kick(
        auditReason(message.author.tag, reason)
      ),
  });
}

async function handleMute(message, args, rank) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  const duration = parseDuration(args[1]);

  if (!target || !duration) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?mute <user mention or ID> <duration> [reason]`\n' +
          'Duration examples: `30m`, `2h`, `1d` (maximum 28d).'
      )
    );
  }

  const reason = cleanReason(
    args.slice(2).join(' ')
  );

  const problem = checkTarget(
    message.guild,
    message.member,
    rank,
    target,
    'mute'
  );

  if (problem) {
    return reply(message, errorEmbed(problem));
  }

  const targetInfo = {
    id: target.id,
    tag: target.user ? target.user.tag : null,
  };

  return runLimitedAction({
    message,
    rank,
    type: 'mute',
    target: targetInfo,
    reason,

    perform: () =>
      target.member.timeout(
        duration,
        auditReason(message.author.tag, reason)
      ),
  });
}

async function handleWarn(message, args, rank) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  const rawReason = args.slice(1).join(' ').trim();

  if (!target || !rawReason) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?warn <user mention or ID> <reason>` (a reason is required)'
      )
    );
  }

  const reason = cleanReason(rawReason);

  const problem = checkTarget(
    message.guild,
    message.member,
    rank,
    target,
    'warn'
  );

  if (problem) {
    return reply(message, errorEmbed(problem));
  }

  const targetInfo = {
    id: target.id,
    tag: target.user ? target.user.tag : null,
  };

  return runLimitedAction({
    message,
    rank,
    type: 'warn',
    target: targetInfo,
    reason,

    perform: async () => {
      addWarning(
        target.id,
        message.author.id,
        reason
      );

      // Notify the member. A closed DM never makes the warning fail.
      await target.user
        .send({
          embeds: [
            infoEmbed(
              'You have received a warning',
              `**Server:** ${message.guild.name}\n` +
                `**Reason:** ${reason}`,
              0xfee75c
            ),
          ],
        })
        .catch(() => {});
    },
  });
}
/* ------------------------------------------------------------------ */
/* Unban and unmute                                                    */
/* ------------------------------------------------------------------ */

// Unban and unmute never consume an allowance.

async function handleUnban(message, args) {
  const id = parseUserId(args[0]);

  if (!id) {
    return reply(
      message,
      errorEmbed('Usage: `?unban <user ID> [reason]`')
    );
  }

  const reason = cleanReason(
    args.slice(1).join(' ')
  );

  try {
    await message.guild.bans.remove(
      id,
      auditReason(message.author.tag, reason)
    );

    await reply(
      message,
      infoEmbed(
        'Unban Successful',
        `User ${id} has been unbanned.`,
        0x57f287
      )
    );
  } catch (error) {
    console.error('[unban] Action failed:', error.message);

    await reply(
      message,
      errorEmbed(
        'The user could not be unbanned (is this user actually banned?).'
      )
    );
  }
}

async function handleUnmute(message, args) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  if (!target || !target.member) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?unmute <user mention or ID> [reason]`'
      )
    );
  }

  const reason = cleanReason(
    args.slice(1).join(' ')
  );

  try {
    await target.member.timeout(
      null,
      auditReason(message.author.tag, reason)
    );

    await reply(
      message,
      infoEmbed(
        'Unmute Successful',
        `${target.user.tag} has been unmuted.`,
        0x57f287
      )
    );
  } catch (error) {
    console.error('[unmute] Action failed:', error.message);

    await reply(
      message,
      errorEmbed('The user could not be unmuted.')
    );
  }
}

/* ------------------------------------------------------------------ */
/* Moderation limits                                                   */
/* ------------------------------------------------------------------ */

async function handleLimits(message, args, rank) {
  let subjectMember = message.member;
  let subjectRank = rank;

  // Only the Owner rank may inspect another moderator's limits.
  if (args[0]) {
    if (rank.key !== 'owner') return null;

    const id = parseUserId(args[0]);

    const member = id
      ? await message.guild.members.fetch(id).catch(() => null)
      : null;

    const memberRank = getRank(member);

    if (!member || !memberRank) {
      return reply(
        message,
        errorEmbed(
          'That user does not hold a configured staff role.'
        )
      );
    }

    subjectMember = member;
    subjectRank = memberRank;
  }

  const isSelf =
    subjectMember.id === message.author.id;

  const title = isSelf
    ? 'Your Moderation Limits'
    : `Moderation Limits: ${subjectMember.user.tag}`;

  if (subjectRank.key === 'owner') {
    return reply(
      message,
      infoEmbed(
        title,
        `**${subjectRank.name}**\n\n` +
          '- Bans: Unlimited\n' +
          '- Kicks: Unlimited\n' +
          '- Mutes: Unlimited\n' +
          '- Warns: Unlimited'
      )
    );
  }

  const record = getRecord(subjectMember.id);

  const lines = ['ban', 'kick', 'mute', 'warn']
    .map((type) =>
      `- ${ACTION_PLURALS[type]}: ${record[type]}/${formatLimit(subjectRank.limits[type])} used`
    )
    .join('\n');

  return reply(
    message,
    infoEmbed(
      title,
      `**${subjectRank.name}**\n\n${lines}\n\n` +
        `Next reset: <t:${resetTimestamp(record)}:R> ` +
        `(<t:${resetTimestamp(record)}:F>)`
    )
  );
}

/* ------------------------------------------------------------------ */
/* Fun command: ?CheckThisFemboy                                      */
/* ------------------------------------------------------------------ */

const FEMBOY_ITEMS = [
  'Thigh highs (x7)',
  'A suspicious number of hoodies',
  'Programming socks',
  'A hidden catgirl maid outfit',
  'Pink keyboard with RGB',
  'An anime figure collection',
  'Headphones with cat ears',
  'Iced matcha latte',
  'A "totally not for me" skirt',
  'A playlist full of vocaloid',
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
  if (percent === 100) {
    return 'PERFECT SCORE. Absolute legend. Bow down.';
  }

  if (percent >= 90) {
    return 'Basically a walking femboy meme. No escape.';
  }

  if (percent >= 70) {
    return 'Strong femboy energy detected. Skirt incoming.';
  }

  if (percent >= 50) {
    return 'Half femboy, half mystery. Dangerous combo.';
  }

  if (percent >= 30) {
    return 'A little spark of femboy is growing inside...';
  }

  if (percent >= 10) {
    return 'Mostly normal... but the bot has doubts.';
  }

  return 'Is this person even human?? 0 femboy detected, sir.';
}

function femboyBar(percent) {
  const filled = Math.round(
    Math.min(percent, 100) / 10
  );

  return (
    `${'🟪'.repeat(filled)}` +
    `${'⬛'.repeat(10 - filled)}`
  );
}

// Fisher-Yates shuffle.
function pickRandom(list, count) {
  const copy = [...list];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(
      Math.random() * (i + 1)
    );

    [copy[i], copy[j]] = [
      copy[j],
      copy[i],
    ];
  }

  return copy.slice(0, count);
}

async function handleCheckFemboy(message, args) {
  const target = await resolveTarget(
    message.guild,
    args[0]
  );

  if (!target || !target.user) {
    return reply(
      message,
      errorEmbed(
        'Usage: `?CheckThisFemboy <user mention or ID>`'
      )
    );
  }

  const isBot = target.id === client.user.id;

  const percent = isBot
    ? 1000
    : Math.floor(Math.random() * 101);

  const comment = isBot
    ? 'The bot is the ultimate femboy. Off the charts. Do not question it.'
    : femboyComment(percent);

  const items = pickRandom(FEMBOY_ITEMS, 3);
  const verdict = pickRandom(FEMBOY_VERDICTS, 1)[0];

  const embed = new EmbedBuilder()
    .setTitle('Femboy Scanner 3000')
    .setColor(0xff69b4)
    .setDescription(
      `Scan result for **${target.user.tag}**\n\n` +
        `${femboyBar(percent)}\n` +
        `**${percent}% femboy**\n\n` +
        `*${comment}*`
    )
    .addFields(
      {
        name: 'Evidence found',
        value: items.map((item) => `- ${item}`).join('\n'),
      },
      {
        name: 'Official verdict',
        value: verdict,
      }
    )
    .setFooter({
      text: 'This scan is 100% scientific. Trust me bro.',
    })
    .setTimestamp();

  return reply(message, embed);
}

/* ------------------------------------------------------------------ */
/* Help command                                                        */
/* ------------------------------------------------------------------ */

async function handleHelp(message, rank) {
  const lines = [
    '`?ban <@user or ID> [reason]` - Ban a user',
    '`?kick <@user or ID> [reason]` - Kick a member',
    '`?mute <@user or ID> <duration> [reason]` - Mute a member',
    '`?warn <@user or ID> <reason>` - Warn a member',
    '`?unban <user ID> [reason]` - Unban a user',
    '`?unmute <@user or ID> [reason]` - Remove a mute',
    '`?limits` - Show your moderation limits',
  ];

  if (rank) {
    lines.push(
      '`?CheckThisFemboy <@user or ID>` - Check how much of a femboy someone is'
    );
  }

  if (rank && rank.key === 'owner') {
    lines.push(
      "`?limits <@user or ID>` - Show another staff member's limits"
    );
  }

  lines.push('`?help` - Show this message');

  const rankLabel = rank
    ? rank.name
    : 'Staff (no moderation rank)';

  const note = rank
    ? 'Mute durations: `30m`, `2h`, `1d` (maximum 28d).'
    : 'Your staff role does not grant access to the moderation commands above.';

  return reply(
    message,
    infoEmbed(
      'Moderation Commands',
      `**Your rank:** ${rankLabel}\n\n` +
        `${lines.join('\n')}\n\n${note}`
    )
  );
}
// ==========================================
// PARTIE 4 — COMMAND SYSTEM & BOT STARTUP
// ==========================================

client.on(Events.MessageCreate, async (message) => {
    try {
        if (message.author.bot || !message.guild) return;

        // Only handle prefix commands
        if (!message.content.startsWith(PREFIX)) return;

        const member = message.member;
        if (!member) return;

        // Check member role
        // Members without a staff rank receive the humorous response.
        const rank = getRank(member);

        if (
            MEMBER_ROLE_ID &&
            member.roles.cache.has(MEMBER_ROLE_ID) &&
            !rank
        ) {
            await message.reply(PEASANT_MESSAGE);
            return;
        }

        const args = message.content
            .slice(PREFIX.length)
            .trim()
            .split(/\s+/);

        const command = (args.shift() || '').toLowerCase();

        if (!command) return;

        // ======================================
        // HELP
        // ======================================

        if (command === 'help') {
            if (!rank && !hasExtraStaffRole(member)) {
                return message.reply('You are not authorized to use this command.');
            }

            return handleHelp(message);
        }

        // ======================================
        // FUN COMMAND
        // ======================================

        if (command === 'checkthisfemboy') {
            if (!rank && !hasExtraStaffRole(member)) {
                return message.reply('You are not authorized to use this command.');
            }

            return handleCheckThisFemboy(message);
        }

        // ======================================
        // MODERATION COMMANDS
        // ======================================

        if (!rank) {
            return message.reply('You do not have permission to use moderation commands.');
        }

        switch (command) {
            case 'ban':
                return handleBan(message, args, rank);

            case 'kick':
                return handleKick(message, args, rank);

            case 'mute':
                return handleMute(message, args, rank);

            case 'warn':
                return handleWarn(message, args, rank);

            case 'unban':
                return handleUnban(message, args, rank);

            case 'unmute':
                return handleUnmute(message, args, rank);

            case 'limits':
                return handleLimits(message, args, rank);

            default:
                return;
        }

    } catch (error) {
        console.error('[MESSAGE ERROR]', error);

        try {
            await message.reply('An unexpected error occurred while executing this command.');
        } catch (_) {}
    }
});


// ==========================================
// BOT READY
// ==========================================

client.once(Events.ClientReady, (readyClient) => {
    console.log('================================');
    console.log(`Bot online: ${readyClient.user.tag}`);
    console.log(`Prefix: ${PREFIX}`);
    console.log('Message logging: DISABLED');
    console.log('Moderation system: ACTIVE');
    console.log('================================');
});


// ==========================================
// RENDER HEALTH CHECK SERVER
// ==========================================

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        return res.end(JSON.stringify({
            status: 'online',
            bot: client.isReady()
        }));
    }

    res.writeHead(200, {
        'Content-Type': 'text/plain'
    });

    res.end('Moderation bot is running.');
});

server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});


// ==========================================
// ERROR HANDLING
// ==========================================

process.on('unhandledRejection', (error) => {
    console.error('[UNHANDLED REJECTION]', error);
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);
});


// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

async function shutdown(signal) {
    console.log(`${signal} received. Shutting down...`);

    try {
        saveStore();
        saveWarnings();

        server.close();

        client.destroy();

        console.log('Bot shutdown complete.');
        process.exit(0);

    } catch (error) {
        console.error('Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));


// ==========================================
// START BOT
// ==========================================

async function startBot() {
    try {
        if (!process.env.DISCORD_TOKEN) {
            throw new Error('DISCORD_TOKEN is missing from environment variables.');
        }

        loadStore();
        loadWarnings();

        await client.login(process.env.DISCORD_TOKEN);

    } catch (error) {
        console.error('[STARTUP ERROR]', error);
        process.exit(1);
    }
}

startBot();
