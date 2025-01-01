
import { ASTHeader } from "./ast-decoder.js";

// Get audio context
const AudioContext = window.AudioContext || window.webkitAudioContext;

class ASTPlayer {
    constructor(astFile, title) {
        let player = this;
        this.astData = new Uint8Array(astFile);
        this.astHeader = new ASTHeader(this.astData);
        this.sample = 0;
        
        if ("mediaSession" in navigator) {
            // Chrome (and possibly other browsers) requires the existence of a playing audio or video element to show the media session.
            this.audioElement = document.createElement("audio");
            const silence = new Uint8Array(makeWav([Array(10000).fill(0)], 10000));
            this.audioElement.src = URL.createObjectURL(new Blob([silence], {type: 'audio/wav'}));
            this.audioElement.loop = true;
            this.audioElement.volume = 0;
            navigator.mediaSession.metadata = new MediaMetadata({
                title: title,
            });
            navigator.mediaSession.setPositionState({
                duration: player.astHeader.numSamples / player.astHeader.sampleRate,
                playbackRate: 1,
                position: 0,
            })
            navigator.mediaSession.setActionHandler("seekto", function(event) {
                player.setPosition(Math.floor(event.seekTime * player.astHeader.sampleRate));
            });
            navigator.mediaSession.setActionHandler("play", function() { player.play() });
            navigator.mediaSession.setActionHandler("pause", function() { player.pause() });
            navigator.mediaSession.setActionHandler("previoustrack", function() { player.setPosition(0) });
        }
        
        this.audioContext = new AudioContext({ sampleRate: this.astHeader.sampleRate, latencyHint: "playback" });
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
        
        // Create an audio worklet
        this.audioProcessor = null;
        this.audioContext.audioWorklet.addModule("ast-audio-processor.js").then(function() {
            player.audioProcessor = new AudioWorkletNode(player.audioContext, "ast-audio-processor", {processorOptions: {astData: player.astData}, outputChannelCount: [2]});
            player.audioProcessor.connect(player.gainNode);
            player.audioProcessor.port.onmessage = function(message) {
                switch (message.data.type) {
                    case "finish":
                        player.finish();
                        break;
                    case "position":
                        player.sample = message.data.param;
                        player.displayPosition();
                        break;
                }
            }
        });
        
        progressBar.max = this.astHeader.numSamples;
        progressBar.value = 0;

        console.log("Loaded " + title);
        console.log("Sample rate: " + this.astHeader.sampleRate);
        console.log("Number of channels: " + this.astHeader.numChannels);

        this.play();
    }

    play() {
        this.audioContext.resume();
        pauseResumeButton.innerHTML = pauseSVG;
        pauseResumeButton.onclick = function() { player.pause() };
        if ("mediaSession" in navigator) {
            this.audioElement.play();
            navigator.mediaSession.playbackState = "playing";
        }
    }

    pause() {
        this.audioContext.suspend();
        pauseResumeButton.innerHTML = resumeSVG;
        pauseResumeButton.onclick = function() { player.play() };
        if ("mediaSession" in navigator) {
            this.audioElement.pause();
            navigator.mediaSession.playbackState = "paused";
        }
    }

    finish() {
        player.setPosition(0);
        player.pause();
    }

    setPosition(sample) {
        if (sample > this.astHeader.numSamples) {
            player.finish();
        } else {
            if (sample === this.astHeader.loopEnd) {
                sample = this.astHeader.loopStart;
            }
            this.sample = sample;
            this.audioProcessor.port.postMessage({type: "set_position", param: sample});
        }
        this.displayPosition();
    }

    displayPosition() {
        progressBar.value = this.sample;
        const seconds = this.sample / this.astHeader.sampleRate;
        const totalSeconds = this.astHeader.numSamples / this.astHeader.sampleRate;
        const totalMinutesString = String(Math.floor(totalSeconds / 60));
        progress.textContent = String(Math.floor(seconds / 60)).padStart(totalMinutesString.length, '0') + ":" + String(Math.floor(seconds % 60)).padStart(2, '0') + "." + String(Math.floor((seconds % 1) * 100)).padStart(2, '0');
        progress.textContent += " / " + totalMinutesString + ":" + String(Math.floor(totalSeconds % 60)).padStart(2, '0') + "." + String(Math.floor((totalSeconds % 1) * 100)).padStart(2, '0');
        
        if ("mediaSession" in navigator) {
            navigator.mediaSession.setPositionState({
                duration: totalSeconds,
                playbackRate: 1,
                position: seconds,
            })
        }
    }

