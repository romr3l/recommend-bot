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
    GatewayIntentBits.MessageContent // needed for message collectors to read attachments
  ],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    // 1) /recommend → show modal
    if (interaction.isChatInputCommand() && interaction.commandName === 'recommend') {
      // Role gate (enable when ready)
    if (ALLOWED_ROLE_IDS) {
       const allowed = new Set(ALLOWED_ROLE_IDS.split(',').map(s => s.trim()));
       const member = await interaction.guild.members.fetch(interaction.user.id);
       const ok = member.roles.cache.some(r => allowed.has(r.id));
        if (!ok) return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
       }

      const modal = new ModalBuilder()
        .setCustomId('recommend_modal')
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

      const recommenderInput = new TextInputBuilder()
        .setCustomId('recommender')
        .setLabel('Recommender (defaults to you)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder(interaction.user.tag);

      await interaction.showModal(
        modal.addComponents(
          new ActionRowBuilder().addComponents(lrInput),
          new ActionRowBuilder().addComponents(reasonInput),
          new ActionRowBuilder().addComponents(recommenderInput),
        )
      );
      return;
    }

    // 2) Modal submit → ask for image + collect
    if (interaction.isModalSubmit() && interaction.customId === 'recommend_modal') {
      const lrUsername = interaction.fields.getTextInputValue('lr_username').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim().slice(0, 1024);
      const recommenderText = (interaction.fields.getTextInputValue('recommender') || '').trim();

      await interaction.reply({
        ephemeral: true,
        content:
          '✅ Received your details.\nPlease **upload your Safechat proof image** in this channel within **2 minutes**. I’ll pick the first image you send.',
      });

      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.followUp({ ephemeral: true, content: 'I can only accept images in a standard text channel.' });
        return;
      }

      const filter = (m) => m.author.id === interaction.user.id && m.attachments.size > 0;
      const collector = channel.createMessageCollector({ filter, max: 1, time: 2 * 60_000 });

      collector.on('collect', async (m) => {
        const att = m.attachments.first();
        const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
        if (att.size > 8 * 1024 * 1024 || (att.contentType && !allowed.includes(att.contentType))) {
          await interaction.followUp({ ephemeral: true, content: '❌ The proof must be an image ≤ 8MB (png/jpg/webp/gif).' });
          return;
        }

        // Re-upload and show the image inside the embed
        const fileName = att.name ?? 'proof.png';
        const file = new AttachmentBuilder(att.url, { name: fileName });

        const embed = new EmbedBuilder()
          .setTitle('New LR Recommendation')
          .setColor(0x2ecc71)
          .addFields(
            { name: 'Recommender', value: recommenderText || `${interaction.user.tag} (${interaction.user})`, inline: false },
            { name: 'LR Username', value: lrUsername, inline: true },
            { name: 'Reason', value: reason || '—', inline: false },
          )
          .setFooter({ text: `Submitted from: ${interaction.guild?.name ?? 'Unknown'}` })
          .setTimestamp()
          .setImage(`attachment://${fileName}`);

        const dest = await client.channels.fetch(RECOMMEND_CHANNEL_ID).catch(() => null);
        if (!dest || dest.type !== ChannelType.GuildText || dest.guildId !== DEPT_GUILD_ID) {
          await interaction.followUp({ ephemeral: true, content: '❌ Destination channel not found or mismatched.' });
          return;
        }

        const me = dest.guild.members.me ?? (await dest.guild.members.fetchMe());
        const needed = new PermissionsBitField([
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.AttachFiles,
        ]);
        if (!me.permissionsIn(dest).has(needed)) {
          await interaction.followUp({ ephemeral: true, content: '❌ I am missing permissions to post in the destination channel.' });
          return;
        }

        await dest.send({ embeds: [embed], files: [file] });

        // (optional) tidy user proof message if bot can manage messages
        // if (me.permissionsIn(channel).has(PermissionsBitField.Flags.ManageMessages)) {
        //   m.delete().catch(() => {});
        // }

        await interaction.followUp({ ephemeral: true, content: '✅ Recommendation sent to the department server. Thanks!' });
      });

      collector.on('end', async (collected) => {
        if (collected.size === 0) {
          await interaction.followUp({ ephemeral: true, content: '⌛ Timed out waiting for the proof image. Run `/recommend` again when ready.' });
        }
      });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ ephemeral: true, content: '❌ Something went wrong.' }); } catch {}
    }
  }
});

client.login(BOT_TOKEN);


