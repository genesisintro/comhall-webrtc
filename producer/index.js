//
// index.js
// 
//  Copyright 2013 Regents of the University of California
//  For licensing details see the LICENSE file.
//
//  Author:  Peter Gusev
//

var gumWidth = getCookie('gumWidth') || "1280";
var gumHeight = getCookie('gumHeight') || "720";
var gumFps = getCookie('gumFps') || "30";

var socket;
var peerConnections = [];
var consumers = [];
var localStream;
var pendingRequests = [];
var audioDevicesList;
var videoDevicesList;

var qvgaConstraints  = {
	mandatory: {
		maxWidth: 320,
		maxHeight: 180
	}
};

var vgaConstraints  = {
	mandatory: {
		maxWidth: 640,
		maxHeight: 360
	}
};

var hdConstraints  = {
	mandatory: {
		minWidth: 1280,
		minHeight: 720
	}
};

function initNodeUrl(){
	initPortFromUrl();
	defaultServerUrl = 'http://localhost:'+nodeServerPort;
}

function setupSocket(url){
	trace('connecting to '+url);
	socket = io.connect(url, {'force new connection': true});

	socket.on('connect', function(){
		trace('connected to '+url);
		socket.emit('id', 'producer');
	});

	socket.on('new consumer', function (msg){
		trace('new request from '+msg.from);
		if (!localStream)
		{
			trace('media is not ready yet. adding request from '+msg.from+' to pending');
			pendingRequests[pendingRequests.length] = msg.from;
		}
		else
		{
			if (!peerConnections[msg.from])
			{
				createPeerConnection(msg.from);
			}
			else
				logError('violation: got second request from the same consumer');
		}
	});

	socket.on('answer', function(msg){
		trace('got answer from '+msg.from + ': '+msg.data.sdp);
		var pc = peerConnections[msg.from];

		if (pc)
		{
			pc.setRemoteDescription(new RTCSessionDescription(msg.data),
				function (){
					trace('remote description set');
				},
				function (error){
					trace('error setting remote description: '+error.toString());
				});
			
			updateStatus();
		}
	});

	socket.on('ice', function (msg){
		var ice = msg.data;
		trace('received ICE from '+msg.from+': '+JSON.stringify(ice));
		var consumerPc = peerConnections[msg.from];

		if (consumerPc)
		{
			if (ice && ice.candidate)
				addIce(consumerPc, ice);
			else
				logError('bad ICE');
		}
		else
		{
			logError('no peer connection for '+msg.from);
		}
	});

	socket.on('bye', function (msg){
		trace(msg.from+' disconnected');
		if (peerConnections[msg.from])
		{
			peerConnections[msg.from].close();
			delete consumers[peerConnections[msg.from]];
			delete peerConnections[msg.from];
		}
		updateStatus();
	});

	socket.on('reconnecting', function() {
		trace('trying to reconnect to '+url);
	});

	socket.on('error', function () {
		trace('error on socket ('+url+')');
	});
}

function createPeerConnection(consumerId){
	trace('creating peer connection for '+consumerId);
	var pc = new RTCPeerConnection(
		{ "iceServers": [{ "url": "stun:stun.l.google.com:19302" }] },
		{ 'optional': [{DtlsSrtpKeyAgreement: true}] });
	peerConnections[consumerId] = pc;
	consumers[pc] = consumerId;

	pc.onicecandidate = function (event){
		trace('new ICE candidate '+JSON.stringify(event.candidate));
		if (event.candidate)
		{
			var consumerId = consumers[pc];
			socket.emit('ice', {to: consumerId, data:event.candidate});
		}
	}

	if (localStream)
	{
		trace('creating offer...');

		pc.addStream(localStream);
		pc.createOffer(
			function (description){
				pc.setLocalDescription(description);
				var consumerId = consumers[pc];

				trace('sending offer to '+consumerId);
				socket.emit('offer', {to:consumerId, data:description});
			},
			function (error) {
				logError('error creating offer '+error.toString());
			},
			{
				'mandatory': {
					'OfferToReceiveAudio':true,
					'OfferToReceiveVideo':true 
				}
			});
	}

	return pc;
}

function closeAllPeerConnections(){
	trace('closing active peer connections...');
	peerConnections = [];
	consumers = [];
	pendingRequests = [];
	updateStatus();
}

