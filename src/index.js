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
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// stash file between slash -> continue -> modal
// key = token; value = { fileName, url, userId, createdAt }
const pendingProof = new Map();

// background-check sessions
// key = token; value = { msgId, channelId, guildId, lrUsername, selected:Set<string> }
const bgSessions = new Map();

// observations: token -> { msgId, channelId, guildId, lrUsername, done:Set<'1'|'2'> }
const obsSessions = new Map();


client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // ---- /recommend (expects Attachment option "safechat_proof") ----
    if (interaction.isChatInputCommand() && interaction.commandName === 'recommend') {
      // role gate
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

      // stash
      const token = interaction.id;
      pendingProof.set(token, {
        fileName: proof.name ?? 'proof.png',
        url: proof.url,
        userId: interaction.user.id,
        createdAt: Date.now(),
      });
      setTimeout(() => pendingProof.delete(token), 3 * 60_000);

      // requirements embed
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
        new ButtonBuilder()
          .setCustomId(`recommend:continue:${token}`)
          .setLabel('Continue')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`recommend:cancel:${token}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({ ephemeral: true, embeds: [embed], components: [row] });
      return;
    }

    // ---- Continue -> open modal ----
    if (interaction.isButton() && interaction.customId.startsWith('recommend:continue:')) {
      const token = interaction.customId.split(':')[2];
      const stash = pendingProof.get(token);
      if (!stash || stash.userId !== interaction.user.id) {
        return interaction.reply({ ephemeral: true, content: '❌ Session expired. Please run `/recommend` again.' });
      }

      const modal = new ModalBuilder()
        .setCustomId(`recommend_modal:${token}`)
        .setTitle('Recommendation');

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
          new ActionRowBuilder().addComponents(reasonInput),
        )
      );
      return;
    }

    // ---- Cancel ----
    if (interaction.isButton() && interaction.customId.startsWith('recommend:cancel:')) {
      const token = interaction.customId.split(':')[2];
      pendingProof.delete(token);
      return interaction.update({ content: '❎ Recommendation cancelled.', embeds: [], components: [] });
    }

    // ---- Modal submit: combine and send (adds Background check button) ----
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
        // Use the CDN URL directly so edits don’t create a top-level attachment preview
        .setImage(stash.url);

      // Background check button
      const bgToken = crypto.randomUUID();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bg:start:${bgToken}`)
          .setLabel('Background check')
          .setStyle(ButtonStyle.Secondary)
      );

      const sent = await dest.send({ embeds: [recEmbed], components: [row] });

      // remember for bg flow
      bgSessions.set(bgToken, {
        msgId: sent.id,
        channelId: sent.channelId,
        guildId: sent.guildId,
        lrUsername,
        selected: new Set(),
      });

      pendingProof.delete(token);
      await interaction.reply({ ephemeral: true, content: '✅ Recommendation sent to the department server. Thanks!' });
      return;
    }

// =======================
// Background Check Workflow (writes into original embed + pass/decline)
// =======================

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

// helper: edit original message's embed and add/update "Background check" field
async function writeBgResultToMessage(client, ctx, statusEmoji, statusWord, lines) {
  const ch = await client.channels.fetch(ctx.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(ctx.msgId).catch(() => null) : null;
  if (!msg) throw new Error('Original message not found');

  const baseEmbed = msg.embeds?.[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
  const existing = baseEmbed.data.fields ?? [];

  // remove any previous "Background check" field and append fresh one
  const nextFields = existing.filter(f => (f.name || '').toLowerCase() !== 'background check');
  const value = `${statusEmoji} **Background check:** ${statusWord}\n${lines.join('\n')}`;
  nextFields.push({ name: 'Background check', value, inline: false });
  baseEmbed.setFields(nextFields);

  await msg.edit({ embeds: [baseEmbed] }); // components handled elsewhere
  return msg; // return so caller can attach obs buttons or disable
}

// Start checklist (ephemeral)
if (interaction.isButton() && interaction.customId.startsWith('bg:start:')) {
  const token = interaction.customId.split(':')[2];
  const ctx = bgSessions.get(token);
  if (!ctx) {
    await interaction.reply({ ephemeral: true, content: '❌ This recommendation could not be found.' });
    return;
  }

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

  // initialize selection set
  bgSessions.set(token, { ...ctx, selected: ctx.selected ?? new Set() });

  await interaction.reply({
    ephemeral: true,
    content: `**Background check for:** \`${ctx.lrUsername}\`\nSelect all that **PASS**, then choose **Pass** or **Decline**.`,
    components: [controls, actions]
  });
  return;
}

// Update selections
if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bg:menu:')) {
  const token = interaction.customId.split(':')[2];
  const ctx = bgSessions.get(token);
  if (!ctx) {
    await interaction.reply({ ephemeral: true, content: '❌ Session expired.' });
    return;
  }

  ctx.selected = new Set(interaction.values);
  bgSessions.set(token, ctx);

  const { allPass } = buildChecklistLines(ctx.selected);
  await interaction.update({
    content: `Selections saved (${ctx.selected.size}/5). ${allPass ? 'All checks currently passing.' : 'Some checks are not selected.'} Choose **Pass** or **Decline** when ready.`,
    components: interaction.message.components
  });
  return;
}

// Cancel BG
if (interaction.isButton() && interaction.customId.startsWith('bg:cancel:')) {
  const token = interaction.customId.split(':')[2];
  bgSessions.delete(token);
  await interaction.update({ content: '❎ Background check cancelled.', components: [] });
  return;
}

// Pass / Decline -> write into the original embed and then update components
if (interaction.isButton() &&
  (interaction.customId.startsWith('bg:pass:') || interaction.customId.startsWith('bg:decline:'))) {

  const [ , action, token ] = interaction.customId.split(':');
  const ctx = bgSessions.get(token);
  if (!ctx) {
    await interaction.update({ content: '❌ Session expired.', components: [] });
    return;
  }

  const { lines } = buildChecklistLines(ctx.selected);
  const statusWord  = action === 'pass' ? 'PASS'   : 'FAILED';
  const statusEmoji = action === 'pass' ? '✅'     : '❌';

  try {
    // 1) Update the embed (adds/updates Background check field)
    const msg = await writeBgResultToMessage(client, ctx, statusEmoji, statusWord, lines);

    // 2) Update components depending on result
    if (action === 'pass') {
      // Add Observation stage buttons
      const obsToken = crypto.randomUUID();
      obsSessions.set(obsToken, {
        msgId: msg.id,
        channelId: msg.channelId,
        guildId: msg.guildId,
        lrUsername: ctx.lrUsername,
        done: new Set(),
      });

      const obsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`obs:start:${obsToken}:1`).setLabel('Observation 1').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`obs:start:${obsToken}:2`).setLabel('Observation 2').setStyle(ButtonStyle.Primary),
      );

      await msg.edit({ components: [obsRow] });
    } else {
      // Declined: just disable Background check button
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('bg:disabled')
          .setLabel('Background check')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true)
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

