import 'dotenv/config';
import crypto from 'node:crypto';
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
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// ---------- State ----------

// Slash -> modal stash
// key = token; value = { fileName, url, userId, createdAt }
const pendingProof = new Map();

// Background-check sessions
// key = token; value = { msgId, channelId, guildId, lrUsername, selected:Set<string> }
const bgSessions = new Map();

// Observation sessions
// key = obsToken; value = {
//   msgRefs: [{ channelId, msgId }], // original + polls copy
//   channelId, guildId, lrUsername,
//   done: Set<'1'|'2'>,
//   data: { '1'?: {username,date,notes,issues}, '2'?: {...} }
// }
const obsSessions = new Map();

// ---------- Helpers ----------

function buildChecklistLines(selectedSet) {
  const items = [
    { key: 'age',     label: '60+ day account age' },
    { key: 'safechat',label: 'No Safechat' },
    { key: 'seen',    label: 'Seen 2+ days by recommender' },
    { key: 'comms',   label: 'In communications server' },
    { key: 'history', label: 'No major history/MR restrictions' },
  ];
  const selected = selectedSet ?? new Set();
  return {
    items,
    lines: items.map(i => `${selected.has(i.key) ? '✅' : '❌'} ${i.label}`),
    allPass: items.every(i => selected.has(i.key)),
  };
}

