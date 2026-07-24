const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes, SlashCommandBuilder } = require('discord.js')
const cron = require('node-cron')

const TOKEN = process.env.TOKEN
const CLIENT_ID = process.env.CLIENT_ID
const GUILD_ID = process.env.GUILD_ID
const SCORES_CHANNEL_ID = process.env.SCORES_CHANNEL_ID
const STAFF_CHANNEL_ID = process.env.STAFF_CHANNEL_ID

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
})

let coins = {}
let markets = {}
let marketCounter = 0
let scoresMessageId = null

function calculateOdds(market) {
  const totalPerChoice = market.choices.map((_, i) =>
    Object.values(market.bets[i] || {}).reduce((a, b) => a + b, 0)
  )
  const totalAll = totalPerChoice.reduce((a, b) => a + b, 0)
  return market.choices.map((_, i) => {
    if (totalAll === 0 || totalPerChoice[i] === 0) return 2.00
    const rawOdds = (totalAll / totalPerChoice[i]) * 0.95
    return Math.max(1.01, Math.round(rawOdds * 100) / 100)
  })
}

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
      console.log('Donnees chargees')
    }
  } catch (e) {
    console.log('Pas de donnees existantes:', e.message)
  }
}

async function weeklyReset() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID)
    const members = await guild.members.fetch()
    coins = {}
    members.forEach(member => {
      if (!member.user.bot) coins[member.user.id] = 1000
    })
    await saveToDiscord()
    console.log('Reset effectue - 1000 coins distribues')
  } catch (e) {
    console.error('Erreur reset:', e.message)
  }
}

function formatCloseTime(dateStr) {
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) + ' CET'
  } catch {
    return dateStr
  }
}

function isMarketClosed(market) {
  if (market.closed) return true
  try {
    return new Date() >= new Date(market.closeTime)
  } catch {
    return false
  }
}

