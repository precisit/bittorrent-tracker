var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')


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
}

jsFlowTracker.prototype.announce = function(opts){
  var self=this
  opts.info_hash = self.client._infoHash.toString('binary')
  opts.peer_id = self.client._peerId.toString('binary')

  // Starts jsFlow and handles the user ID
  jsFlow.run("31bc728296d8da7e14e132k",{userId: 'tracker', sessionAuthURL: 'http://corslabs.com/jsflow', 
                  debugMsg: true});

  jsFlow.onRecievedUserId = function(userId) {
    console.log('userId ', userId);
    var torrentTracker = userId;
  };
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

jsFlowTracker.prototype._onError = function (err) {
  var self = this
  self.client.emit('error', err)
}

jsFlowTracker.prototype._onData = function (data) {
  var self = this
  if (!(typeof data === 'object' && data !== null)) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  if (data.info_hash !== self.client._infoHash.toString('binary')) {
    return self.client.emit('warning', new Error('Invalid tracker response'))
  }

  var failure = data['failure reason']
  if (failure) return self.client.emit('warning', new Error(failure))

  var warning = data['warning message']
  if (warning) self.client.emit('warning', new Error(warning))

  var interval = data.interval || data['min interval']
  if (interval && !self._opts.interval && self._intervalMs !== 0) {
    // use the interval the tracker recommends, UNLESS the user manually specifies an
    // interval they want to use
    self.setInterval(interval * 1000)
  }

  var trackerId = data['tracker id']
  if (trackerId) {
    // If absent, do not discard previous trackerId value
    self._trackerId = trackerId
  }

  if (data.complete) {
    self.client.emit('update', {
    announce: self._announceUrl,
    complete: data.complete,
    incomplete: data.incomplete
  })
}