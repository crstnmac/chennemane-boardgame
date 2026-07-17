/**
 * Room discovery for Hyperswarm (Holepunch / pears.com stack).
 * Topic is a 32-byte buffer derived from a human-friendly room code.
 */
const b4a = require('b4a')
const hypercoreCrypto = require('hypercore-crypto')
const { APP_ID } = require('./protocol')

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1

function generateRoomCode(len) {
  const n = len || 6
  const bytes = hypercoreCrypto.randomBytes(n)
  let out = ''
  for (let i = 0; i < n; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  }
  return out
}

function normalizeRoomCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function topicFromRoomCode(code) {
  const normalized = normalizeRoomCode(code)
  if (normalized.length < 4) {
    throw new Error('room_code_too_short')
  }
  return hypercoreCrypto.hash(b4a.from(`${APP_ID}:room:${normalized}`))
}

function topicHex(topic) {
  return b4a.toString(topic, 'hex').slice(0, 16) + '…'
}

module.exports = {
  generateRoomCode,
  normalizeRoomCode,
  topicFromRoomCode,
  topicHex,
}
