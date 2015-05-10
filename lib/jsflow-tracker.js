module.exports = jsFlowTracker

var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var jsFlow = require('./jsFlow');


function jsFlowTracker (client, announceUrl, opts) {
  console.log('jsFlowTracker constructor is now running')
	var self=this
	EventEmitter.call(self)

  self.client=client
  self._opts = opts
  self._announceUrl = announceUrl
  self._peers = {} // peers (offer id -> peer)
  self._intervalMs = self.client._intervalMs // use client interval initially
  self._interval = null

  console.log(self);

  jsFlow.onRecievedUserId = function(userId) {
    console.log('userId', userId);
    self._peerID = userId;
  };

  // Starts jsFlow and handles the user ID
  jsFlow.run("31bc728296d8da7e14e132k",{sessionAuthURL: 'http://corslabs.com/jsflow', 
                  debugMsg: true});

  jsFlow.addHandler('list', self._onData.bind(self))
}

jsFlowTracker.prototype.announce = function(opts){
  var self=this
  opts.info_hash = self.client._infoHash.toString('base64')
  opts.peer_id = self._peerId
  opts.trackerid = 'tracker'
  
  self._sendAnnounce(opts)
}

jsFlowTracker.prototype.setInterval= function (intervalMs) {
  var self = this
  clearInterval(self._interval)

  self._intervalMs = intervalMs
  if (intervalMs) {
    // HACK
    var update = self.announce.bind(self, self.client._defaultAnnounceOpts())
    self._interval = setInterval(update, self._intervalMs)
  }
}

jsFlowTracker.prototype._onData = function (payload, from) {
  console.log('Got Data from Tracker!!', payload, from);

  var self = this
  if (!(typeof payload === 'object' && payload !== null)) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  if (payload.info_hash !== self.client._infoHash.toString('base64')) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  var failure = payload['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = payload['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

  var interval = payload.interval || payload['min interval']
  if(interval) { // ALWAYS use the interval recommended by tracker
    self.setInterval(interval)
  }

  var trackerId = payload['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  if (payload.complete) {
    self.client.emit('update', {
    announce: self._announceUrl,
    complete: payload.complete,
    incomplete: payload.incomplete
    })
  }

  if (Array.isArray(payload.peers)) {
    payload.peers.forEach(function (peer) {
      self.client.emit('jsflow_peer', peer.peerId)
    })
  }
}

jsFlowTracker.prototype._sendAnnounce = function (params) {
  var self = this
  jsFlow.messageUser(params.trackerid, params, 'announce')
}