// Edit the original message's embed and upsert the Background Check field
async function writeBgResultToMessage(client, ctx, statusEmoji, statusWord, lines) {
  const ch = await client.channels.fetch(ctx.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(ctx.msgId).catch(() => null) : null;
  if (!msg) throw new Error('Original message not found');

  const baseEmbed = msg.embeds?.[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
  const existing = baseEmbed.data.fields ?? [];

  const nextFields = existing.filter(f => (f.name || '').toLowerCase() !== 'background check');
  const value = `${statusEmoji} **Background check:** ${statusWord}\n${lines.join('\n')}`;
  nextFields.push({ name: 'Background check', value, inline: false });
  baseEmbed.setFields(nextFields);

  await msg.edit({ embeds: [baseEmbed] });
  return msg;
}

// Build the row of observation buttons
function buildObsRow(obsToken, ctx) {
  const o1 = ctx.done.has('1');
  const o2 = ctx.done.has('2');

  const b1 = o1
    ? new ButtonBuilder().setCustomId(`obs:view:${obsToken}:1`).setLabel('View Observation 1').setStyle(ButtonStyle.Primary)
    : new ButtonBuilder().setCustomId(`obs:start:${obsToken}:1`).setLabel('Observation 1').setStyle(ButtonStyle.Secondary);

  const b2 = o2
    ? new ButtonBuilder().setCustomId(`obs:view:${obsToken}:2`).setLabel('View Observation 2').setStyle(ButtonStyle.Primary)
    : new ButtonBuilder().setCustomId(`obs:start:${obsToken}:2`).setLabel('Observation 2').setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(b1, b2);
}

// Edit all copies (original + polls) of the recommendation message
async function editAllObsMessages(client, ctx, { components, embed }) {
  const refs = ctx.msgRefs || [];
  await Promise.all(refs.map(async ({ channelId, msgId }) => {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;
    const m = await ch.messages.fetch(msgId).catch(() => null);
    if (!m) return;
    const payload = {};
    if (components) payload.components = components;
    if (embed) payload.embeds = [embed];
    await m.edit(payload).catch(() => {});
  }));
}

async function reactWith(message, emoji) {
  if (!emoji) return;
  try { await message.react(emoji); } catch {}
}

// ---------- Bot ----------

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // /recommend
    if (interaction.isChatInputCommand() && interaction.commandName === 'recommend') {
      if (ALLOWED_ROLE_IDS) {
        const allowed = new Set(ALLOWED_ROLE_IDS.split(',').map(s => s.trim()));
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.some(r => allowed.has(r.id))) {
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
        'If you have any concerns in regards of recommendations, please feel free to DM a member of the Recruitment Department. Have fun recommending!'
      ].join('\n');

      const embed = new EmbedBuilder()
        .setTitle('Recommendation Requirements')
        .setDescription(req)
        .setColor(0x5865F2);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`recommend:continue:${token}`).setLabel('Continue').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`recommend:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
      return;
    }

    // continue -> modal
    if (interaction.isButton() && interaction.customId.startsWith('recommend:continue:')) {
      const token = interaction.customId.split(':')[2];
      const stash = pendingProof.get(token);
      if (!stash || stash.userId !== interaction.user.id) {
        return interaction.reply({ ephemeral: true, content: '❌ Session expired. Please run `/recommend` again.' });
      }

      const modal = new ModalBuilder()
        .setCustomId(`recommend_modal:${token}`)
        .setTitle('Recommendation');

      const lrInput = new TextInputBuilder().setCustomId('lr_username').setLabel('Roblox Username (LR)').setStyle(TextInputStyle.Short).setRequired(true);
      const reasonInput = new TextInputBuilder().setCustomId('reason').setLabel('Why are you recommending this individual?').setStyle(TextInputStyle.Paragraph).setRequired(true);

      await interaction.showModal(
        modal.addComponents(
          new ActionRowBuilder().addComponents(lrInput),
          new ActionRowBuilder().addComponents(reasonInput),
        )
      );
      return;
    }

    // cancel
    if (interaction.isButton() && interaction.customId.startsWith('recommend:cancel:')) {
      const token = interaction.customId.split(':')[2];
      pendingProof.delete(token);
      return interaction.update({ content: '❌ Recommendation cancelled.', embeds: [], components: [] });
    }

    // modal submit -> post recommendation
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
      const needed = new PermissionsBitField([
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
      ]);
      if (!me.permissionsIn(dest).has(needed)) {
        return interaction.reply({ ephemeral: true, content: '❌ I am missing permissions to post in the destination channel.' });
      }

      const recEmbed = new EmbedBuilder()
        .setTitle('Recommendation')
        .setColor(0x2ecc71)
        .addFields(
          { name: 'Recommender', value: `${interaction.user}`, inline: false },
          { name: 'LR Username', value: lrUsername, inline: true },
          { name: 'Reason', value: reason || '—', inline: false },
        )
        .setFooter({ text: `Submitted from: ${interaction.guild?.name ?? 'Unknown'}` })
        .setTimestamp()
        .setImage(stash.url);

      const bgToken = crypto.randomUUID();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:start:${bgToken}`).setLabel('Background check').setStyle(ButtonStyle.Secondary)
      );

    const sent = await dest.send({
  content: PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : null,  // 👈 ping role here
  embeds: [recEmbed],
  components: [row],
});


      bgSessions.set(bgToken, {
        msgId: sent.id,
        channelId: sent.channelId,
        guildId: sent.guildId,
        lrUsername,
        selected: new Set(),
      });

      pendingProof.delete(token);
      await interaction.reply({ ephemeral: true, content: '✅ Recommendation sent to the Recruitment Department. Thanks!' });
      return;
    }

    // ---------- Background Check ----------

    if (interaction.isButton() && interaction.customId.startsWith('bg:start:')) {
      const token = interaction.customId.split(':')[2];
      const ctx = bgSessions.get(token);
      if (!ctx) return interaction.reply({ ephemeral: true, content: '❌ This recommendation could not be found.' });

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`bg:menu:${token}`)
        .setPlaceholder('Select all items that PASS')
        .setMinValues(0)
        .setMaxValues(5)
        .addOptions(
          { label: '60+ day account age', value: 'age' },
          { label: 'No Safechat', value: 'safechat' },
          { label: 'Seen 2+ days by recommender', value: 'seen' },
          { label: 'In communications server', value: 'comms' },
          { label: 'No major history/MR restrictions', value: 'history' },
        );

      const controls = new ActionRowBuilder().addComponents(menu);
      const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:pass:${token}`).setLabel('Pass').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bg:decline:${token}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`bg:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );

      bgSessions.set(token, { ...ctx, selected: ctx.selected ?? new Set() });

      await interaction.reply({
        ephemeral: true,
        content: `**Background check for:** \`${ctx.lrUsername}\`\nSelect all that **PASS**, then choose **Pass** or **Decline**.`,
        components: [controls, actions]
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bg:menu:')) {
      const token = interaction.customId.split(':')[2];
      const ctx = bgSessions.get(token);
      if (!ctx) return interaction.reply({ ephemeral: true, content: '❌ Session expired.' });

      ctx.selected = new Set(interaction.values);
      bgSessions.set(token, ctx);

      const { allPass } = buildChecklistLines(ctx.selected);
      await interaction.update({
        content: `Selections saved (${ctx.selected.size}/5). ${allPass ? 'All checks currently passing.' : 'Some checks are not selected.'} Choose **Pass** or **Decline** when ready.`,
        components: interaction.message.components
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('bg:cancel:')) {
      const token = interaction.customId.split(':')[2];
      bgSessions.delete(token);
      await interaction.update({ content: '❎ Background check cancelled.', components: [] });
      return;
    }

    if (interaction.isButton() &&
        (interaction.customId.startsWith('bg:pass:') || interaction.customId.startsWith('bg:decline:'))) {

      const [, action, token] = interaction.customId.split(':');
      const ctx = bgSessions.get(token);
      if (!ctx) return interaction.update({ content: '❌ Session expired.', components: [] });

      const { lines } = buildChecklistLines(ctx.selected);
      const statusWord  = action === 'pass' ? 'PASS' : 'FAILED';
      const statusEmoji = action === 'pass' ? '✅'   : '❌';

      try {
        const msg = await writeBgResultToMessage(client, ctx, statusEmoji, statusWord, lines);

        if (action === 'pass') {
          // Start Observation session and show buttons
          const obsToken = crypto.randomUUID();
          const ctxForObs = {
            msgRefs: [{ channelId: msg.channelId, msgId: msg.id }],
            channelId: msg.channelId,
            guildId: msg.guildId,
            lrUsername: ctx.lrUsername,
            done: new Set(),
            data: {},
          };
          obsSessions.set(obsToken, ctxForObs);

          await msg.edit({ components: [buildObsRow(obsToken, ctxForObs)] });
        } else {
          // Declined: disable the BG button
          const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('bg:disabled').setLabel('Background check').setStyle(ButtonStyle.Secondary).setDisabled(true)
          );
          await msg.edit({ components: [disabledRow] });
        }
      } catch (e) {
        console.error(e);
        await interaction.update({ content: '❌ Could not update the original message.', components: [] });
        bgSessions.delete(token);
        return;
      }

      bgSessions.delete(token);
      await interaction.update({ content: `✅ Background check **${statusWord}** recorded.`, components: [] });
      return;
    }

    // ---------- Observation Stage ----------

    // Start (or view if already done)
    if (interaction.isButton() && interaction.customId.startsWith('obs:start:')) {
      const [, , obsToken, index] = interaction.customId.split(':');
      const ctx = obsSessions.get(obsToken);
      if (!ctx) return interaction.reply({ ephemeral: true, content: '❌ Observation session not found.' });

      if (ctx.done.has(index)) {
        const data = ctx.data?.[index];
        const viewEmbed = new EmbedBuilder()
          .setTitle(`Observation ${index}`)
          .setColor(0x43b581)
          .setDescription([
            `**Username:** ${data?.username ?? '—'}`,
            `**Date:** ${data?.date ?? '—'}`,
            `**Notes:** ${data?.notes ?? '—'}`,
            `**Issues:** ${data?.issues || 'None'}`,
          ].join('\n'))
          .setFooter({ text: `For: ${ctx.lrUsername}` })
          .setTimestamp();
        return interaction.reply({ ephemeral: true, embeds: [viewEmbed] });
      }

      const modal = new ModalBuilder()
        .setCustomId(`obs:modal:${obsToken}:${index}`)
        .setTitle(`Observation ${index}`);

      const u = new TextInputBuilder().setCustomId('username').setLabel('Username').setStyle(TextInputStyle.Short).setRequired(true);
      const d = new TextInputBuilder().setCustomId('date').setLabel('Date').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 08/24/2025');
      const notes = new TextInputBuilder().setCustomId('notes').setLabel('Observation Notes').setStyle(TextInputStyle.Paragraph).setRequired(true);
      const issues = new TextInputBuilder().setCustomId('issues').setLabel('Observation Issues').setStyle(TextInputStyle.Paragraph).setRequired(false);

      await interaction.showModal(
        modal.addComponents(
          new ActionRowBuilder().addComponents(u),
          new ActionRowBuilder().addComponents(d),
          new ActionRowBuilder().addComponents(notes),
          new ActionRowBuilder().addComponents(issues),
        )
      );
      return;
    }

    // View (explicit)
    if (interaction.isButton() && interaction.customId.startsWith('obs:view:')) {
      const [, , obsToken, index] = interaction.customId.split(':');
      const ctx = obsSessions.get(obsToken);
      if (!ctx || !ctx.done.has(index)) {
        return interaction.reply({ ephemeral: true, content: '❌ Observation not available yet.' });
      }
      const data = ctx.data?.[index];
      const viewEmbed = new EmbedBuilder()
        .setTitle(`Observation ${index}`)
        .setColor(0x43b581)
        .setDescription([
          `**Username:** ${data?.username ?? '—'}`,
          `**Date:** ${data?.date ?? '—'}`,
          `**Notes:** ${data?.notes ?? '—'}`,
          `**Issues:** ${data?.issues || 'None'}`,
        ].join('\n'))
        .setFooter({ text: `For: ${ctx.lrUsername}` })
        .setTimestamp();

      await interaction.reply({ ephemeral: true, embeds: [viewEmbed] });
      return;
    }

    // Modal submit (store; update buttons; mirror if both done)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('obs:modal:')) {
      const [, , obsToken, index] = interaction.customId.split(':');
      const ctx = obsSessions.get(obsToken);
      if (!ctx) return interaction.reply({ ephemeral: true, content: '❌ Observation session expired. Please try again.' });

      const username = interaction.fields.getTextInputValue('username').trim();
      const date     = interaction.fields.getTextInputValue('date').trim();
      const notes    = interaction.fields.getTextInputValue('notes').trim().slice(0, 1024);
      const issues   = (interaction.fields.getTextInputValue('issues') || '').trim().slice(0, 1024);

      ctx.done.add(index);
      ctx.data = ctx.data || {};
      ctx.data[index] = { username, date, notes, issues };
      obsSessions.set(obsToken, ctx);

      const rows = [buildObsRow(obsToken, ctx)];
      await editAllObsMessages(client, ctx, { components: rows });

      // Mirror to polls when both recorded
      if (ctx.done.has('1') && ctx.done.has('2') && RECRUITMENT_POLLS_CHANNEL_ID) {
        const firstRef = ctx.msgRefs[0];
        const origCh = await client.channels.fetch(firstRef.channelId).catch(() => null);
        const orig = origCh ? await origCh.messages.fetch(firstRef.msgId).catch(() => null) : null;
        const baseEmbed = orig?.embeds?.[0] ? EmbedBuilder.from(orig.embeds[0]) : null;

        const pollsCh = await client.channels.fetch(RECRUITMENT_POLLS_CHANNEL_ID).catch(() => null);
        if (pollsCh && baseEmbed) {
       const pollsMsg = await pollsCh.send({
  content: PING_ROLE_ID ? `<@&${PING_ROLE_ID}>` : null,  // 👈 ping role here too
  embeds: [baseEmbed],
  components: rows,
}).catch(() => null);

          if (pollsMsg) {
            ctx.msgRefs.push({ channelId: pollsCh.id, msgId: pollsMsg.id });
            obsSessions.set(obsToken, ctx);
            await reactWith(pollsMsg, VOTE_YES_EMOJI || '✅');
            await reactWith(pollsMsg, VOTE_NO_EMOJI  || '❌');
          }
        }
      }

      await interaction.reply({ ephemeral: true, content: `✅ Observation ${index} recorded. Use the blue button to view it.` });
      return;
    }

  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: '❌ Something went wrong.' }); } catch {}
    }
  }
});

client.login(BOT_TOKEN);
