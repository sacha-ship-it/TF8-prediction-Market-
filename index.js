const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, SlashCommandBuilder } = require('discord.js')
const cron = require('node-cron')

const TOKEN = process.env.TOKEN
const CLIENT_ID = process.env.CLIENT_ID
const GUILD_ID = process.env.GUILD_ID
const SCORES_CHANNEL_ID = process.env.SCORES_CHANNEL_ID

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
})

let coins = {}
let markets = {}
let marketCounter = 0
let scoresMessageId = null

// ─────────────────────────────────────────
// CALCUL DES COTES DYNAMIQUES
// ─────────────────────────────────────────

function calculateOdds(market) {
  const totalPerChoice = market.choices.map((_, i) => {
    return Object.values(market.bets[i] || {}).reduce((a, b) => a + b, 0)
  })
  const totalAll = totalPerChoice.reduce((a, b) => a + b, 0)

  return market.choices.map((_, i) => {
    if (totalAll === 0 || totalPerChoice[i] === 0) return 2.00
    // Cote = total misé sur tous les choix / total misé sur ce choix (avec marge de 5%)
    const rawOdds = (totalAll / totalPerChoice[i]) * 0.95
    return Math.max(1.01, Math.round(rawOdds * 100) / 100)
  })
}

// ─────────────────────────────────────────
// SAUVEGARDE / CHARGEMENT
// ─────────────────────────────────────────

async function saveToDiscord() {
  try {
    const channel = await client.channels.fetch(SCORES_CHANNEL_ID)
    const data = JSON.stringify({ coins, markets, marketCounter })
    const content = 'PMDATA:' + data
    if (scoresMessageId) {
      const msg = await channel.messages.fetch(scoresMessageId)
      await msg.edit(content)
    } else {
      const msg = await channel.send(content)
      scoresMessageId = msg.id
    }
  } catch (e) {
    console.error('Erreur sauvegarde:', e.message)
  }
}

async function loadFromDiscord() {
  try {
    const channel = await client.channels.fetch(SCORES_CHANNEL_ID)
    const messages = await channel.messages.fetch({ limit: 20 })
    const dataMsg = messages.find(m => m.author.id === client.user.id && m.content.startsWith('PMDATA:'))
    if (dataMsg) {
      const parsed = JSON.parse(dataMsg.content.replace('PMDATA:', ''))
      coins = parsed.coins || {}
      markets = parsed.markets || {}
      marketCounter = parsed.marketCounter || 0
      scoresMessageId = dataMsg.id
      console.log('Données chargées')
    }
  } catch (e) {
    console.log('Pas de données existantes:', e.message)
  }
}

// ─────────────────────────────────────────
// RESET HEBDOMADAIRE
// ─────────────────────────────────────────

async function weeklyReset() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    const members = await guild.members.fetch()
    coins = {}
    members.forEach(member => {
      if (!member.user.bot) coins[member.user.id] = 1000
    })
    await saveToDiscord()
    console.log('Reset effectué — 1000 coins distribués')
  } catch (e) {
    console.error('Erreur reset:', e.message)
  }
}

// ─────────────────────────────────────────
// AFFICHAGE MARKET
// ─────────────────────────────────────────

