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
    console.error('Save error:', e.message)
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
      console.log('Data loaded')
    }
  } catch (e) {
    console.log('No existing data:', e.message)
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
    console.log('Weekly reset done - 1000 coins distributed')
  } catch (e) {
    console.error('Reset error:', e.message)
  }
}

function formatCloseTime(dateStr) {
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('en-GB', {
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
    .setFooter({ text: closed ? 'Market closed - awaiting results' : `Closes : ${formatCloseTime(market.closeTime)}` })

  if (market.imageUrl) embed.setImage(market.imageUrl)

  let description = closed
    ? 'Market closed - results coming soon\n\n'
    : 'Place your bets! Odds update in real time.\nWinnings calculated on closing odds.\n\n'

  market.choices.forEach((choice, i) => {
    const totalBets = Object.values(market.bets[i] || {}).reduce((a, b) => a + b, 0)
    const betCount = Object.keys(market.bets[i] || {}).length
    description += `**${i + 1}. ${choice.label}**\n`
    description += `Odds : **x${odds[i]}** | ${betCount} bet(s) - ${totalBets} coins\n\n`
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
      .setDescription('Create a new prediction market')
      .addStringOption(o => o.setName('title').setDescription('Market title').setRequired(true))
      .addStringOption(o => o.setName('closing').setDescription('Closing date and time (ex: 2026-07-25 20:00)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(true))
      .addStringOption(o => o.setName('choice1').setDescription('Choice 1').setRequired(true))
      .addStringOption(o => o.setName('choice2').setDescription('Choice 2').setRequired(true))
      .addStringOption(o => o.setName('choice3').setDescription('Choice 3').setRequired(false))
      .addStringOption(o => o.setName('choice4').setDescription('Choice 4').setRequired(false))
      .addStringOption(o => o.setName('choice5').setDescription('Choice 5').setRequired(false))
      .addStringOption(o => o.setName('choice6').setDescription('Choice 6').setRequired(false))
      .addStringOption(o => o.setName('choice7').setDescription('Choice 7').setRequired(false))
      .addStringOption(o => o.setName('choice8').setDescription('Choice 8').setRequired(false))
      .addStringOption(o => o.setName('image').setDescription('Image URL (optional)').setRequired(false)),

    new SlashCommandBuilder()
      .setName('result')
      .setDescription('Set the results of a market and distribute winnings')
      .addStringOption(o => o.setName('id').setDescription('Market ID').setRequired(true))
      .addStringOption(o => o.setName('results').setDescription('Results per choice separated by / (ex: false/true/false)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the coins leaderboard'),

    new SlashCommandBuilder()
      .setName('mycoins')
      .setDescription('Show your coin balance'),

    new SlashCommandBuilder()
      .setName('givecoins')
      .setDescription('Give coins to all members')
      .addIntegerOption(o => o.setName('amount').setDescription('Number of coins').setRequired(true)),

    new SlashCommandBuilder()
      .setName('markets')
      .setDescription('List all markets'),

  ].map(c => c.toJSON())

  const rest = new REST({ version: '10' }).setToken(TOKEN)
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  console.log('Commands registered')
}

client.on('ready', async () => {
  console.log(`Bot connected : ${client.user.tag}`)
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
      return interaction.reply({ content: 'This market is closed.', ephemeral: true })
    }

    const modal = new ModalBuilder()
      .setCustomId(`betmodal_${marketId}_${choiceIndex}`)
      .setTitle(`Bet on : ${market.choices[choiceIndex].label}`)

    const userCoins = coins[interaction.user.id] || 0
    const input = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel(`How many coins? (Balance: ${userCoins})`)
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
      return interaction.reply({ content: 'Invalid amount.', ephemeral: true })
    }

    const userCoins = coins[userId] || 0
    if (userCoins < amount) {
      return interaction.reply({ content: `Not enough coins. Balance: **${userCoins} coins**`, ephemeral: true })
    }

    if (isMarketClosed(market)) {
      return interaction.reply({ content: 'This market is closed.', ephemeral: true })
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
      content: `You bet **${amount} coins** on **${market.choices[choiceIndex].label}**\nWinnings calculated on closing odds (currently x${currentOdds[choiceIndex]})\nRemaining balance: **${coins[userId]} coins**`,
      ephemeral: true
    })
  }

  if (!interaction.isChatInputCommand()) return

  if (interaction.commandName === 'createmarket') {
    const title = interaction.options.getString('title')
    const closing = interaction.options.getString('closing')
    const channel = interaction.options.getChannel('channel')
    const image = interaction.options.getString('image')

    const dateTest = new Date(closing)
    if (isNaN(dateTest.getTime())) {
      return interaction.reply({ content: 'Invalid date format. Use: 2026-07-25 20:00', ephemeral: true })
    }

    const choices = []
    for (let i = 1; i <= 8; i++) {
      const choice = interaction.options.getString(`choice${i}`)
      if (choice) choices.push({ label: choice.trim() })
    }

    if (choices.length < 2) {
      return interaction.reply({ content: 'You need at least 2 choices.', ephemeral: true })
    }

    marketCounter++
    const marketId = String(marketCounter)

    const market = {
      id: marketId,
      title,
      closeTime: closing,
      choices,
      bets: {},
      closed: false,
      channelId: channel.id,
      messageId: null,
      imageUrl: image || null
    }

    markets[marketId] = market

    const content = await updateMarketMessage(market, channel)
    const msg = await channel.send(content)
    market.messageId = msg.id

    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID)
    await staffChannel.send(
      `**New market created**\n` +
      `**ID:** \`${marketId}\`\n` +
      `**Title:** ${title}\n` +
      `**Closes:** ${formatCloseTime(closing)}\n` +
      `**Choices:**\n${choices.map((c, i) => `  ${i + 1}. ${c.label}`).join('\n')}\n\n` +
      `To set results:\n` +
      `/result id:${marketId} results:true/false/${choices.map(() => '...').join('/')}\n` +
      `(one true/false per choice in order)`
    )

    await saveToDiscord()
    await interaction.reply({ content: `Market **#${marketId}** created with **${choices.length} choices**! Closes on ${formatCloseTime(closing)}`, ephemeral: true })
  }

  if (interaction.commandName === 'result') {
    const marketId = interaction.options.getString('id')
    const resultsRaw = interaction.options.getString('results')
    const market = markets[marketId]

    if (!market) {
      return interaction.reply({ content: `Market #${marketId} not found. Use /markets to see the list.`, ephemeral: true })
    }

    if (market.resultDone) {
      return interaction.reply({ content: 'Results for this market have already been set.', ephemeral: true })
    }

    const results = resultsRaw.split('/').map(r => r.trim().toLowerCase() === 'true')

    if (results.length !== market.choices.length) {
      return interaction.reply({ content: `You must provide ${market.choices.length} results separated by / (one per choice). Ex: true/false/false`, ephemeral: true })
    }

    market.closed = true
    market.resultDone = true

    const finalOdds = calculateOdds(market)
    const allWinners = []
    let totalLosers = 0

    market.choices.forEach((choice, i) => {
      const isWinner = results[i]
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

    let resultText = `## Results - ${market.title}\n\n`

    market.choices.forEach((choice, i) => {
      resultText += `${results[i] ? 'TRUE' : 'FALSE'} **${choice.label}**\n`
    })

    resultText += '\n'

    if (allWinners.length > 0) {
      resultText += `**Winners (${allWinners.length}):**\n`
      allWinners.forEach(w => {
        resultText += `<@${w.userId}> - bet ${w.amount} on **${w.choice}** - **+${w.gain} coins** (x${w.odds})\n`
      })
    } else {
      resultText += 'No winners on this market.\n'
    }

    if (totalLosers > 0) {
      resultText += `\n${totalLosers} member(s) lost their coins.`
    }

    await channel.send(resultText)
    await saveToDiscord()
    await interaction.reply({ content: `Results for market #${marketId} published and winnings distributed!`, ephemeral: true })
  }

  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(coins)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)

    const medals = ['🥇', '🥈', '🥉']
    const leaderboard = sorted.length
      ? sorted.map(([id, c], i) => {
          const rank = medals[i] || (i + 1) + '.'
          return `${rank} <@${id}> : **${c} coins**`
        }).join('\n')
      : 'No participants yet.'

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('PREDICTION MARKET LEADERBOARD')
        .setDescription(leaderboard)
        .setColor('#FFD700')
        .setFooter({ text: 'Reset every Monday at midnight CET' })],
      ephemeral: false
    })
  }

  if (interaction.commandName === 'markets') {
    const openMarkets = Object.values(markets).filter(m => !isMarketClosed(m) && !m.resultDone)
    const closedMarkets = Object.values(markets).filter(m => isMarketClosed(m) || m.resultDone)

    let description = ''

    if (openMarkets.length > 0) {
      description += '**Open markets:**\n'
      openMarkets.forEach(m => {
        description += `**#${m.id}** - ${m.title} (closes ${formatCloseTime(m.closeTime)})\n`
        m.choices.forEach((c, i) => { description += `  ${i + 1}. ${c.label}\n` })
        description += '\n'
      })
    }

    if (closedMarkets.length > 0) {
      description += '**Closed markets:**\n'
      closedMarkets.forEach(m => {
        description += `**#${m.id}** - ${m.title} ${m.resultDone ? '(results set)' : '(awaiting results)'}\n`
      })
    }

    if (!description) description = 'No markets yet.'

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('MARKETS LIST')
        .setDescription(description)
        .setColor('#FFD700')],
      ephemeral: true
    })
  }

  if (interaction.commandName === 'mycoins') {
    const userCoins = coins[interaction.user.id] || 0
    await interaction.reply({
      content: `You currently have **${userCoins} coins**`,
      ephemeral: true
    })
  }

  if (interaction.commandName === 'givecoins') {
    const amount = interaction.options.getInteger('amount')
    const guild = await client.guilds.fetch(GUILD_ID)
    const members = await guild.members.fetch()

    members.forEach(member => {
      if (!member.user.bot) {
        coins[member.user.id] = (coins[member.user.id] || 0) + amount
      }
    })

    await saveToDiscord()
    await interaction.reply({ content: `**${amount} coins** given to all members!`, ephemeral: false })
  }
})

client.login(TOKEN)