// Open modal for Observation {index}
if (interaction.isButton() && interaction.customId.startsWith('obs:start:')) {
  const [, , obsToken, index] = interaction.customId.split(':');
  const ctx = obsSessions.get(obsToken);
  if (!ctx) {
    await interaction.reply({ ephemeral: true, content: '❌ Observation session not found.' });
    return;
  }
  if (ctx.done.has(index)) {
    await interaction.reply({ ephemeral: true, content: `🔒 Observation ${index} is already recorded.` });
    return;
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

// Submit Observation modal
if (interaction.isModalSubmit() && interaction.customId.startsWith('obs:modal:')) {
  const [, , obsToken, index] = interaction.customId.split(':');
  const ctx = obsSessions.get(obsToken);
  if (!ctx) {
    await interaction.reply({ ephemeral: true, content: '❌ Observation session expired. Please try again.' });
    return;
  }

  const username = interaction.fields.getTextInputValue('username').trim();
  const date = interaction.fields.getTextInputValue('date').trim();
  const notes = interaction.fields.getTextInputValue('notes').trim().slice(0, 1024);
  const issues = (interaction.fields.getTextInputValue('issues') || '').trim().slice(0, 1024);

  // fetch original message
  const ch = await client.channels.fetch(ctx.channelId).catch(() => null);
  const msg = ch ? await ch.messages.fetch(ctx.msgId).catch(() => null) : null;
  if (!msg) {
    await interaction.reply({ ephemeral: true, content: '❌ Could not find the recommendation message.' });
    return;
  }

  // upsert Observation {index} field into the embed
  const embed = msg.embeds?.[0] ? EmbedBuilder.from(msg.embeds[0]) : new EmbedBuilder();
  const fields = embed.data.fields ?? [];

  const name = `Observation ${index}`;
  const value = [
    `**Username:** ${username}`,
    `**Date:** ${date}`,
    `**Notes:** ${notes || '—'}`,
    `**Issues:** ${issues || 'None'}`,
  ].join('\n');

  const without = fields.filter(f => (f.name || '') !== name);
  without.push({ name, value, inline: false });
  embed.setFields(without);

  // update which obs are done
  ctx.done.add(index);
  obsSessions.set(obsToken, ctx);

  // build components: disable completed, keep remaining enabled
  const obs1Disabled = ctx.done.has('1');
  const obs2Disabled = ctx.done.has('2');

  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`obs:start:${obsToken}:1`).setLabel('Observation 1').setStyle(ButtonStyle.Primary).setDisabled(obs1Disabled),
    new ButtonBuilder().setCustomId(`obs:start:${obsToken}:2`).setLabel('Observation 2').setStyle(ButtonStyle.Primary).setDisabled(obs2Disabled),
  ));

  // if both done, add Approve/Decline buttons (no-op handlers for now)
  if (ctx.done.has('1') && ctx.done.has('2')) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`final:approve:${obsToken}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`final:decline:${obsToken}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    ));
  }

  await msg.edit({ embeds: [embed], components: rows });
  await interaction.reply({ ephemeral: true, content: `✅ Observation ${index} recorded.` });
  return;
}

// Placeholder final stage buttons (wired later)
if (interaction.isButton() &&
   (interaction.customId.startsWith('final:approve:') || interaction.customId.startsWith('final:decline:'))) {
  await interaction.reply({ ephemeral: true, content: 'ℹ️ Final approval logic not implemented yet.' });
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
