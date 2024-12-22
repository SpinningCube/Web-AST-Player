
// Get audio context
const AudioContext = window.AudioContext || window.webkitAudioContext;

class ASTDecoder {
    /**
     * Reads in the provided AST file and sets fields according to the contained properties.
     * @param {ArrayBuffer} astFile The contents of an AST file
     */
    constructor(astFile) {
        const astData = new Uint8Array(astFile);
        if (astData.length < 0x40 + 32) {
            throw new Error("File data is not in AST format; not enough file data to fit entire AST header and beginning of first BLCK chunk");
        }
        this.astData = astData
        // "STRM" = 0x5354524D
        if (!(astData[0] === 0x53 && astData[1] === 0x54 && astData[2] === 0x52 && astData[3] === 0x4D)) {
            throw new Error("File data is not in AST format; missing \"STRM\" magic number");
        }
        this.dataSizeAccordingToHeader = readBE(astData, 4, 4);
        this.audioFormat = readBE(astData, 8, 2); // 0 = ADPCM, 1 = PCM16
        this.bitsPerSample = readBE(astData, 10, 2);
        this.numChannels = readBE(astData, 12, 2);
        if (this.numChannels === 0) {
            throw new Error("Number of audio channels cannot be 0");
        }
        this.unknown1 = readBE(astData, 14, 2);
        this.sampleRate = readBE(astData, 16, 4);
        this.numSamplesAccordingToHeader = readBE(astData, 20, 4);
        this.loopStart = readBE(astData, 24, 4);
        this.loopEnd = readBE(astData, 28, 4);
        this.firstChunkSize = readBE(astData, 32, 4);
        this.unknown2 = readBE(astData, 36, 4);
        this.unknown3 = readBE(astData, 40, 4);

        if (this.audioFormat === 0) {
            //throw new Error("This file uses ADPCM audio, which is unsupported by this decoder");
        } else if (this.audioFormat !== 1) {
            throw new Error("Unrecognized audio format; this decoder only recognizes formats 0 = ADPCM, 1 = PCM16, but this file uses format " + this.audioFormat);
        }
        this.chunkStarts = [];
        this.chunkStartSamples = [];
        this.chunkSizes = [];
        
        this.loopStartChunk = 0;
        
        let chunkNum = 0;
        let sample = 0;
        let chunkSize = 0;
        let i = 0x40;
        while (i < astData.length) {
            // "BLCK" = 0x424C434B
            if ((astData.length - i) < 32) {
                console.warn("Found bytes at expected beginning of next BLCK chunk, but there are not enough to form a complete BLCK chunk header. They will be ignored.");
                break;
            }
            if (!(astData[i] === 0x42 && astData[i + 1] === 0x4C && astData[i + 2] === 0x43 && astData[i + 3] === 0x4B)) {
                throw new Error("Missing \"BLCK\" magic number where BLCK chunk " + chunkNum + " is expected to start");
            }
            i += 4;
            chunkSize = readBE(astData, i, 4);
            console.log(chunkSize);
            if (this.audioFormat === 0 && chunkSize % 9 !== 0) {
                //throw new Error("Block size not divisible by 9, as required for ADPCM encoded audio");
            }
            i += 28;
            if (this.loopStart >= sample && this.loopStart < sample + chunkSize * 0.5) {
                this.loopStartChunk = chunkNum;
            }
            this.chunkStarts.push(i);
            this.chunkStartSamples.push(sample);
            this.chunkSizes.push(chunkSize);
            if (this.audioFormat === 0) {
                // ADPCM
                sample += (chunkSize / 9) * 16;
            } else {
                // PCM16
                sample += chunkSize * 0.5;
            }
            i += this.numChannels * chunkSize;
            chunkNum++;
        }
        if (i > astData.length) {
            const extraBytes = i - astData.length;
            console.warn("Reached end of file before expected end of block. Expected " + (extraBytes % chunkSize) + " more bytes in this block and " + Math.floor(extraBytes / chunkSize) + " more blocks in this BLCK chunk.\n")
        }
        this.numSamples = sample;
    }
}

/**
 * Read big-endian value from byte array starting at position
 * @param {number[]} array source array of bytes
 * @param {number} start index of first byte (the most significant byte in the resulting value)
 * @param {number} numBytes number of bytes to read
 * @returns {number} combined value
 */
function readBE(array, start, numBytes) {
    const end = start + numBytes;
    let value = 0;
    for (let i = start; i < end; i++) {
        value = (value << 8) + array[i];
    }
    return value;
}

class ASTPlayer {
    constructor(astFile, title) {
        let player = this;
        this.decodedAST = new ASTDecoder(astFile);
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
                duration: player.decodedAST.numSamplesAccordingToHeader / player.decodedAST.sampleRate,
                playbackRate: 1,
                position: 0,
            })
            navigator.mediaSession.setActionHandler("seekto", function(event) {
                player.setPosition(Math.floor(event.seekTime * player.decodedAST.sampleRate));
            });
            navigator.mediaSession.setActionHandler("play", function() { player.play() });
            navigator.mediaSession.setActionHandler("pause", function() { player.pause() });
            navigator.mediaSession.setActionHandler("previoustrack", function() { player.setPosition(0) });
        }

        
        this.audioContext = new AudioContext({ sampleRate: this.decodedAST.sampleRate });
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
        
        // Create an audio worklet
        this.audioProcessor = null;
        this.audioContext.audioWorklet.addModule("ast-audio-processor.js").then(function() {
            player.audioProcessor = new AudioWorkletNode(player.audioContext, "ast-audio-processor", {processorOptions: {decodedAST: player.decodedAST}, outputChannelCount: [2]});
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
        
        progressBar.max = this.decodedAST.numSamplesAccordingToHeader;
        progressBar.value = 0;

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
        if (sample > this.decodedAST.numSamplesAccordingToHeader) {
            player.finish();
        } else {
            if (sample === this.decodedAST.loopEnd) {
                sample = this.decodedAST.loopStart;
            }
            this.sample = sample;
            this.audioProcessor.port.postMessage({type: "set_position", param: sample});
        }
        this.displayPosition();
    }

    displayPosition() {
        progressBar.value = this.sample;
        const seconds = this.sample / this.decodedAST.sampleRate;
        const totalSeconds = this.decodedAST.numSamplesAccordingToHeader / this.decodedAST.sampleRate;
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
    bytes = [];
    for (let i = 0; i < numBytes; i++) {
        bytes.push(value & 0xFF);
        value >>= 8;
    }
    return bytes;
}