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