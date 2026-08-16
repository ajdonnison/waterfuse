'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execSync } = require('child_process')
const axios = require('axios')
const { TOTP, Secret } = require('otpauth')

// Force IPv4 — Node 18+ happy-eyeballs tries IPv6 first, which times out
// on networks where IPv6 routing to api.telegram.org isn't available
const httpsAgent = new https.Agent({ family: 4 })

const telegramToken = process.env.telegramToken
const totpSecret = process.env.totpSecret
const authFile = process.env.authFile || '/etc/waterfuse/authorized_chats.json'
const stateDir = '/run/waterfuse'
const stateFile = 'waterfuse.state'
const pidFile = path.join(stateDir, 'waterfuse.pid')
const logFile = '/var/log/waterfuse.log'

if (!telegramToken || !totpSecret) {
  console.error('telegramToken and totpSecret environment variables are required')
  process.exit(1)
}

const api = `https://api.telegram.org/bot${telegramToken}`
let pollOffset = 0

const totp = new TOTP({
  issuer: 'WaterFuse',
  label: 'WaterFuse',
  secret: Secret.fromBase32(totpSecret)
})

// Print setup URI on startup so the admin can add it to authenticator apps
console.log('Authenticator setup URI:', totp.toString())

function errMsg (err) {
  return err.message || err.code || String(err)
}

// ---- authorized chats -------------------------------------------------------

let authorizedChats = new Set()

function loadAuth () {
  try {
    const data = JSON.parse(fs.readFileSync(authFile, 'utf8'))
    authorizedChats = new Set(data)
    console.log(`Loaded ${authorizedChats.size} authorized chat(s)`)
  } catch (_) {}
}

function saveAuth () {
  try {
    fs.writeFileSync(authFile, JSON.stringify([...authorizedChats]))
  } catch (err) {
    console.error('Failed to save auth file:', errMsg(err))
  }
}

loadAuth()

// ---- Telegram helpers -------------------------------------------------------

async function sendMessage (chatId, text) {
  await axios.post(`${api}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  }, { httpsAgent })
}

async function broadcast (text) {
  for (const chatId of authorizedChats) {
    await sendMessage(chatId, text)
      .catch(err => console.error(`Broadcast to ${chatId} failed:`, errMsg(err)))
  }
}

// ---- state tracking ---------------------------------------------------------

let fileContents = ''
let oldContents = ''
let pumpStartTime = null // Date.now() when pump last started
let accumulatedRunMs = 0 // run time accrued from completed sessions

function formatDuration (ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function currentRuntime () {
  let ms = accumulatedRunMs
  if (pumpStartTime !== null) ms += Date.now() - pumpStartTime
  return formatDuration(ms)
}

function getDaemonPid () {
  return parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
}

function applyState (contents) {
  const [status] = contents.split(/\s+/)
  if (status === 'started') {
    pumpStartTime = Date.now()
  } else if (status === 'stopped' && pumpStartTime !== null) {
    accumulatedRunMs += Date.now() - pumpStartTime
    pumpStartTime = null
  }
}

// Seed from current state file so run-time tracking survives restarts
try {
  const init = fs.readFileSync(path.join(stateDir, stateFile), 'utf8').trim()
  fileContents = init
  oldContents = init
  const [status] = init.split(/\s+/)
  if (status === 'started') pumpStartTime = Date.now()
} catch (_) {}

fs.watch(stateDir, (type, fname) => {
  if (type === 'change' && fname === stateFile) {
    fs.readFile(path.join(stateDir, stateFile), (err, data) => {
      if (!err) fileContents = data.toString().trim()
    })
  }
})

setInterval(() => {
  if (oldContents === fileContents) return
  oldContents = fileContents
  applyState(fileContents)

  const [status, reason] = fileContents.split(/\s+/)
  broadcast(`*Pump Status Changed*\nPump is now *${status}*\nReason: ${reason}`)
}, 10)

// ---- command handling -------------------------------------------------------

async function handleUpdate (update) {
  const msg = update.message
  if (!msg || !msg.text) return

  const chatId = String(msg.chat.id)
  const text = msg.text.trim()

  // /auth is open to anyone
  if (text.startsWith('/auth')) {
    const code = text.split(/\s+/)[1] || ''
    const delta = totp.validate({ token: code, window: 1 })
    if (delta !== null) {
      authorizedChats.add(chatId)
      saveAuth()
      await sendMessage(chatId, 'Authorized. You will now receive pump status updates.')
    } else {
      await sendMessage(chatId, 'Invalid code.')
    }
    return
  }

  // /help is also freely available
  if (text === '/help') {
    await sendMessage(chatId, [
      'Waterfuse Telegram connector.',
      '',
      'Commands available:',
      '/help - this command, display help message',
      '/auth - authenticate, requires a TOTP token',
      '/deauth - de-authenticate',
      '/reset - re-enable flow after a stoppage',
      '/usage - return the current usage stats of the pump'
    ].join('\n'))
  }

  // All other commands require authorization — silently ignore unauthorized senders
  if (!authorizedChats.has(chatId)) return

  if (text === '/deauth') {
    authorizedChats.delete(chatId)
    saveAuth()
    await sendMessage(chatId, 'You have been removed from the authorized list.')
    return
  }

  if (text === '/reset') {
    try {
      process.kill(getDaemonPid(), 'SIGUSR1')
      await sendMessage(chatId, 'Reset signal sent — pump should restart.')
    } catch (err) {
      await sendMessage(chatId, `Reset failed: ${errMsg(err)}`)
    }
    return
  }

  if (text === '/usage') {
    try {
      process.kill(getDaemonPid(), 'SIGUSR2')
      await new Promise(resolve => setTimeout(resolve, 500))

      const log = execSync(`tail -20 "${logFile}"`).toString()
      const matches = log.match(/total_litres: (\d+)/g)
      const litres = matches
        ? matches[matches.length - 1].replace('total_litres: ', '')
        : 'unknown'

      await sendMessage(chatId,
        `*Water Usage*\nTotal litres: ${litres} L\nPump run time: ${currentRuntime()}`
      )
    } catch (err) {
      await sendMessage(chatId, `Usage query failed: ${errMsg(err)}`)
    }
  }
}

// Long-poll loop for incoming commands
async function poll () {
  while (true) {
    try {
      const res = await axios.get(`${api}/getUpdates`, {
        params: { offset: pollOffset, timeout: 30 },
        timeout: 35000,
        httpsAgent
      })
      for (const update of res.data.result) {
        pollOffset = update.update_id + 1
        handleUpdate(update).catch(err => console.error('Handler error:', errMsg(err)))
      }
    } catch (err) {
      console.error('Poll error:', errMsg(err))
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

poll()
