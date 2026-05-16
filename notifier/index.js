'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const axios = require('axios')

const token = process.env.telegramToken
const chatId = process.env.telegramChatId
const stateDir = '/run/waterfuse'
const stateFile = 'waterfuse.state'
const pidFile = path.join(stateDir, 'waterfuse.pid')
const logFile = '/var/log/waterfuse.log'

const api = `https://api.telegram.org/bot${token}`
let pollOffset = 0

let fileContents = ''
let oldContents = ''
let pumpStartTime = null   // Date.now() when pump last started
let accumulatedRunMs = 0   // run time accrued from completed sessions

// ---- helpers ----------------------------------------------------------------

function formatDuration(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function currentRuntime() {
  let ms = accumulatedRunMs
  if (pumpStartTime !== null) ms += Date.now() - pumpStartTime
  return formatDuration(ms)
}

function getDaemonPid() {
  return parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
}

async function sendMessage(cid, text) {
  await axios.post(`${api}/sendMessage`, {
    chat_id: cid,
    text,
    parse_mode: 'Markdown'
  })
}

// ---- state tracking ---------------------------------------------------------

function applyState(contents) {
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
} catch (_) { /* state file may not exist yet */ }

// Watch for changes and notify Telegram
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
  const message = `*Pump Status Changed*\nPump is now *${status}*\nReason: ${reason}`
  sendMessage(chatId, message)
    .catch(err => console.error('Notification failed:', err.message))
}, 10)

// ---- command handling -------------------------------------------------------

async function handleUpdate(update) {
  const msg = update.message
  if (!msg || !msg.text || String(msg.chat.id) !== String(chatId)) return

  const text = msg.text.trim()

  if (text === '/reset') {
    try {
      process.kill(getDaemonPid(), 'SIGUSR1')
      await sendMessage(msg.chat.id, 'Reset signal sent — pump should restart.')
    } catch (err) {
      await sendMessage(msg.chat.id, `Reset failed: ${err.message}`)
    }
  }

  if (text === '/usage') {
    try {
      process.kill(getDaemonPid(), 'SIGUSR2')
      // Give the daemon a moment to flush stats to the log
      await new Promise(resolve => setTimeout(resolve, 500))

      const log = execSync(`tail -20 "${logFile}"`).toString()
      const matches = log.match(/total_litres: (\d+)/g)
      const litres = matches
        ? matches[matches.length - 1].replace('total_litres: ', '')
        : 'unknown'

      await sendMessage(msg.chat.id,
        `*Water Usage*\nTotal litres: ${litres} L\nPump run time: ${currentRuntime()}`
      )
    } catch (err) {
      await sendMessage(msg.chat.id, `Usage query failed: ${err.message}`)
    }
  }
}

// Long-poll loop for incoming commands
async function poll() {
  while (true) {
    try {
      const res = await axios.get(`${api}/getUpdates`, {
        params: { offset: pollOffset, timeout: 30 },
        timeout: 35000
      })
      for (const update of res.data.result) {
        pollOffset = update.update_id + 1
        handleUpdate(update).catch(err => console.error('Handler error:', err.message))
      }
    } catch (err) {
      console.error('Poll error:', err.message)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

poll()
