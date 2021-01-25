'use strict'

const fs = require('fs')
const path = require('path')
const { on } = require('events')
const stateFile = 'waterfuse.state'
const stateDir = '/var/run/waterfuse'

let fileContents = ""
let oldContents = ""

const sendSlack = async function(message) {
  const { WebClient, LogLevel } = require("@slack/web-api")
  const channelId = process.env.slackChannel

  const token = process.env.slackToken
  const client = new WebClient(token, {
    logLevel: LogLevel.DEBUG
  })

  const messageArgs = {
    channel: channelId,
    text: message
  }

  try {
    const retval = client.chat.postMessage(messageArgs)
  }
  catch (error) {
    console.error(error)
    throw new Error(error)
  }
}

// Poll the state file and check for changes, when we get a change
// we send a message
fs.watch(stateDir, (type, fname) => {
  if (type === 'change' && fname && fname === stateFile) {
    fs.readFile(path.join(stateDir,stateFile), (err,data) => {
      fileContents = data.toString();
    })
  }
})

// Now we just keep an eye on the fileContent variable and if it changes
// we send out a message.  State file has two words in it, started or stopped
// and a reason code

setInterval(async () => {
  if (oldContents != fileContents) {
    oldContents = fileContents
    const content = oldContents.split(/\s/)
    const message = `*Pump Status Changed*\nPump is now ${content[0]}\nReason: ${content[1]}`
    await sendSlack(message)
  }
},10)
