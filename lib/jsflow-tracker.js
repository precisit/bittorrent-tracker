module.exports = jsFlowTracker

var debug = require('debug')('bittorrent-tracker:websocket-tracker')
var EventEmitter = require('events').EventEmitter
var hat = require('hat')
var inherits = require('inherits')
var jsFlow = require('./jsFlow')
var Peer = require('simple-peer')
//var Peer = require('jsflow-peer') // No changes needed.. :)


function jsFlowTracker (client, announceUrl, opts) {
  console.log('jsFlowTracker constructor is now running')
	var self=this
	EventEmitter.call(self)

  self.client = client
  self.storeIce = []
  self._opts = opts
  self._announceUrl = announceUrl
  self._peers = {} // peers (peer id -> peer)
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

  jsFlow.addHandler('list', self._onData.bind(self)) // These messages are only sent by the TRACKER

  //Handlers for peer-2-peer WebRTC signalling using jsFlow
  jsFlow.addHandler('webrtc_offer', self._onWebRtcOffer.bind(self)) // only sent from other PEERS
  jsFlow.addHandler('webrtc_answer', self._onWebRtcAnswer.bind(self)) // only sent from other PEERS
  jsFlow.addHandler('webrtc_ice', self._onWebRtcIce.bind(self)) // only sent from other PEERS
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
  if (interval && self._intervalMs !== 0) { //TODO: Fix so tracker can set interval (now defaults to 30 min)
    //&& !self._opts.interval 
  //if(interval) { // ALWAYS use the interval recommended by tracker
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

  // Handle received peers
  if (Array.isArray(payload.peers)) {
    payload.peers.forEach(function (peerInfo) { //For all peers we receive - Open a WebRTC peer connection

      var peerId = peerInfo.peerId;

      if (!self._peers[peerId]) {

        console.log('Will handle connection for peer: ', peerId);

        var peer = self._peers[peerId] = new Peer({
          initiator: true,
          trickle: true,
          config: self.client._rtcConfig,
          wrtc: self.client._wrtc
        })
        peer.id = peerId
        peer.on('close', function () {
          console.info('Peer connection destroyed, will remove from list of peers!')
          delete self._peers[from]
        })

        peer.on('signal', function (signalObject) {
          console.log('GOT SIGNAL, expecting offer/ice', signalObject);
          if(signalObject.candidate) { // The signalling is for ICE
            console.log('We have an ice candidate!')
            var params = {
                info_hash: self.client._infoHash.toString('base64'),
                peer_id: self._peerID,
                candidate: signalObject.candidate
              }
            jsFlow.messageUser(peerId, params, 'webrtc_ice');
          }
          else { // The signalling is for an OFFER
            offer = signalObject;
            console.log('We got an offer', offer)
            var params = {
              info_hash: self.client._infoHash.toString('base64'),
              peer_id: self._peerID,
              offer: offer
            }

            jsFlow.messageUser(peerId, params, 'webrtc_offer');          
          }
        })

      } else {
        console.log("Ignore peer, connection already exists.")
      }
    })
  };
}

jsFlowTracker.prototype._onWebRtcOffer = function (payload, from) {
  var self = this
  if(!self._peers[from]) { //Verify we haven't already received an offer from this user
    var peer = self._peers[from] = new Peer({
      trickle: true,
      config: self.client._rtcConfig,
      wrtc: self.client._wrtc
    })
    peer.id = from
    peer.on('close', function () {
      console.info('Peer connection destroyed, will remove from list of peers!')
      delete self._peers[from]
    })
    
    peer.on('signal', function (signalObject) {
      console.log('GOT SIGNAL, expecting answer/ice', signalObject);
      if(signalObject.candidate) { // The signalling is for ICE
        var params = {
          info_hash: self.client._infoHash.toString('base64'),
          peer_id: self._peerID,
          candidate: signalObject.candidate
        }

        jsFlow.messageUser(from, params, 'webrtc_ice');
      }
      else { // The signalling is for an ANSWER
        answer = signalObject;
        var params = {
          info_hash: self.client._infoHash.toString('base64'),
          peer_id: self._peerID,
          answer: answer
        }

        jsFlow.messageUser(from, params, 'webrtc_answer');
      }
    })

    peer.signal(payload.offer)
    if (peer.readyForIce) {
      processStoredCandidates(self,from)
    }

    self.client.emit('peer', peer)
  }
  else {
    console.error('Already have peer connection with user: ' + from);
    // Test if this works
    self.client.emit('peer', peer)
  }
}

jsFlowTracker.prototype._onWebRtcAnswer = function (payload, from) {
  var self = this
  var peer = self._peers[from]
  if(peer) {
    peer.id = from
    peer.signal(payload.answer)
    self.client.emit('peer', peer)
    if (peer.readyForIce) {
      processStoredCandidates(self,from)
    }
  }
  else {
    console.error('Got answer on peer connection that does not exist, from user: ' + from);
  }
}

jsFlowTracker.prototype._onWebRtcIce = function (payload, from) {
  var self = this
  console.log('Hello user, are you ready for ice?')
  var peer = self._peers[from]
  
  if (peer.readyForIce) {

    console.log('WILL ADD ICE CANDIDATE!!!');

    if(peer) {
      if(payload.candidate) {
        peer.signal(payload)
      }   
    }   
    else {
      console.error('Candidate did not exist as expected in payload', payload);
    }    
  }
  else {
    console.error('Candidate refers to a peer not yet created. Buffering ICE!', payload);
    self.storeIce.push(payload)
  }
  
}

jsFlowTracker.prototype._sendAnnounce = function (params) {
  var self = this
  jsFlow.messageUser(params.trackerid, params, 'announce')
}

function processStoredCandidates (tracker, from) {
  console.log("Processing stored candidates.")
  var peer = tracker._peers[from]
  tracker.storeIce.forEach(function(payload){
    peer.signal(payload)
  })
}
