var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
var crypto = require('crypto');
var WebSocket = require('ws');

/** @const */ var JSFLOWERR = 2;
/** @const */ var JSFLOWWARN = 1;
/** @const */ var JSFLOWGREAT = 3;

//Helper
var httpPostHelper = function(url, data, success, fail) {
	jsFlow.sysLog('Making HTTP request to url ' + url);

	var http = new XMLHttpRequest();
	http.open("POST", url, true);
	http.setRequestHeader("Content-Type","application/x-www-form-urlencoded; charset=UTF-8");

	http.onreadystatechange = function() {//Call a function when the state changes.
		if(http.readyState == 4 && http.status == 200) {
			success && success(http.responseText);
		}
		else if(http.readyState == 4 && http.status >= 300) {
			console.log('http request error', http.responseText, data);
			fail && fail(http.responseText);
		}
	}

	http.send(data);		
}

/** 
 * @class 
 * @author Magnus Lundstedt <magnus.lundstedt@infidyne.com>
 */
var jsFlow = { 
	bridgeURL: 'https://ws.jsflow.com:443/auth/',
	readyState: false,
	reconnectFlag: true,
	retryCounter: 1,
	retryBackoff: 100,
	eventHandlerMap: {},
	channelPresenceHandlerMap: {},
	buffert: new Array(),
	queue: false,
	transmitInterval: 10,
	optionParams: {'sessionAuthURL':null, 'defaultChannels':null, 'userId':null, 'debugMsg': null},
	debugMsg: false,
	sessionAuthURL: null,
	defaultChannels: [],
	userId: null,
	clientSecret: null,
	singletonCreated: false,
	socket: null,
	logger: {0: 'debug', 1: 'warn', 2: 'error', 3: 'info'},
	color: ['black', 'orange', 'red', 'green'],

	/**
	* Callback when connection to server is ready. Overload with your custom callback.
	* @callback
	*/
	onFlowReady: function() {jsFlow.sysLog('No onFlowReady handler set', JSFLOWWARN);},

	/**
	* Callback when connection to server is closed. Overload with your custom callback.
	* @callback
	*/
	onFlowClosed: function() {jsFlow.sysLog('No onFlowClosed handler set', JSFLOWWARN);},

	/**
	* Callback when recieved a generated username during login. Overload with your custsom callback.
	* @callback
	* @param {string} userId - The generated username.
	*/	
	onRecievedUserId: function(userId) {jsFlow.sysLog('No onRecievedUserId handler set', JSFLOWWARN);},

	/**
	* Callback on successful channel subscribe. Overload with your custsom callback.
	* @callback
	* @param {string} channelId - The channel that was subscribed.
	*/	
	onSubscribed: function(channelId) {jsFlow.sysLog('No onSubscribed handler set. Channel: ' + channelId, JSFLOWWARN);},

	/**
	* Callback on successful channel unsubscribe. Overload with your custsom callback.
	* @callback
	* @param {string} channelId - The channel that was unsubscribed.
	*/	
	onUnsubscribed: function(channelId) {jsFlow.sysLog('No onUnsubscribed handler set. Channel: ' + channelId, JSFLOWWARN);},

	/**
	* Callback on authentication error. Overload with your custsom callback.
	* @callback
	* @param {string} message - Description of the error.
	*/	
	onAuthError: function(message) {jsFlow.sysLog('Authentication error. Description: ' + JSON.stringify(message), JSFLOWERR);},

	/**
	* Run the jsflow api, will begin authentication and during the process call relevant callbacks.
	* @param {string} publicApiKey - Your public API key.
	* @param {Array} - options - Array of configuration parameters {'sessionAuthURL':null, 'defaultChannels':null, 'userId':null, 'debugMsg': null}.
	*/	
	run : function(publicApiKey, options) {
		if(this.singletonCreated) {
			if(this.debugMsg) jsFlow.sysLog('Multiple calls to jsFlow.run()', JSFLOWWARN);
			return;
		}
		this.singletonCreated = true;

		for(key in options) {
			if(key in this.optionParams)
				this[key] = options[key];
			else
				if(this.debugMsg) jsFlow.sysLog('Invalid configuration key: '+key, JSFLOWERR);
		}

		this.connect(publicApiKey);
	},	

	/**
	* Graceful close of websocket connection and API reconnect functions. 
	*/	
	close : function() {
		for(key in this.optionParams) {
			this[key] = null;
		}

		this.singletonCreated = false;
		this.reconnectFlag = false;
		jsFlow.socket.close();
	},

	/**
	* Subscribe to a channel.
	* @param {string} channelId - Channel to subscribe (fewer than 256 bytes).
	*/	
	subscribe : function(channelId) {
	    var message = { "command" : "subscribe", 
		                "channel_id" : channelId };
		jsFlow.socket.send(JSON.stringify(message));
		this.defaultChannels.push(channelId);
	},

	/**
	* Unsubscribe to a channel.
	* @param {string} channelId - Channel to unsubscribe (fewer than 256 bytes).
	*/	
	unsubscribe: function(channelId) {
	    var message = { "command" : "unsubscribe", 
		                "channel_id" : channelId };
		this.send(message);
		index = this.defaultChannels.indexOf(channelId);
		while(index > -1) {
			this.defaultChannels.splice(index,1);
			index = this.defaultChannels.indexOf(channelId);
		}
	},

	/**
	* Send a message to a user.
	* @param {string} userId - Id of user to message (alphanumeric only, fewer than 256 bytes).
	* @param {string} payload - Raw javascript object to transmit (not JSON).
	* @param {string} trigger - Trigger to be used on the recieving side to process this message.
	*/	
	messageUser: function(userId, payload, trigger) {
		payload = JSON.stringify(payload); //TODO: Add encrypt of data

		if(this.sessionAuthURL == null)
			if(this.debugMsg) jsFlow.sysLog("No response URL set, this is required for elevated privileges to post to users.", JSFLOWWARN)
	    var message = { "command" : "message_user", 
		                "user_id" : userId,
		            	"payload" : payload, 
		            	"trigger" : trigger, 
		            	"digest" : this.digest(payload,userId,trigger)};

		this.send(message);
	},

	/**
	* Send a message to a channel.
	* @param {string} channelId - Id of channel to message (fewer than 256 bytes).
	* @param {string} payload - Raw javascript object to transmit (not JSON).
	* @param {string} trigger - Trigger to be used on the recieving side to process this message.
	*/	
	messageChannel: function(channelId, payload, trigger) {
		payload = JSON.stringify(payload); //TODO: Add encrypt of data

		if(this.sessionAuthURL == null)
			if(this.debugMsg) jsFlow.sysLog("No response URL set, this is required for elevated privileges to post to channels.", JSFLOWWARN)
		//payload['mChannelId'] = channelId
	    var message = { "command" : "message_channel", 
		                "channel_id" : channelId,
		            	"payload" : payload, 
		            	"trigger" : trigger, 
		            	"digest" : this.digest(payload,channelId,trigger)};

		this.send(message);
	},

	/**
	* Add handler for trigger.
	* @param {string} trigger - Trigger to add a handler for. Alphanumeric, no spaces. 
	* @param {string} handlerFunction - (payload, from, [channel_id]) Handler to be called when processing messages with this trigger. Multiple handlers can be assigned for each trigger. When called, payload will contain the javascript object (not JSON), from will contain userId of sender and channel_id will contain the channel_id used to relay the message (if it was recieved through a channel)
	*/	
	addHandler : function (trigger, handlerFunction) {
		if(!(trigger in this.eventHandlerMap))
			this.eventHandlerMap[trigger] = new Array();
		this.eventHandlerMap[trigger].push(handlerFunction);
	},

	/**
	* Add handler for channel presence.
	* @param {string} channelId - Channel to add presence handler for.
	* @param {string} handlerFunction - (userId, userInChannel, channelId) Handler to be called when processing presence events
	*/	
	setPresenceHandler : function (channelId, handlerFunction) {
		this.channelPresenceHandlerMap[channelId] = handlerFunction;
	},

	/**
	* Remove handler for channel presence.
	* @param {string} channelId - Channel to remove presence handler for.
	*/	
	removePresenceHandler : function (channelId) {
		delete this.channelPresenceHandlerMap[channelId];
	},

	connect : function(public_api_key) {
		if(this.debugMsg) jsFlow.sysLog('Authentication request..', JSFLOWGREAT);

		this.retryCounter++;
		var self = this;

		var url = this.bridgeURL+(public_api_key || '')+'/'+encodeURIComponent(this.userId || '');

		httpPostHelper(url, '', function(response) {
			var message = JSON.parse(response);

			if(message.response == 'ok') {
				self.userId = message.user_id;
				try {
					self.onRecievedUserId(message.user_id);
				}
				catch(exception){
					if(self.debugMsg) jsFlow.sysLog('Error executing onRecievedUserId. ' + exception, JSFLOWERR);
				}

				if(jsFlow.sessionAuthURL != null) {
					if(self.debugMsg) jsFlow.sysLog('Requesting challenge-response from ' + self.sessionAuthURL);
					var responseParams = {};
					responseParams.user_id = message.user_id;
					responseParams.challenge = message.challenge;

					httpPostHelper(jsFlow.sessionAuthURL, 'user_id='+message.user_id+'&challenge='+message.challenge, function(responseData) {
						var response = JSON.parse(responseData);
						self.clientSecret = crypto.createHash('sha1').update(message.challenge+response['digest']).digest('hex');
						self.wsConnect('ws://'+message['host']+':'+message['port']+'/flow/',message['user_id'],public_api_key,message['challenge_id'],response['digest']);						
					})

				}
				else {
					self.wsConnect('ws://'+message['host']+':'+message['port']+'/flow/',message['user_id'],public_api_key);
				}
			}
			else {
				try {
					self.onAuthError(message);
				}
				catch(exception) {
					if(self.debugMsg) jsFlow.sysLog('Error executing onAuthError. ' + exception, JSFLOWERR)
				}
			}

		}, function(error) {
			self.reconnect(public_api_key);
		});

	},
	wsConnect : function(host,user_id,public_api_key,challenge_id,digest) {
	    try {
    		if(challenge_id !== undefined)
	    		var url = host+public_api_key+'/'+encodeURIComponent(user_id)+'/'+challenge_id+'/'+digest;
	    	else
	    		var url = host+public_api_key+'/'+encodeURIComponent(user_id)
    		if(this.debugMsg) jsFlow.sysLog('Connecting to: '+url)
	    	jsFlow.socket = new WebSocket(url);
	    			        
	 		var self = this;
	 		
	 		jsFlow.socket.onopen = function () {
	 			//Will not do anything, waiting for server to initiate next step
	 		}

	 		//Special jQuery hack to maintain reference to "this" object in callbacks
	 		//var wrappedFunc = $.proxy(this.mainHandler, this); 
	 		jsFlow.socket.onmessage = this.mainHandler.bind(this);
	 		
	 		//var wrappedFunc2 = $.proxy(this.flowUnready, this); 
	 		jsFlow.socket.onclose = function () {
	 			this.flowUnready(public_api_key);
			}.bind(this);
   		}
		catch(exception) {
	        if(this.debugMsg) jsFlow.sysLog('Error on wsConnect. '+exception);
		}
	},
	reconnect : function(public_api_key) {
		if(this.reconnectFlag == true){
			retryIn = this.retryBackoff * this.retryCounter * this.retryCounter +1;
			retryIn *= (Math.random()+0.5)
			if(this.debugMsg) jsFlow.sysLog('Connection to system failed. Retry in: ' + Math.floor(retryIn), JSFLOWWARN);
			setTimeout(function(){
        		jsFlow.connect(public_api_key);
        	}, retryIn);
		}
		else
			if(this.debugMsg) jsFlow.sysLog('Will not retry since close() was called.', JSFLOWGREAT)
	},
	sendFromBuffert : function() {
		if(this.buffert.length > 0)
		{
			if(this.readyState) {
				msg = this.buffert.pop();
				try {
					message = JSON.stringify(msg);
			        jsFlow.socket.send(message);
			        if(this.debugMsg) jsFlow.sysLog("Sending message: " + message);
				}
				catch (exception) {
			        if(this.debugMsg) jsFlow.sysLog("Warning, can't send data: " + message + ". " + exception, JSFLOWWARN);
				}
				if(this.buffert.length > 0) {
					wrappedFunc = $.proxy(this.sendFromBuffert, this);
					setTimeout(wrappedFunc, this.transmitInterval);
				}
				else {
					wrappedFunc = $.proxy(this.noQueue, this);
					setTimeout(wrappedFunc, this.transmitInterval);
				}
			}
			else {
				wrappedFunc = $.proxy(this.sendFromBuffert, this);
				setTimeout(wrappedFunc, this.transmitInterval);
			}
		}
	},
	noQueue : function() {
		if(this.buffert.length == 0)
			this.queue = false; //No longer send messages from queue only
		else 
			this.sendFromBuffert();
	},
    send : function(message) {
    	//Add message to message buffert
    	this.buffert.unshift(message);
    	if(!this.queue) { //If there is no messages in queue, send now
    		this.sendFromBuffert();
    		this.queue = true; //Only process messages from queue
		}
		else
			if(this.debugMsg) if(this.buffert.length > 0) jsFlow.sysLog("Message is put on the send queue. Buffert length: " + this.buffert.length, JSFLOWWARN)
	},
	_subscribe : function(channelId) {
	    var message = { "command" : "subscribe", 
		                "channel_id" : channelId };
		jsFlow.socket.send(JSON.stringify(message));
	},
	_unsubscribe: function(channelId) {
	    var message = { "command" : "unsubscribe", 
		                "channel_id" : channelId };
		this.send(message);
	},	
	register : function() {
	    var message = { "command" : "register" };
	    jsFlow.socket.send(JSON.stringify(message));
	},
	digest: function(payload, id, trigger) {
		return ""+CryptoJS.SHA1(this.userId + this.clientSecret + payload + id + trigger);
	},
	flowReady : function() {
		//Subscribe to all default channels
		if(typeof this.defaultChannels == 'string')
			this.defaultChannels = [this.defaultChannels];
		for(var i = 0; i < this.defaultChannels.length; i++){
			this._subscribe(this.defaultChannels[i]);
		}

		//TODO: If there are messages in the buffer, go through them and recalculate the digest !
		if(this.buffert.length > 0)	{
			for(var i = 0; i < this.buffert.length; i++){
				if(this.buffert[i]["command"] == 'message_user')
					this.buffert[i]["digest"] = this.digest(this.buffert[i]["payload"],
															this.buffert[i]["user_id"],
															this.buffert[i]["trigger"]);
				else if(this.buffert[i]["command"] == 'message_channel')
					this.buffert[i]["digest"] = this.digest(this.buffert[i]["payload"],
															this.buffert[i]["channel_id"],
															this.buffert[i]["trigger"]);
			}
			this.queue = true;
		}
		else
			this.queue = false;

		this.readyState = true; 
    	this.retryCounter = 1;
    	try {
			this.onFlowReady();
		}
		catch(exception){
			if(this.debugMsg) jsFlow.sysLog('Error executing onFlowReady. ' + exception, JSFLOWERR)
		}
		if(this.debugMsg) jsFlow.sysLog('Websocket connection to jsFlow server established!', JSFLOWGREAT)
	},
	flowUnready : function(public_api_key) {
		this.readyState = false; 
		this.queue = false;
    	try {
			this.onFlowClosed();
		}
		catch(exception) {
			if(this.debugMsg) jsFlow.sysLog('Error executing onFlowClosed. ' + exception, JSFLOWERR)
		}
		this.reconnect(public_api_key);
	},
	mainHandler : function(messageEvent) {
		try {
			var message = JSON.parse(messageEvent.data);
			//Manage responses
			if(this.debugMsg) jsFlow.sysLog("Processing Message: " + messageEvent.data);	

			//TODO: MAKE THIS A SWITCH CASE instead
			if(message['response'] == 'message_sent') {
				//TODO: Add developer defined callback to be processed when message has been delivered? 
				if(typeof message['delta'] != 'undefined')
					this.transmitInterval = 10 + Math.round(message['delta']);
				else
					this.transmitInterval = 10;
			}
			else if(message['response'] == 'ready') {
				this.register();
			}
			else if(message['response'] == 'registered') {
				this.flowReady();
			}
			else if(message['response'] == 'subscribed') {
				try {
					this.onSubscribed(message['channel_id']);
				}
				catch(exception){
					if(this.debugMsg) jsFlow.sysLog('Error executing onSubscribed. ' + exception, JSFLOWERR);
				}
			}
			else if(message['response'] == 'unsubscribed') {
				try {
					this.onUnsubscribed(message['channel_id']);
				}
				catch(exception){
					if(this.debugMsg) jsFlow.sysLog('Error executing onSubscribed. ' + exception, JSFLOWERR);
				}
			}
			else if(message['response'] == 'error'){
				if(this.debugMsg) jsFlow.sysLog('Error recieved from server: ' + messageEvent.data, JSFLOWERR);
			}
			else if(message['userInChannel'] == true){
				if(this.debugMsg) jsFlow.sysLog('Calling presence handlers for channel (user joined): ' + message['channel_id']);
				if(message['channel_id'] in this.channelPresenceHandlerMap)
					this.channelPresenceHandlerMap[message['channel_id']](message['from'], message['userInChannel'], message['channel_id']);
			}
			else if(message['userInChannel'] == false){
				if(this.debugMsg) jsFlow.sysLog('Calling presence handlers for channel (user left): ' + message['channel_id']);
				if(message['channel_id'] in this.channelPresenceHandlerMap)
					this.channelPresenceHandlerMap[message['channel_id']](message['from'], message['userInChannel'], message['channel_id']);
			}
			else {
				var handled = 0; 
				for(handler in this.eventHandlerMap[message['trigger']]){
					try {
						var payload = JSON.parse(message['payload']); //TODO: Add decrypt of data
						this.eventHandlerMap[message['trigger']][handler](payload, message['from'], message['channel_id']);
						handled = 1;
					}
					catch(exception){
						jsFlow.sysLog('Error executing a handler for trigger "'+message['trigger']+'". ' + exception, JSFLOWERR);
					}
				}
				if(handled == 0) {
					if(this.debugMsg) jsFlow.sysLog('No handler found for message: ' + messageEvent.data, JSFLOWWARN);
				}
			}
		}
		catch(exception) {
			if(this.debugMsg) jsFlow.sysLog('Error parsing message. ' + exception, JSFLOWERR)
		}	
	},
	sysLog: function(message, level) {
		(console[this.logger[level||0]] || console.log) ('jsFlow: %c ' + message, 'color: '+this.color[level||0]);
	}
}


module.exports = jsFlow;