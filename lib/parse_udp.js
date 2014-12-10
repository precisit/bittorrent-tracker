var bufferEqual = require('buffer-equal')
var common = require('./common')


module.exports = parseUdpRequest

function parseUdpRequest (msg, rinfo) {
  if (msg.length < 16) {
    throw new Error('received packet is too short')
  }

  if (rinfo.family !== 'IPv4') {
    throw new Error('udp tracker does not support IPv6')
  }

  var params = {
    connectionId: msg.slice(0, 8), // 64-bit
    action: msg.readUInt32BE(8),
    transactionId: msg.readUInt32BE(12)
  }

  // TODO: randomize:
  if (!bufferEqual(params.connectionId, common.CONNECTION_ID)) {
    throw new Error('received packet with invalid connection id')
  }

  if (params.action === common.ACTIONS.CONNECT) {
    // No further params
  } else if (params.action === common.ACTIONS.ANNOUNCE) {
    params.info_hash = msg.slice(16, 36).toString('binary') // 20 bytes
    params.peer_id = msg.slice(36, 56).toString('utf8') // 20 bytes
    params.downloaded = fromUInt64(msg.slice(56, 64)) // TODO: track this?
    params.left = fromUInt64(msg.slice(64, 72))
    params.uploaded = fromUInt64(msg.slice(72, 80)) // TODO: track this?
    params.event = msg.readUInt32BE(80)
    params.event = common.EVENT_IDS[params.event]
    if (!params.event) throw new Error('invalid event') // early return
    params.ip = msg.readUInt32BE(84) // optional
    params.ip = params.ip ?
      ipLib.toString(params.ip) :
      params.ip = rinfo.address
    params.key = msg.readUInt32BE(88) // TODO: what is this for?
    params.numwant = msg.readUInt32BE(92) // optional
    // never send more than MAX_ANNOUNCE_PEERS or else the UDP packet will get bigger than
    // 512 bytes which is not safe
    params.numwant = Math.min(params.numwant || common.NUM_ANNOUNCE_PEERS, common.MAX_ANNOUNCE_PEERS)
    params.port = msg.readUInt16BE(96) || rinfo.port // optional
    params.addr = params.ip + ':' + params.port // TODO: ipv6 brackets
    params.compact = 1 // udp is always compact

  } else if (params.action === common.ACTIONS.SCRAPE) { // scrape message
    params.info_hash = msg.slice(16, 36).toString('binary') // 20 bytes

    // TODO: support multiple info_hash scrape
    if (msg.length > 36) {
      throw new Error('multiple info_hash scrape not supported')
    }
  } else {
    return null
  }

  return params
}

// HELPER FUNCTIONS

var TWO_PWR_32 = (1 << 16) * 2

/**
 * Return the closest floating-point representation to the buffer value. Precision will be
 * lost for big numbers.
 */
function fromUInt64 (buf) {
  var high = buf.readUInt32BE(0) | 0 // force
  var low = buf.readUInt32BE(4) | 0
  var lowUnsigned = (low >= 0) ? low : TWO_PWR_32 + low

  return high * TWO_PWR_32 + lowUnsigned
}