import 'dotenv/config';
import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
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
    GatewayIntentBits.MessageContent // harmless to keep; not strictly needed now
  ],
});

// stash file between slash -> continue -> modal
// key = token; value = { fileName, url, userId, createdAt }
const pendingProof = new Map();

// background-check sessions
// key = token; value = { msgId, channelId, guildId, lrUsername, selected:Set<string> }
const bgSessions = new Map();

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
        PermissionsBitField.Flags.AttachFiles,
      ]);
      if (!me.permissionsIn(dest).has(needed)) {
        return interaction.reply({ ephemeral: true, content: '❌ I am missing permissions to post in the destination channel.' });
      }

      const file = new AttachmentBuilder(stash.url, { name: stash.fileName });

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
        .setImage(`attachment://${stash.fileName}`);

      // Background check button
      const bgToken = crypto.randomUUID();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bg:start:${bgToken}`)
          .setLabel('Background check')
          .setStyle(ButtonStyle.Secondary)
      );

      const sent = await dest.send({ embeds: [recEmbed], files: [file], components: [row] });

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
    // Background Check Workflow
    // =======================

    // Start checklist (ephemeral)
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
      const submitRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bg:submit:${token}`).setLabel('Submit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bg:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        ephemeral: true,
        content: `**Background check for:** \`${ctx.lrUsername}\`\nSelect all that **PASS**, then press **Submit**.`,
        components: [controls, submitRow]
      });
      return;
    }

    // Update selections
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('bg:menu:')) {
      const token = interaction.customId.split(':')[2];
      const ctx = bgSessions.get(token);
      if (!ctx) return interaction.reply({ ephemeral: true, content: '❌ Session expired.' });

      ctx.selected = new Set(interaction.values);
      bgSessions.set(token, ctx);
      await interaction.update({
        content: `Selections saved (${ctx.selected.size}/5). Press **Submit** when done.`,
        components: interaction.message.components
      });
      return;
    }

    // Cancel BG
    if (interaction.isButton() && interaction.customId.startsWith('bg:cancel:')) {
      const token = interaction.customId.split(':')[2];
      bgSessions.delete(token);
      return interaction.update({ content: '❎ Background check cancelled.', components: [] });
    }

    // Submit results
    if (interaction.isButton() && interaction.customId.startsWith('bg:submit:')) {
      const token = interaction.customId.split(':')[2];
      const ctx = bgSessions.get(token);
      if (!ctx) return interaction.update({ content: '❌ Session expired.', components: [] });

      const items = [
        { key: 'age', label: '60+ day account age' },
        { key: 'safechat', label: 'No Safechat' },
        { key: 'seen', label: 'Seen 2+ days by recommender' },
        { key: 'comms', label: 'In communications server' },
        { key: 'history', label: 'No major history/MR restrictions' },
      ];

      const passed = (k) => ctx.selected && ctx.selected.has(k);
      const lines = items.map(i => `${passed(i.key) ? '✅' : '❌'} ${i.label}`);

      const ch = await client.channels.fetch(ctx.channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(ctx.msgId).catch(() => null) : null;
      if (!msg) {
        bgSessions.delete(token);
        return interaction.update({ content: '❌ Could not find the original message.', components: [] });
      }

      const allPass = items.every(i => passed(i.key));
      const result = new EmbedBuilder()
        .setTitle('Background Check Results')
        .setColor(allPass ? 0x2ecc71 : 0xed4245)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Reviewed by ${interaction.user.tag}` })
        .setTimestamp();

      await msg.reply({ embeds: [result] });

      bgSessions.delete(token);
      await interaction.update({ content: '✅ Submitted.', components: [] });
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