async function updateMarketMessage(market, channel) {
  const odds = calculateOdds(market)

  const embed = new EmbedBuilder()
    .setTitle(market.title)
    .setColor(market.closed ? '#FF0000' : '#FFD700')
    .setFooter({ text: market.closed ? '🔒 Market fermé — cotes figées' : `⏰ Fermeture : ${market.closeTime} — Les cotes évoluent en temps réel` })

  if (market.imageUrl) embed.setImage(market.imageUrl)

  let description = market.closed
    ? '🔒 **Market fermé — les gains sont calculés sur les cotes finales ci-dessous**\n\n'
    : '💰 **Placez vos paris ! Les cotes évoluent en fonction des mises.**\n⚠️ Vos gains seront calculés sur la cote à la fermeture du market.\n\n'

  market.choices.forEach((choice, i) => {
    const totalBets = Object.values(market.bets[i] || {}).reduce((a, b) => a + b, 0)
    const betCount = Object.keys(market.bets[i] || {}).length
    description += `**${choice.label}**\n`
    description += `📊 Cote actuelle : **x${odds[i]}**\n`
    description += `👥 ${betCount} pari(s) — ${totalBets} coins misés\n\n`
  })

  embed.setDescription(description)

  const buttons = market.choices.map((choice, i) =>
    new ButtonBuilder()
      .setCustomId(`bet_${market.id}_${i}`)
      .setLabel(`${choice.label} (x${odds[i]})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(market.closed)
  )

  const rows = []
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)))
  }

  return { embeds: [embed], components: rows }
}

// ─────────────────────────────────────────
// COMMANDES
// ─────────────────────────────────────────

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('createmarket')
      .setDescription('Crée un nouveau market de prédiction')
      .addStringOption(o => o.setName('titre').setDescription('Titre du market').setRequired(true))
      .addStringOption(o => o.setName('fermeture').setDescription('Date/heure de fermeture').setRequired(true))
      .addStringOption(o => o.setName('choix').setDescription('Choix séparés par | (ex: SP500 vert|SP500 rouge)').setRequired(true))
      .addChannelOption(o => o.setName('canal').setDescription('Canal où publier').setRequired(true))
      .addStringOption(o => o.setName('image').setDescription('URL image (optionnel)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('closemarket')
      .setDescription('Ferme un market et distribue les gains selon les cotes finales')
      .addStringOption(o => o.setName('id').setDescription('ID du market').setRequired(true))
      .addIntegerOption(o => o.setName('gagnant').setDescription('Numéro du choix gagnant (commence à 1)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Affiche le classement des coins Prediction Market'),

    new SlashCommandBuilder()
      .setName('mescoins')
      .setDescription('Affiche ton solde de coins'),

    new SlashCommandBuilder()
      .setName('givecoins')
      .setDescription('Donne des coins à tous les membres')
      .addIntegerOption(o => o.setName('montant').setDescription('Nombre de coins').setRequired(true)),
  ].map(c => c.toJSON())

  const rest = new REST({ version: '10' }).setToken(TOKEN)
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  console.log('Commandes enregistrées')
}

// ─────────────────────────────────────────
// READY
// ─────────────────────────────────────────

client.on('ready', async () => {
  console.log(`Bot connecté : ${client.user.tag}`)
  await registerCommands()
  await loadFromDiscord()
  cron.schedule('1 0 * * 1', weeklyReset, { timezone: 'Europe/Paris' })
})

// ─────────────────────────────────────────
// INTERACTIONS
// ─────────────────────────────────────────

client.on('interactionCreate', async interaction => {

  // ── BOUTON PARIS ──
  if (interaction.isButton() && interaction.customId.startsWith('bet_')) {
    const parts = interaction.customId.split('_')
    const marketId = parts[1]
    const choiceIndex = parseInt(parts[2])
    const market = markets[marketId]

    if (!market || market.closed) {
      return interaction.reply({ content: '❌ Ce market est fermé.', ephemeral: true })
    }

    const modal = new ModalBuilder()
      .setCustomId(`betmodal_${marketId}_${choiceIndex}`)
      .setTitle(`Paris sur : ${market.choices[choiceIndex].label}`)

    const userCoins = coins[interaction.user.id] || 0
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel(`Combien de coins ? (Solde : ${userCoins} coins)`)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex: 200')
      .setRequired(true)

    modal.addComponents(new ActionRowBuilder().addComponents(input))
    await interaction.showModal(modal)
  }

  // ── MODAL PARIS ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('betmodal_')) {
    const parts = interaction.customId.split('_')
    const marketId = parts[1]
    const choiceIndex = parseInt(parts[2])
    const market = markets[marketId]
    const userId = interaction.user.id
    const amount = parseInt(interaction.fields.getTextInputValue('amount'))

    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: '❌ Montant invalide.', ephemeral: true })
    }

    const userCoins = coins[userId] || 0
    if (userCoins < amount) {
      return interaction.reply({ content: `❌ Pas assez de coins. Solde : **${userCoins} coins**`, ephemeral: true })
    }

    if (market.closed) {
      return interaction.reply({ content: '❌ Ce market est fermé.', ephemeral: true })
    }

    // Rembourser l'ancien pari sur ce market si existant
    market.choices.forEach((_, i) => {
      if (market.bets[i] && market.bets[i][userId]) {
        coins[userId] = (coins[userId] || 0) + market.bets[i][userId]
        delete market.bets[i][userId]
      }
    })

    // Déduire les coins et enregistrer le pari
    coins[userId] = (coins[userId] || 0) - amount
    if (!market.bets[choiceIndex]) market.bets[choiceIndex] = {}
    market.bets[choiceIndex][userId] = amount

    // Mettre à jour le message du market avec les nouvelles cotes
    const channel = await client.channels.fetch(market.channelId)
    const message = await channel.messages.fetch(market.messageId)
    const updated = await updateMarketMessage(market, channel)
    await message.edit(updated)

    await saveToDiscord()

    const currentOdds = calculateOdds(market)
    await interaction.reply({
      content: `✅ Tu as misé **${amount} coins** sur **${market.choices[choiceIndex].label}**\n⚠️ Tes gains seront calculés sur la **cote à la fermeture** (actuellement x${currentOdds[choiceIndex]})\nSolde restant : **${coins[userId]} coins**`,
      ephemeral: true
    })
  }

  if (!interaction.isChatInputCommand()) return

  // ── CREATEMARKET ──
  if (interaction.commandName === 'createmarket') {
    const titre = interaction.options.getString('titre')
    const fermeture = interaction.options.getString('fermeture')
    const choixRaw = interaction.options.getString('choix')
    const canal = interaction.options.getChannel('canal')
    const image = interaction.options.getString('image')

    const choices = choixRaw.split('|').map(c => ({ label: c.trim() }))

    marketCounter++
    const marketId = String(marketCounter)

    const market = {
      id: marketId,
      title: titre,
      closeTime: fermeture,
      choices,
      bets: {},
      closed: false,
      channelId: canal.id,
      messageId: null,
      imageUrl: image || null
    }

    markets[marketId] = market

    const content = await updateMarketMessage(market, canal)
    const msg = await canal.send(content)
    market.messageId = msg.id

    await saveToDiscord()
    await interaction.reply({ content: `✅ Market créé ! ID : **${marketId}**`, ephemeral: true })
  }

  // ── CLOSEMARKET ──
  if (interaction.commandName === 'closemarket') {
    const marketId = interaction.options.getString('id')
    const gagnantIndex = interaction.options.getInteger('gagnant') - 1
    const market = markets[marketId]

    if (!market) return interaction.reply({ content: '❌ Market introuvable.', ephemeral: true })

    market.closed = true

    // Calcul des cotes FINALES au moment de la fermeture
    const finalOdds = calculateOdds(market)
    const winningOdds = finalOdds[gagnantIndex]
    const winningChoice = market.choices[gagnantIndex]
    const winners = []
    const losers = []

    // Distribuer les gains aux gagnants
    if (market.bets[gagnantIndex]) {
      Object.entries(market.bets[gagnantIndex]).forEach(([userId, amount]) => {
        const gain = Math.floor(amount * winningOdds)
        coins[userId] = (coins[userId] || 0) + gain
        winners.push({ userId, amount, gain })
      })
    }

    // Les perdants ont déjà perdu leurs coins au moment du pari
    market.choices.forEach((_, i) => {
      if (i !== gagnantIndex && market.bets[i]) {
        Object.entries(market.bets[i]).forEach(([userId, amount]) => {
          losers.push({ userId, amount })
        })
      }
    })

    // Mettre à jour le message du market
    const channel = await client.channels.fetch(market.channelId)
    const message = await channel.messages.fetch(market.messageId)
    const updated = await updateMarketMessage(market, channel)
    await message.edit(updated)

    // Annoncer les résultats
    let resultText = `🏆 **Résultat : ${winningChoice.label}**\n`
    resultText += `📊 Cote finale : **x${winningOdds}**\n\n`

    if (winners.length > 0) {
      resultText += `**✅ Gagnants (${winners.length}) :**\n`
      winners.slice(0, 10).forEach(w => {
        resultText += `<@${w.userId}> — misé ${w.amount} → gagné **${w.gain} coins** (x${winningOdds})\n`
      })
      if (winners.length > 10) resultText += `...et ${winners.length - 10} autres gagnants\n`
    } else {
      resultText += 'Aucun gagnant sur ce market.\n'
    }

    if (losers.length > 0) {
      resultText += `\n**❌ ${losers.length} membre(s) ont perdu leurs coins**`
    }

    await channel.send(resultText)
    await saveToDiscord()
    await interaction.reply({ content: '✅ Market fermé et gains distribués selon les cotes finales !', ephemeral: true })
  }

  // ── CLASSEMENT ──
  if (interaction.commandName === 'classement') {
    const sorted = Object.entries(coins)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)

    const medals = ['🥇', '🥈', '🥉']
    const classement = sorted.length
      ? sorted.map(([id, c], i) => {
          const rank = medals[i] || (i + 1) + '.'
          return `${rank} <@${id}> : **${c} coins**`
        }).join('\n')
      : 'Aucun participant pour le moment.'

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🏆 CLASSEMENT PREDICTION MARKET')
        .setDescription(classement)
        .setColor('#FFD700')
        .setFooter({ text: 'Reset chaque lundi à minuit' })],
      ephemeral: false
    })
  }

  // ── MESCOINS ──
  if (interaction.commandName === 'mescoins') {
    const userCoins = coins[interaction.user.id] || 0
    await interaction.reply({
      content: `💰 Tu as actuellement **${userCoins} coins**`,
      ephemeral: true
    })
  }

  // ── GIVECOINS ──
  if (interaction.commandName === 'givecoins') {
    const amount = interaction.options.getInteger('montant')
    const guild = await client.guilds.fetch(GUILD_ID)
    const members = await guild.members.fetch()

    members.forEach(member => {
      if (!member.user.bot) {
        coins[member.user.id] = (coins[member.user.id] || 0) + amount
      }
    })

    await saveToDiscord()
    await interaction.reply({ content: `✅ **${amount} coins** donnés à tous les membres !`, ephemeral: false })
  }
})

client.login(TOKEN)
