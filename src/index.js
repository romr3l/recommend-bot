import 'dotenv/config';
import {
  ActionRowBuilder,
  AttachmentBuilder,
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

// Stash the file from the slash command until the modal is submitted
// key = interaction.id; value = { fileName, url, userId, createdAt }
const pendingProof = new Map();

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // --- /recommend (expects an Attachment option named "safechat_proof") ---
    if (interaction.isChatInputCommand() && interaction.commandName === 'recommend') {
      // role gate
      if (ALLOWED_ROLE_IDS) {
        const allowed = new Set(ALLOWED_ROLE_IDS.split(',').map(s => s.trim()));
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const ok = member.roles.cache.some(r => allowed.has(r.id));
        if (!ok) {
          await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
          return;
        }
      }

      const proof = interaction.options.getAttachment('safechat_proof'); // from slash UI
      if (!proof) {
        await interaction.reply({ ephemeral: true, content: '❌ You must upload a Safechat proof image.' });
        return;
      }

      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
      if (proof.size > 8 * 1024 * 1024 || (proof.contentType && !allowedTypes.includes(proof.contentType))) {
        await interaction.reply({ ephemeral: true, content: '❌ Proof must be an image ≤ 8MB (png/jpg/webp/gif).' });
        return;
      }

      // Stash the attachment
      const token = interaction.id; // unique per invocation
      pendingProof.set(token, {
        fileName: proof.name ?? 'proof.png',
        url: proof.url,
        userId: interaction.user.id,
        createdAt: Date.now(),
      });
      // auto-expire in 3 minutes
      setTimeout(() => pendingProof.delete(token), 3 * 60_000);

      // Open the modal for text fields
      const modal = new ModalBuilder()
        .setCustomId(`recommend_modal:${token}`)
        .setTitle('LR Recommendation');

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

    // --- Modal submit: combine stashed file + form inputs and send ---
    if (interaction.isModalSubmit() && interaction.customId.startsWith('recommend_modal:')) {
      const token = interaction.customId.split(':')[1];
      const stash = pendingProof.get(token);

      if (!stash || stash.userId !== interaction.user.id) {
        await interaction.reply({ ephemeral: true, content: '❌ Session expired. Please run `/recommend` again.' });
        return;
      }

      const lrUsername = interaction.fields.getTextInputValue('lr_username').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 1024);

      const dest = await client.channels.fetch(RECOMMEND_CHANNEL_ID).catch(() => null);
      if (!dest || dest.type !== ChannelType.GuildText || dest.guildId !== DEPT_GUILD_ID) {
        await interaction.reply({ ephemeral: true, content: '❌ Destination channel not found or mismatched.' });
        return;
      }

      const me = dest.guild.members.me ?? (await dest.guild.members.fetchMe());
      const needed = new PermissionsBitField([
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.AttachFiles,
      ]);
      if (!me.permissionsIn(dest).has(needed)) {
        await interaction.reply({ ephemeral: true, content: '❌ I am missing permissions to post in the destination channel.' });
        return;
      }

     const file = new AttachmentBuilder(stash.url, { name: stash.fileName });

const embed = new EmbedBuilder()
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


      await dest.send({ embeds: [embed], files: [file] });

      pendingProof.delete(token);
      await interaction.reply({ ephemeral: true, content: '✅ Recommendation sent to the department server. Thanks!' });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: '❌ Something went wrong.' }); } catch {}
    }
  }
});

client.login(BOT_TOKEN);