function replyPendingRequests(){
	trace('answering pending requests...');

	for (var idx in Object.keys(pendingRequests))
	{
		var consumerId = pendingRequests[idx];
		createPeerConnection(consumerId);		
	}
}

function shutdownSocket(){
	trace('shutting down connection...');
	socket.disconnect();
	socket = null;
}

function onErrorCallback(error){
	logError(error);
	setStatus('error');
}

function gotUserMedia(stream){
	trace('got stream. audio tracks: '+stream.getAudioTracks().length + ' video tracks: '+stream.getVideoTracks().length);
	trace('using audio device: '+stream.getAudioTracks()[0].label);
	trace('using video device: '+stream.getVideoTracks()[0].label);
	
	localStream = stream;
	var localVideo = document.querySelector('#local-video');
	attachMediaStream(localVideo, stream);

	localVideo.addEventListener("playing", function () {
		setTimeout(function () {
			trace('video size:' + localVideo.videoWidth+'X'+localVideo.videoHeight);
			document.getElementById('currentDevices').innerHTML = 'Current audio source: '+stream.getAudioTracks()[0].label+'<br>Current video source:'+stream.getVideoTracks()[0].label;            
			document.getElementById('currentDevices').innerHTML += '<br>Video size: '+localVideo.videoWidth+'X'+localVideo.videoHeight;
		}, 500);
	});
	


	if (pendingRequests && pendingRequests.length > 0)
	{
		replyPendingRequests();
	}
	else
	{
		trace('waiting for connections...');
		setStatus('waiting for incoming connections...');
	}
}

function initDeviceList(){
			getAudioDevices(function (audioDevices){
				audioDevicesList = audioDevices;
				audioList = document.getElementById('audiolist');
				var constraints = {};

				for (var idx in audioDevices)
				{
					var audioDevice = audioDevices[idx];
					
					constraints.audio = {
                		optional: [{ sourceId: audioDevice.id }]
            		};

					navigator.webkitGetUserMedia(constraints, function (stream) {
            			var option = document.createElement('option');
            			var label = stream.getAudioTracks()[0].label;

            			audioDevice.label = label;
            			option.text = label || 'Microphone '+audioList.length;
						audioList.add(option);
        			}, 
        			function (error){
        				trace('error '+error);
        			});
				}
			});

			getVideoDevices(function (videoDevices){
				videoDevicesList = videoDevices;
				videoList = document.getElementById('videolist');
				var constraints = {};

				for (var idx in videoDevices)
				{
					var videoDevice = videoDevices[idx];

					constraints.video = {
                		optional: [{ sourceId: videoDevice.id }]
            		};

					navigator.webkitGetUserMedia(constraints, function (stream) {
            			var option = document.createElement('option');
            			var label = stream.getVideoTracks()[0].label;

            			videoDevice.label = label;
            			option.text = label || 'Camera '+videoList.length;
						videoList.add(option);
        			}, 
        			function (error){
        				trace('error '+error);
        			});
				}
			});
}

function getAudioDevices(callback){
	return getMediaSources('audio', callback);
}

function getVideoDevices(callback){
	return getMediaSources('video', callback);
}

function getMediaSources(type, callback){
	var sources = [];

	if (!MediaStreamTrack) 
		logError('Current browser is incompatible for media sources enumeration');
	else
		MediaStreamTrack.getSources(function (media_sources) {
			var idx = 0;
			for (var i = 0; i < media_sources.length; i++) {
				var media_source = media_sources[i];

				if (media_source.kind == type) {
					sources[idx] = media_source;
					idx++;
        		} // if
    		} // for

    		callback(sources);
    	});	

	return sources;
}

function setStatus(status){
	document.getElementById('status').innerHTML = status;
}

function toggleSettings(){
	toggleElement(document.getElementById('settings'));
}

function toggleVideo(){
	toggleElement(document.getElementById('local-video'));
}

function updateStatus(){
	if (Object.size(peerConnections) == 0)
		setStatus('Waiting for incoming connections...');
	else
		setStatus('Currently active consumers: '+Object.size(peerConnections));
}

document.onkeypress = function (event){
	switch (String.fromCharCode(event.charCode)){
		case 's': 
		toggleSettings();
		break;
		case 'v':
		toggleVideo();
		break;
		case 'l': 
		toggleElement(document.getElementById('log'));
		break;			
		default:
		break;
	}
}