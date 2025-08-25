import 'dotenv/config';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const {
  BOT_TOKEN,
  DEPT_GUILD_ID,
  RECOMMEND_CHANNEL_ID,
  ALLOWED_ROLE_IDS,
  RECRUITMENT_POLLS_CHANNEL_ID,
  VOTE_YES_EMOJI,
  VOTE_NO_EMOJI,
  PING_ROLE_ID,
  DB_PATH, // e.g. /data/recruitment.db on Railway
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/* =========================
   PERSISTENT STORAGE (SQLite)
   ========================= */
const db = new Database(DB_PATH || './recruitment.db');
db.pragma('journal_mode = wal');

db.exec(`
CREATE TABLE IF NOT EXISTS bg_checks (
  messageId TEXT PRIMARY KEY,
  status TEXT,                -- 'PASS' | 'FAILED' | NULL
  selected_json TEXT,         -- '["age","safechat",...]'
  updatedAt INTEGER
);

CREATE TABLE IF NOT EXISTS observations (
  messageId TEXT NOT NULL,
  idx INTEGER NOT NULL,       -- 1 | 2 | 3
  username TEXT,
  date TEXT,
  notes TEXT,
  issues TEXT,
  byUserId TEXT,
  createdAt INTEGER,
  PRIMARY KEY (messageId, idx)
);

-- store all messages we must keep in sync (original + polls)
CREATE TABLE IF NOT EXISTS message_refs (
  originMessageId TEXT NOT NULL,   -- the original recommendation messageId
  channelId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  PRIMARY KEY (originMessageId, messageId)
);
`);

function addMsgRef(originMessageId, channelId, messageId) {
  db.prepare(
    `INSERT OR IGNORE INTO message_refs (originMessageId, channelId, messageId) VALUES (?,?,?)`
  ).run(originMessageId, channelId, messageId);
}
function getMsgRefs(originMessageId) {
  return db
    .prepare(`SELECT channelId, messageId FROM message_refs WHERE originMessageId=?`)
    .all(originMessageId);
}

function saveBgSelection(messageId, values) {
  db.prepare(
    `
    INSERT INTO bg_checks (messageId, status, selected_json, updatedAt)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(messageId) DO UPDATE SET selected_json=excluded.selected_json, updatedAt=excluded.updatedAt
  `
  ).run(messageId, JSON.stringify(values || []), Date.now());
}
function setBgStatus(messageId, status) {
  db.prepare(
    `
    INSERT INTO bg_checks (messageId, status, selected_json, updatedAt)
    VALUES (?, ?, COALESCE((SELECT selected_json FROM bg_checks WHERE messageId=?), '[]'), ?)
    ON CONFLICT(messageId) DO UPDATE SET status=excluded.status, updatedAt=excluded.updatedAt
  `
  ).run(messageId, status, messageId, Date.now());
}
function getBg(messageId) {
  return db
    .prepare(`SELECT status, selected_json FROM bg_checks WHERE messageId=?`)
    .get(messageId) || {};
}

function saveObservation(messageId, idx, data) {
  db.prepare(
    `
    INSERT INTO observations (messageId, idx, username, date, notes, issues, byUserId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(messageId, idx) DO UPDATE SET
      username=excluded.username,
      date=excluded.date,
      notes=excluded.notes,
      issues=excluded.issues,
      byUserId=excluded.byUserId
  `
  ).run(
    messageId,
    Number(idx),
    data.username,
    data.date,
    data.notes,
    data.issues,
    data.byUserId,
    Date.now()
  );
}
function getObservation(messageId, idx) {
  return db
    .prepare(`SELECT * FROM observations WHERE messageId=? AND idx=?`)
    .get(messageId, Number(idx));
}
function getDoneSet(messageId) {
  const rows = db.prepare(`SELECT idx FROM observations WHERE messageId=?`).all(messageId);
  return new Set(rows.map((r) => String(r.idx)));
}
function haveAllThree(messageId) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM observations WHERE messageId=?`).get(messageId);
  return (row?.c || 0) >= 3;
}

/* =========================
   EPHEMERAL STASH (upload)
   ========================= */
// Slash -> modal stash (just for the 1-step handoff)
const pendingProof = new Map();

/* =========================
   HELPERS
   ========================= */
function buildChecklistLinesFromSelected(selected) {
  const items = [
    { key: 'age', label: '60+ day account age' },
    { key: 'safechat', label: 'No Safechat' },
    { key: 'seen', label: 'Seen 2+ days by recommender' },
    { key: 'comms', label: 'In communications server' },
    { key: 'history', label: 'No major history/MR restrictions' },
  ];
  const s = new Set(selected || []);
  return items.map((i) => `${s.has(i.key) ? '✅' : '❌'} ${i.label}`);
}

function buildObsRowFromDb(originMessageId) {
  const done = getDoneSet(originMessageId);

  const mk = (idx) => {
    const i = String(idx);
    if (done.has(i)) {
      return new ButtonBuilder()
        .setCustomId(`obs:view:${originMessageId}:${i}`)
        .setLabel(`View Observation ${i}`)
        .setStyle(ButtonStyle.Primary);
    }
    return new ButtonBuilder()
      .setCustomId(`obs:start:${originMessageId}:${i}`)
      .setLabel(`Observation ${i}`)
      .setStyle(ButtonStyle.Secondary);
  };

  return new ActionRowBuilder().addComponents(mk(1), mk(2), mk(3));
}

async function editAllObsMessagesFromDb(client, originMessageId) {
  const components = [buildObsRowFromDb(originMessageId)];
  const refs = getMsgRefs(originMessageId);
  await Promise.all(
    refs.map(async ({ channelId, messageId }) => {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch) return;
      const m = await ch.messages.fetch(messageId).catch(() => null);
      if (!m) return;
      await m.edit({ components }).catch(() => {});
    })
  );
}

async function reactWith(message, emoji) {
  if (!emoji) return;
  try {
    await message.react(emoji);
  } catch {}
}

/* =========================
   BOT
   ========================= */
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    /* ------- /recommend ------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'recommend') {
      if (ALLOWED_ROLE_IDS) {
        const allowed = new Set(ALLOWED_ROLE_IDS.split(',').map((s) => s.trim()));
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.some((r) => allowed.has(r.id))) {
          return interaction.reply({ ephemeral: true, content: 'You do not have permission to use this command.' });
        }
      }

      const proof = interaction.options.getAttachment('safechat_proof');
      if (!proof) return interaction.reply({ ephemeral: true, content: '❌ You must upload a Safechat proof image.' });

      const okTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
      if (proof.size > 8 * 1024 * 1024 || (proof.contentType && !okTypes.includes(proof.contentType))) {
        return interaction.reply({ ephemeral: true, content: '❌ Proof must be an image ≤ 8MB (png/jpg/webp/gif).' });
      }

      const token = interaction.id;
      pendingProof.set(token, {
        fileName: proof.name ?? 'proof.png',
        url: proof.url,
        userId: interaction.user.id,
        createdAt: Date.now(),
      });
      setTimeout(() => pendingProof.delete(token), 3 * 60_000);

      const req = [
        'Hey, Supervisors! Welcome to the Management Recommendations form, here you will be able to recommend some hard working Experienced Staff, please make sure that they follow the following criteria before you officially recommend them.',
        '',
        '💄 **Experienced Staff Criteria**',
        '- Their account must be at least **60-days (2 months) old** in order to be recommended, this is to prevent troll accounts being accepted into the team.',
        '- They must not have **safe chat** on their account, you may check through the info command or PM them to repeat a working phrase.',
        '- They must be seen by you for at least **2+ days** in order to be recommended, as recruitment will check for their overall activity in the game.',
        '- They must be a member in our **communications server**, please type in their user in a chat they are in to see if their user pops up.',
        '- They must not have any **major history/MR restrictions** with Flawn Salon, the Recruitment Members will be able to check for you before you recommend any. You can DM them, as it is not recommended to ping them anywhere in the MR chat.',
        '',
        'If you have any concerns in regards of recommendations, please feel free to DM a member of the Recruitment Department. Have fun recommending!',
      ].join('\n');

      const embed = new EmbedBuilder().setTitle('Recommendation Requirements').setDescription(req).setColor(0x5865f2);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`recommend:continue:${token}`).setLabel('Continue').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`recommend:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
      return;
    }

    /* ------- continue -> modal ------- */
    if (interaction.isButton() && interaction.customId.startsWith('recommend:continue:')) {
      const token = interaction.customId.split(':')[2];
      const stash = pendingProof.get(token);
      if (!stash || stash.userId !== interaction.user.id) {
        return interaction.reply({ ephemeral: true, content: '❌ Session expired. Please run `/recommend` again.' });
      }

      const modal = new ModalBuilder().setCustomId(`recommend_modal:${token}`).setTitle('Recommendation');

      const lrInput = new TextInputBuilder()
        .setCustomId('lr_username')
        .setLabel('Roblox Username (LR)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Why are you recommending this individual?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      await interaction.showModal(
        modal.addComponents(
          new ActionRowBuilder().addComponents(lrInput),
          new ActionRowBuilder().addComponents(reasonInput)
        )
      );
      return;
    }

    /* ------- cancel ------- */
    if (interaction.isButton() && interaction.customId.startsWith('recommend:cancel:')) {
      const token = interaction.customId.split(':')[2];
      pendingProof.delete(token);
      return interaction.update({ content: '❌ Recommendation cancelled.', embeds: [], components: [] });
    }

    /* ------- modal submit -> post recommendation ------- */
    if (interaction.isModalSubmit() && interaction.customId.startsWith('recommend_modal:')) {
      const token = interaction.customId.split(':')[1];
      const stash = pendingProof.get(token);
      if (!stash || stash.userId !== interaction.user.id) {
        return interaction.reply({ ephemeral: true, content: '❌ Session expired. Please run `/recommend` again.' });
      }

      const lrUsername = interaction.fields.getTextInputValue('lr_username').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 1024);

      const dest = await client.channels.fetch(RECOMMEND_CHANNEL_ID).catch(() => null);
      if (!dest || dest.type !== ChannelType.GuildText || dest.guildId !== DEPT_GUILD_ID) {
        return interaction.reply({ ephemeral: true, content: '❌ Destination channel not found or mismatched.' });
      }

      const me = dest.guild.members.me ?? (await dest.guild.members.fetchMe());
      const needed = new PermissionsBitField([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks]);
      if (!me.permissionsIn(dest).has(needed)) {
        return interaction.reply({ ephemeral: true, content: '❌ I am missing permissions to post in the destination channel.' });
        }

      const recEmbed = new EmbedBuilder()
        .setTitle('Recommendation')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Recommender', value: `${interaction.user}`, inline: false },
          { name: 'LR Username', value: lrUsername, inline: true },
          { name: 'Reason', value: reason || '—', inline: false }
        )
        .setFooter({ text: `Submitted from: ${interaction.guild?.name ?? 'Unknown'}` })
        .setTimestamp()
        .setImage(stash.url);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:start`).setLabel('Background check').setStyle(ButtonStyle.Secondary)
      );

      const sent = await dest.send({
        content: PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : null,
        embeds: [recEmbed],
        components: [row],
      });

      // track original message as a ref so we can edit later
      addMsgRef(sent.id, sent.channelId, sent.id);

      pendingProof.delete(token);
      await interaction.reply({ ephemeral: true, content: '✅ Recommendation sent to the Recruitment Department. Thanks!' });
      return;
    }

   /* =========================
   BACKGROUND CHECK (DB-backed)
   ========================= */
if (interaction.isButton() && interaction.customId === 'bg:start') {
  // The message being clicked IS the origin
  const originMessageId = interaction.message.id;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`bg:menu:${originMessageId}`)
    .setPlaceholder('Select all items that PASS')
    .setMinValues(0)
    .setMaxValues(5)
    .addOptions(
      { label: '60+ day account age', value: 'age' },
      { label: 'No Safechat', value: 'safechat' },
      { label: 'Seen 2+ days by recommender', value: 'seen' },
      { label: 'In communications server', value: 'comms' },
      { label: 'No major history/MR restrictions', value: 'history' }
    );

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bg:pass:${originMessageId}`).setLabel('Pass').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bg:decline:${originMessageId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`bg:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    ephemeral: true,
    content: '**Background check**\nSelect all that **PASS**, then choose **Pass** or **Decline**.',
    components: [new ActionRowBuilder().addComponents(menu), actions],
  });
  return;
}

if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bg:menu:')) {
  const originMessageId = interaction.customId.split(':')[2];
  saveBgSelection(originMessageId, interaction.values);

  await interaction.update({
    content: `Selections saved (${interaction.values.length}/5). Choose **Pass** or **Decline** when ready.`,
    components: interaction.message.components,
  });
  return;
}

if (interaction.isButton() && interaction.customId === 'bg:cancel') {
  await interaction.update({ content: '❎ Background check cancelled.', components: [] });
  return;
}

if (
  interaction.isButton() &&
  (interaction.customId.startsWith('bg:pass:') || interaction.customId.startsWith('bg:decline:'))
) {
  const [, action, originMessageId] = interaction.customId.split(':');

  // Use PASS / FAIL for consistency with header text
  const statusWord = action === 'pass' ? 'PASS' : 'FAIL';
  const statusEmoji = action === 'pass' ? '✅' : '❌';
  setBgStatus(originMessageId, statusWord);

  // update original embed field
  const ch = interaction.channel;
  const msg = ch ? await ch.messages.fetch(originMessageId).catch(() => null) : null;
  if (!msg) {
    await interaction.update({ content: '❌ Could not update the original message.', components: [] });
    return;
  }

  const bg = getBg(originMessageId);
  const selected = JSON.parse(bg.selected_json || '[]');
  const lines = buildChecklistLinesFromSelected(selected); // array of "✅ 60+ day..." etc.

  const baseEmbed = msg.embeds?.[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
  const existing = baseEmbed.data.fields ?? [];

  // remove any prior background-check field (title may vary)
  const nextFields = existing.filter(
    (f) => !((f.name || '').toLowerCase().startsWith('background check') || (f.name || '').toLowerCase().includes('background check'))
  );

  // put PASS/FAIL in the field header; body is just the checklist
  const name = `${statusEmoji} Background Check: ${statusWord}`;
  const value = lines.join('\n');

  nextFields.push({ name, value, inline: false });
  baseEmbed.setFields(nextFields);

  if (action === 'pass') {
    await msg.edit({ embeds: [baseEmbed], components: [buildObsRowFromDb(originMessageId)] });
  } else {
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('bg:disabled').setLabel('Background check').setStyle(ButtonStyle.Secondary).setDisabled(true)
    );
    await msg.edit({ embeds: [baseEmbed], components: [disabledRow] });
  }

  await interaction.update({ content: `✅ Background check **${statusWord}** recorded.`, components: [] });
  return;
}

/* =========================
   OBSERVATIONS (3 slots, DB-backed)
   ========================= */

// Start (or view if already done)
if (interaction.isButton() && interaction.customId.startsWith('obs:start:')) {
  const [, , originMessageId, idx] = interaction.customId.split(':');

  // already done? show view
  const row = getObservation(originMessageId, idx);
  if (row) {
    // try to read LR username from the original Recommendation embed
    let lrUsername = '—';
    try {
      const refs = getMsgRefs(originMessageId);
      const originRef = refs.find(r => r.messageId === originMessageId) || refs[0];
      if (originRef) {
        const ch = await client.channels.fetch(originRef.channelId).catch(() => null);
        const origMsg = ch ? await ch.messages.fetch(originMessageId).catch(() => null) : null;
        const emb = origMsg?.embeds?.[0];
        const lrField = emb?.fields?.find(f => (f.name || '').toLowerCase() === 'lr username');
        if (lrField?.value) lrUsername = lrField.value;
      }
    } catch (_) {}

    const todayFallback = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

    const viewEmbed = new EmbedBuilder()
      .setTitle(`Observation ${idx}`)
      .setColor(0x43b581)
      .addFields(
        { name: 'Observer', value: row.byUserId ? `<@${row.byUserId}>` : '—', inline: false },
        { name: 'Date', value: row.date || todayFallback, inline: false },
        { name: 'Observation Notes', value: row.notes || '—', inline: false },
        { name: 'Observation Issues', value: row.issues || 'None', inline: false },
        { name: 'Recommended Individual', value: lrUsername, inline: false }
      )
      .setTimestamp();
    return interaction.reply({ ephemeral: true, embeds: [viewEmbed] });
  }

  // show modal (now WITH a Date field prefilled to today)
  const modal = new ModalBuilder().setCustomId(`obs:modal:${originMessageId}:${idx}`).setTitle(`Observation ${idx}`);

  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  const date = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Date')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(today); // prefill with today's date

  const notes = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Observation Notes')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  const issues = new TextInputBuilder()
    .setCustomId('issues')
    .setLabel('Observation Issues')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('If none, leave blank');

  await interaction.showModal(
    modal.addComponents(
      new ActionRowBuilder().addComponents(date),
      new ActionRowBuilder().addComponents(notes),
      new ActionRowBuilder().addComponents(issues)
    )
  );
  return;
}

// View
if (interaction.isButton() && interaction.customId.startsWith('obs:view:')) {
  const [, , originMessageId, idx] = interaction.customId.split(':');
  const row = getObservation(originMessageId, idx);
  if (!row) return interaction.reply({ ephemeral: true, content: '❌ Observation not available yet.' });

  // pull LR username from original embed
  let lrUsername = '—';
  try {
    const refs = getMsgRefs(originMessageId);
    const originRef = refs.find(r => r.messageId === originMessageId) || refs[0];
    if (originRef) {
      const ch = await client.channels.fetch(originRef.channelId).catch(() => null);
      const origMsg = ch ? await ch.messages.fetch(originMessageId).catch(() => null) : null;
      const emb = origMsg?.embeds?.[0];
      const lrField = emb?.fields?.find(f => (f.name || '').toLowerCase() === 'lr username');
      if (lrField?.value) lrUsername = lrField.value;
    }
  } catch (_) {}

  const todayFallback = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  const viewEmbed = new EmbedBuilder()
    .setTitle(`Observation ${idx}`)
    .setColor(0x43b581)
    .addFields(
      { name: 'Observer', value: row.byUserId ? `<@${row.byUserId}>` : '—', inline: false },
      { name: 'Date', value: row.date || todayFallback, inline: false },
      { name: 'Observation Notes', value: row.notes || '—', inline: false },
      { name: 'Observation Issues', value: row.issues || 'None', inline: false },
      { name: 'Recommended Individual', value: lrUsername, inline: false }
    )
    .setTimestamp();

  await interaction.reply({ ephemeral: true, embeds: [viewEmbed] });
  return;
}

// Modal submit (store; update buttons; mirror if all three done)
if (interaction.isModalSubmit() && interaction.customId.startsWith('obs:modal:')) {
  const [, , originMessageId, idx] = interaction.customId.split(':');

  // read date as submitted (fallback to today if somehow empty)
  const dateInput = (interaction.fields.getTextInputValue('date') || '').trim();
  const date = dateInput || new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });

  const notes = interaction.fields.getTextInputValue('notes').trim().slice(0, 1024);
  const issues = (interaction.fields.getTextInputValue('issues') || '').trim().slice(0, 1024);

  saveObservation(originMessageId, idx, {
    username: null, // not used; observer tracked via byUserId
    date,
    notes,
    issues,
    byUserId: interaction.user.id,
  });

  // refresh all copies (original + any polls)
  await editAllObsMessagesFromDb(client, originMessageId);

  // Mirror to polls when all three recorded
  if (haveAllThree(originMessageId) && RECRUITMENT_POLLS_CHANNEL_ID) {
    try {
      const refs = getMsgRefs(originMessageId);
      const originRef = refs.find((r) => r.messageId === originMessageId) || refs[0];
      const ch = originRef ? await client.channels.fetch(originRef.channelId).catch(() => null) : null;
      const orig = ch ? await ch.messages.fetch(originMessageId).catch(() => null) : null;
      const baseEmbed = orig?.embeds?.[0] ? EmbedBuilder.from(orig.embeds[0]) : null;

      const pollsCh = await client.channels.fetch(RECRUITMENT_POLLS_CHANNEL_ID).catch(() => null);
      if (pollsCh && baseEmbed) {
        const pollEmbed = EmbedBuilder.from(baseEmbed).setTitle('Promotion Poll');
        const pollsMsg = await pollsCh
          .send({
            content: PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : null,
            embeds: [pollEmbed],
            components: [buildObsRowFromDb(originMessageId)],
          })
          .catch(() => null);

        if (pollsMsg) {
          addMsgRef(originMessageId, pollsCh.id, pollsMsg.id);
          await reactWith(pollsMsg, VOTE_YES_EMOJI || '✅');
          await reactWith(pollsMsg, VOTE_NO_EMOJI || '❌');
        }
      }
    } catch (e) {
      console.error('Polls mirror failed:', e);
    }
  }

  // Send a nice confirmation with the same stacked fields
  let lrUsername = '—';
  try {
    const refs = getMsgRefs(originMessageId);
    const originRef = refs.find(r => r.messageId === originMessageId) || refs[0];
    if (originRef) {
      const ch = await client.channels.fetch(originRef.channelId).catch(() => null);
      const origMsg = ch ? await ch.messages.fetch(originMessageId).catch(() => null) : null;
      const emb = origMsg?.embeds?.[0];
      const lrField = emb?.fields?.find(f => (f.name || '').toLowerCase() === 'lr username');
      if (lrField?.value) lrUsername = lrField.value;
    }
  } catch (_) {}

  const confirm = new EmbedBuilder()
    .setTitle(`Observation ${idx} Recorded`)
    .setColor(0x43b581)
    .addFields(
      { name: 'Observer', value: `<@${interaction.user.id}>`, inline: false },
      { name: 'Date', value: date, inline: false },
      { name: 'Observation Notes', value: notes || '—', inline: false },
      { name: 'Observation Issues', value: issues || 'None', inline: false },
      { name: 'Recommended Individual', value: lrUsername, inline: false }
    )
    .setTimestamp();

  await interaction.reply({ ephemeral: true, embeds: [confirm] });
  return;
}


  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ ephemeral: true, content: '❌ Something went wrong.' });
      } catch {}
    }
  }
});

client.login(BOT_TOKEN);