async function updateMarketMessage(market, channel) {
  const closed = isMarketClosed(market)
  const odds = calculateOdds(market)

  const embed = new EmbedBuilder()
    .setTitle(`[#${market.id}] ${market.title}`)
    .setColor(closed ? '#FF0000' : '#FFD700')
    .setFooter({ text: closed ? 'Market ferme - en attente des resultats' : `Fermeture : ${formatCloseTime(market.closeTime)}` })

  if (market.imageUrl) embed.setImage(market.imageUrl)

  let description = closed
    ? 'Market ferme - resultats a venir\n\n'
    : 'Placez vos paris ! Les cotes evoluent en temps reel.\nGains calcules sur la cote a la fermeture.\n\n'

  market.choices.forEach((choice, i) => {
    const totalBets = Object.values(market.bets[i] || {}).reduce((a, b) => a + b, 0)
    const betCount = Object.keys(market.bets[i] || {}).length
    description += `**${i + 1}. ${choice.label}**\n`
    description += `Cote : **x${odds[i]}** | ${betCount} pari(s) - ${totalBets} coins\n\n`
  })

  embed.setDescription(description)

  const buttons = market.choices.map((choice, i) =>
    new ButtonBuilder()
      .setCustomId(`bet_${market.id}_${i}`)
      .setLabel(`${choice.label} (x${odds[i]})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(closed)
  )

  const rows = []
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)))
  }

  return { embeds: [embed], components: rows }
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('createmarket')
      .setDescription('Cree un nouveau market de prediction')
      .addStringOption(o => o.setName('titre').setDescription('Titre du market').setRequired(true))
      .addStringOption(o => o.setName('fermeture').setDescription('Date et heure de fermeture (ex: 2026-07-25 20:00)').setRequired(true))
      .addChannelOption(o => o.setName('canal').setDescription('Canal ou publier').setRequired(true))
      .addStringOption(o => o.setName('choix1').setDescription('Choix 1').setRequired(true))
      .addStringOption(o => o.setName('choix2').setDescription('Choix 2').setRequired(true))
      .addStringOption(o => o.setName('choix3').setDescription('Choix 3').setRequired(false))
      .addStringOption(o => o.setName('choix4').setDescription('Choix 4').setRequired(false))
      .addStringOption(o => o.setName('choix5').setDescription('Choix 5').setRequired(false))
      .addStringOption(o => o.setName('choix6').setDescription('Choix 6').setRequired(false))
      .addStringOption(o => o.setName('choix7').setDescription('Choix 7').setRequired(false))
      .addStringOption(o => o.setName('choix8').setDescription('Choix 8').setRequired(false))
      .addStringOption(o => o.setName('image').setDescription('URL image (optionnel)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('resultat')
      .setDescription('Donne les resultats d un market et distribue les gains')
      .addStringOption(o => o.setName('id').setDescription('ID du market').setRequired(true))
      .addStringOption(o => o.setName('resultats').setDescription('Resultats par choix separes par / (ex: false/true/false)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('classement')
      .setDescription('Affiche le classement des coins'),

    new SlashCommandBuilder()
      .setName('mescoins')
      .setDescription('Affiche ton solde de coins'),

    new SlashCommandBuilder()
      .setName('givecoins')
      .setDescription('Donne des coins a tous les membres')
      .addIntegerOption(o => o.setName('montant').setDescription('Nombre de coins').setRequired(true)),

    new SlashCommandBuilder()
      .setName('markets')
      .setDescription('Liste tous les markets'),

  ].map(c => c.toJSON())

  const rest = new REST({ version: '10' }).setToken(TOKEN)
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  console.log('Commandes enregistrees')
}

client.on('ready', async () => {
  console.log(`Bot connecte : ${client.user.tag}`)
  await registerCommands()
  await loadFromDiscord()
  cron.schedule('1 0 * * 1', weeklyReset, { timezone: 'Europe/Paris' })
})

client.on('interactionCreate', async interaction => {

  if (interaction.isButton() && interaction.customId.startsWith('bet_')) {
    const parts = interaction.customId.split('_')
    const marketId = parts[1]
    const choiceIndex = parseInt(parts[2])
    const market = markets[marketId]

    if (!market || isMarketClosed(market)) {
      return interaction.reply({ content: 'Ce market est ferme.', ephemeral: true })
    }

    const modal = new ModalBuilder()
      .setCustomId(`betmodal_${marketId}_${choiceIndex}`)
      .setTitle(`Paris : ${market.choices[choiceIndex].label}`)

    const userCoins = coins[interaction.user.id] || 0
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel(`Combien de coins ? (Solde : ${userCoins})`)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Ex: 200')
      .setRequired(true)

    modal.addComponents(new ActionRowBuilder().addComponents(input))
    await interaction.showModal(modal)
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('betmodal_')) {
    const parts = interaction.customId.split('_')
    const marketId = parts[1]
    const choiceIndex = parseInt(parts[2])
    const market = markets[marketId]
    const userId = interaction.user.id
    const amount = parseInt(interaction.fields.getTextInputValue('amount'))

    if (isNaN(amount) || amount <= 0) {
      return interaction.reply({ content: 'Montant invalide.', ephemeral: true })
    }

    const userCoins = coins[userId] || 0
    if (userCoins < amount) {
      return interaction.reply({ content: `Pas assez de coins. Solde : **${userCoins} coins**`, ephemeral: true })
    }

    if (isMarketClosed(market)) {
      return interaction.reply({ content: 'Ce market est ferme.', ephemeral: true })
    }

    market.choices.forEach((_, i) => {
      if (market.bets[i] && market.bets[i][userId]) {
        coins[userId] = (coins[userId] || 0) + market.bets[i][userId]
        delete market.bets[i][userId]
      }
    })

    coins[userId] = (coins[userId] || 0) - amount
    if (!market.bets[choiceIndex]) market.bets[choiceIndex] = {}
    market.bets[choiceIndex][userId] = amount

    const channel = await client.channels.fetch(market.channelId)
    const message = await channel.messages.fetch(market.messageId)
    const updated = await updateMarketMessage(market, channel)
    await message.edit(updated)

    await saveToDiscord()

    const currentOdds = calculateOdds(market)
    await interaction.reply({
      content: `Tu as mise **${amount} coins** sur **${market.choices[choiceIndex].label}**\nGains calcules sur la cote a la fermeture (actuellement x${currentOdds[choiceIndex]})\nSolde restant : **${coins[userId]} coins**`,
      ephemeral: true
    })
  }

  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === 'createmarket') {
    const titre = interaction.options.getString('titre')
    const fermeture = interaction.options.getString('fermeture')
    const canal = interaction.options.getChannel('canal')
    const image = interaction.options.getString('image')

    const dateTest = new Date(fermeture)
    if (isNaN(dateTest.getTime())) {
      return interaction.reply({ content: 'Format de date invalide. Utilise : 2026-07-25 20:00', ephemeral: true })
    }

    const choices = []
    for (let i = 1; i <= 8; i++) {
      const choix = interaction.options.getString(`choix${i}`)
      if (choix) choices.push({ label: choix.trim() })
    }

    if (choices.length < 2) {
      return interaction.reply({ content: 'Il faut au moins 2 choix.', ephemeral: true })
    }

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

    // Envoyer les infos dans le canal staff
    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID)
    await staffChannel.send(
      `**Nouveau market cree**\n` +
      `**ID :** \`${marketId}\`\n` +
      `**Titre :** ${titre}\n` +
      `**Fermeture :** ${formatCloseTime(fermeture)}\n` +
      `**Choix :**\n${choices.map((c, i) => `  ${i + 1}. ${c.label}`).join('\n')}\n\n` +
      `Pour donner les resultats :\n` +
      `/resultat id:${marketId} resultats:true/false/${choices.map(() => '...').join('/')}\n` +
      `(un true/false par choix dans l ordre)`
    )

    await saveToDiscord()
    await interaction.reply({ content: `Market **#${marketId}** cree avec **${choices.length} choix** ! Fermeture le ${formatCloseTime(fermeture)}`, ephemeral: true })
  }

  if (interaction.commandName === 'resultat') {
    const marketId = interaction.options.getString('id')
    const resultatsRaw = interaction.options.getString('resultats')
    const market = markets[marketId]

    if (!market) {
      return interaction.reply({ content: `Market #${marketId} introuvable. Utilise /markets pour voir la liste.`, ephemeral: true })
    }

    if (market.resultDone) {
      return interaction.reply({ content: 'Le resultat de ce market a deja ete donne.', ephemeral: true })
    }

    const resultats = resultatsRaw.split('/').map(r => r.trim().toLowerCase() === 'true')

    if (resultats.length !== market.choices.length) {
      return interaction.reply({ content: `Tu dois donner ${market.choices.length} resultats separes par / (un par choix). Ex: true/false/false`, ephemeral: true })
    }

    market.closed = true
    market.resultDone = true

    const finalOdds = calculateOdds(market)
    const allWinners = []
    let totalLosers = 0

    market.choices.forEach((choice, i) => {
      const isWinner = resultats[i]
      if (isWinner && market.bets[i]) {
        Object.entries(market.bets[i]).forEach(([userId, amount]) => {
          const gain = Math.floor(amount * finalOdds[i])
          coins[userId] = (coins[userId] || 0) + gain
          allWinners.push({ userId, amount, gain, choice: choice.label, odds: finalOdds[i] })
        })
      } else if (!isWinner && market.bets[i]) {
        totalLosers += Object.keys(market.bets[i]).length
      }
    })

    const channel = await client.channels.fetch(market.channelId)
    const message = await channel.messages.fetch(market.messageId)
    const updated = await updateMarketMessage(market, channel)
    await message.edit(updated)

    let resultText = `## Resultats - ${market.title}\n\n`

    market.choices.forEach((choice, i) => {
      resultText += `${resultats[i] ? 'TRUE' : 'FALSE'} **${choice.label}**\n`
    })

    resultText += '\n'

    if (allWinners.length > 0) {
      resultText += `**Gagnants (${allWinners.length}) :**\n`
      allWinners.forEach(w => {
        resultText += `<@${w.userId}> - mise ${w.amount} sur **${w.choice}** - **+${w.gain} coins** (x${w.odds})\n`
      })
    } else {
      resultText += 'Aucun gagnant sur ce market.\n'
    }

    if (totalLosers > 0) {
      resultText += `\n${totalLosers} membre(s) ont perdu leurs coins.`
    }

    await channel.send(resultText)
    await saveToDiscord()
    await interaction.reply({ content: `Resultats du market #${marketId} publies et gains distribues !`, ephemeral: true })
  }

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
        .setTitle('CLASSEMENT PREDICTION MARKET')
        .setDescription(classement)
        .setColor('#FFD700')
        .setFooter({ text: 'Reset chaque lundi a minuit' })],
      ephemeral: false
    })
  }

  if (interaction.commandName === 'markets') {
    const openMarkets = Object.values(markets).filter(m => !isMarketClosed(m) && !m.resultDone)
    const closedMarkets = Object.values(markets).filter(m => isMarketClosed(m) || m.resultDone)

    let description = ''

    if (openMarkets.length > 0) {
      description += '**Markets ouverts :**\n'
      openMarkets.forEach(m => {
        description += `**#${m.id}** - ${m.title} (ferme le ${formatCloseTime(m.closeTime)})\n`
        m.choices.forEach((c, i) => { description += `  ${i + 1}. ${c.label}\n` })
        description += '\n'
      })
    }

    if (closedMarkets.length > 0) {
      description += '**Markets fermes :**\n'
      closedMarkets.forEach(m => {
        description += `**#${m.id}** - ${m.title} ${m.resultDone ? '(resultats donnes)' : '(en attente resultats)'}\n`
      })
    }

    if (!description) description = 'Aucun market pour le moment.'

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('LISTE DES MARKETS')
        .setDescription(description)
        .setColor('#FFD700')],
      ephemeral: true
    })
  }

  if (interaction.commandName === 'mescoins') {
    const userCoins = coins[interaction.user.id] || 0
    await interaction.reply({
      content: `Tu as actuellement **${userCoins} coins**`,
      ephemeral: true
    })
  }

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
    await interaction.reply({ content: `**${amount} coins** donnes a tous les membres !`, ephemeral: false })
  }
})

client.login(TOKEN)