    setVolume(volume) {
        this.gainNode.gain.value = volume;
    }
}

const progressBar = document.getElementById("progressbar");
progressBar.addEventListener("input", function(event) {
    player.setPosition(event.target.value);
});

const volumeInput = document.getElementById("volume");
volumeInput.addEventListener("input", function(event) {
    player.setVolume(event.target.value);
});

const pauseResumeButton = document.getElementById("pause-resume");
const resumeSVG = `<svg width="40px" height="40px" viewbox="-100 -100 200 200">
        <polygon points="100,0 -50,86 -50,-86"/>
    </svg>`
const pauseSVG = `<svg width="40px" height="40px" viewbox="-100 -100 200 200">
        <rect x="-75" y="-75" width="50" height="150"/>
        <rect x="25" y="-75" width="50" height="150"/>
    </svg>`
pauseResumeButton.innerHTML = resumeSVG;

let player = null;
const progress = document.getElementById("progress");

const fileInput = document.getElementById("ast-file-import");
fileInput.addEventListener("change", openFile);

function openFile(event) {
    const file = event.target.files[0];
    const reader = new FileReader();
    reader.onload = function() {
        if (player != null) {
            player.pause();
            player.audioContext.close();
        }
        player = new ASTPlayer(reader.result, file.name);
    };
    reader.readAsArrayBuffer(file);
}

function perFrame() {
    if (player != null) {
        player?.audioProcessor?.port?.postMessage({type: "get_position"});
    }
}
setInterval(perFrame, 10);

/**
 * Encode audio channels into WAV format.
 * @param {number[][]} channelData Each subarray is an array of 16-bit PCM samples for a particular channel. 
 * @param {number} sampleRate Output sample rate.
 * @returns {number[]} Array of bytes containing WAV file data.
 */
function makeWav(channelData, sampleRate) {
    // RIFF[FileSize]WAVEfmt␣[length of format data]
    const fileBytes = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00];
    
    fileBytes.push(0x01, 0x00); // Audio format - 0x01 indicates PCM integer
    const numChannels = channelData.length;
    fileBytes.push(...toBytesLE(numChannels, 2)); // Number of channels
    fileBytes.push(...toBytesLE(sampleRate, 4)); // Sample rate
    const bytesPerBlock = numChannels * 2;
    fileBytes.push(...toBytesLE(sampleRate * bytesPerBlock, 4)); // Bytes per second
    fileBytes.push(...toBytesLE(bytesPerBlock, 2)); // Bytes per block
    fileBytes.push(0x10, 0x00); // Bits per sample
    fileBytes.push(0x64, 0x61, 0x74, 0x61); // "data"
    fileBytes.push(0, 0, 0, 0); // data size
    const headerSize = fileBytes.length;

    for (let sampleNum = 0; sampleNum < channelData[0].length; sampleNum++) {
        for (let channel = 0; channel < numChannels; channel++) {
            const sample = channelData[channel][sampleNum];
            fileBytes.push(sample & 0xFF, (sample >>> 8) & 0xFF);
        }
    }
    
    if (fileBytes.length & 1) {
        fileBytes.push(0x00);
    }
    
    fileBytes.splice(4, 4, ...toBytesLE(fileBytes.length - 8, 4)); // File size
    fileBytes.splice(headerSize - 4, 4, ...toBytesLE(fileBytes.length - headerSize, 4)); // Data size
    return fileBytes;
}

/**
 * Encodes a value into the corresponding little-endian sequence of bytes.
 * @param {number} value The value to encode.
 * @param {number} numBytes The number of bytes in the resulting sequence.
 * @returns {number[]} Array of bytes in little-endian order.
 */
function toBytesLE(value, numBytes) {
    const bytes = [];
    for (let i = 0; i < numBytes; i++) {
        bytes.push(value & 0xFF);
        value >>= 8;
    }
    return bytes;
}