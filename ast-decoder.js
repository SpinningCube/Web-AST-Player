
export class ASTHeader {
    /**
     * Sets fields according to properties in AST file header.
     * @param {Uint8Array} astData The contents of an AST file.
     */
    constructor(astData) {
        if (astData.length < 0x40 + 32) {
            throw new Error("File data is not in AST format; not enough file data to fit entire AST header and beginning of first BLCK chunk");
        }

        // "STRM" = 0x5354524D
        if (!(astData[0] === 0x53 && astData[1] === 0x54 && astData[2] === 0x52 && astData[3] === 0x4D)) {
            throw new Error("File data is not in AST format; missing \"STRM\" magic number");
        }
        this.dataSize = readBE(astData, 4, 4);
        this.audioFormat = readBE(astData, 8, 2); // 0 = ADPCM, 1 = PCM16
        if (this.audioFormat > 1) {
            throw new Error("Unrecognized audio format; this decoder only recognizes formats 0 = ADPCM, 1 = PCM16, but this file uses format " + this.audioFormat);
        }
        this.bitsPerSample = readBE(astData, 10, 2);
        this.numChannels = readBE(astData, 12, 2);
        if (this.numChannels === 0) {
            throw new Error("Number of audio channels cannot be 0");
        }
        this.unknown1 = readBE(astData, 14, 2);
        this.sampleRate = readBE(astData, 16, 4);
        this.numSamples = readBE(astData, 20, 4);
        this.loopStart = readBE(astData, 24, 4);
        this.loopEnd = readBE(astData, 28, 4);
        this.firstChunkSize = readBE(astData, 32, 4);
        this.unknown2 = readBE(astData, 36, 4);
        this.unknown3 = readBE(astData, 40, 4);
    }
}

export class ASTDecoder {
    /**
     * Reads in the header of the provided AST file, sets fields according to the contained properties,
     * and prepares decoder to decode the rest of the file.
     * @param {Uint8Array} astData The contents of an AST file.
     */
    constructor(astData) {
        this.astData = astData;

        // Main header
        this.header = new ASTHeader(astData);

        // Set up decoder
        this.decodedSamples = Array(this.header.numChannels);
        for (let channel = 0; channel < this.decodedSamples.length; channel++) {
            this.decodedSamples[channel] = [];
        }
        this.decoderPosition = 0x40;
        this.decoderSample = 0;
        this.decoderFinished = false;
        this.decoderEndSample = 0;
        this.outputSample = 0;
        this.numChunks = 0;
        
        // ADPCM decoder state
        this.adpcmShift = Array(this.header.numChannels).fill(0);
        this.adpcmFilter = Array(this.header.numChannels).fill(0);
        this.adpcmOld = Array(this.header.numChannels).fill(0);
        this.adpcmOlder = Array(this.header.numChannels).fill(0);
        this.adpcmLastByteWasHeader = Array(this.header.numChannels).fill(false);
    }

    nextBlock() {
        if (this.decoderFinished) {
            return false;
        }
        if (this.decoderPosition >= this.astData.length) {
            this.decoderFinished = true;
            return false;
        }
        let i = this.decoderPosition;
        if ((this.astData.length - i) < 32) {
            this.decoderError("Found bytes at expected beginning of next BLCK chunk, but there are not enough remaining to form a complete BLCK chunk header. They will be ignored.");
            this.decoderFinished = true;
            return false;
        }
        // "BLCK" = 0x424C434B
        if (!(this.astData[i] === 0x42 && this.astData[i + 1] === 0x4C && this.astData[i + 2] === 0x43 && this.astData[i + 3] === 0x4B)) {
            this.decoderError("Missing \"BLCK\" magic number where BLCK chunk " + this.numChunks + " is expected to start. Remaining bytes will be ignored.");
            this.decoderFinished = true;
            return false;
        }
        i += 4;
        const blockSize = readBE(this.astData, i, 4);
        i += 28;
        const chunkStart = i;
        let iter;
        let adpcmShift;
        let adpcmFilter;
        let adpcmOld;
        let adpcmOlder;
        let adpcmLastByteWasHeader;
        
        if (this.header.audioFormat === 0) {
            // ADPCM
            iter = (channel, i) => {
                const byte = this.astData[i];
                if (this.decoderSample % 16 === 0 && !adpcmLastByteWasHeader) {
                    // Read ADPCM header bytes for each channel
                    adpcmShift = byte >>> 4;
                    adpcmFilter = byte & 0b1111;
                    adpcmLastByteWasHeader = true;
                } else {
                    adpcmLastByteWasHeader = false;
                    
                    // Upper nibble
                    const sampleValue1 = adpcmDecode(adpcmShift, adpcmFilter, byte >>> 4, adpcmOld, adpcmOlder);
                    this.decodedSamples[channel].push(sampleValue1);
                    adpcmOlder = adpcmOld;
                    adpcmOld = sampleValue1;

                    // Lower nibble
                    const sampleValue2 = adpcmDecode(adpcmShift, adpcmFilter, byte & 0b1111, adpcmOld, adpcmOlder);
                    this.decodedSamples[channel].push(sampleValue2);
                    adpcmOlder = adpcmOld;
                    adpcmOld = sampleValue2;

                    this.decoderSample += 2;
                }
                return i + 1;
            }
        } else {
            // PCM16
            if (blockSize % 2 != 0) {
                // I don't want to accept the possibility that a sample can be divided by a chunk boundary
                this.decoderError("Block size not divisible by 2, as required by PCM16 encoding. Remaining bytes will be ignored.");
                this.decoderFinished = true;
                return false;
            }
            iter = (channel, i) => {
                let sampleValue = (this.astData[i] << 8) | this.astData[i + 1];
                sampleValue -= (sampleValue & 0x8000) << 1;
                this.decodedSamples[channel].push(sampleValue);
                return i + 2;
            }
            this.decoderSample += blockSize * 0.5;
        }
        // Iterate through bytes in every block in this chunk
        const startSample = this.decoderSample;
        for (let channel = 0; channel < this.header.numChannels; channel++) {
            const blockEnd = i + blockSize;
            if (this.header.audioFormat === 0) {
                this.decoderSample = startSample;
                adpcmShift = this.adpcmShift[channel];
                adpcmFilter = this.adpcmFilter[channel];
                adpcmOld = this.adpcmOld[channel];
                adpcmOlder = this.adpcmOlder[channel];
                adpcmLastByteWasHeader = this.adpcmLastByteWasHeader[channel];
            }
            while (i < blockEnd) {
                if (i >= this.astData.length) {
                    const extraBytes = (chunkStart + this.header.numChannels * blockSize) - this.astData.length;
                    if (Math.floor(extraBytes / blockSize) > 0) {
                        this.decoderError("Reached end of file before expected end of block. Expected " + (extraBytes % blockSize) + " more bytes in block and " + Math.floor(extraBytes / blockSize) + " more blocks in BLCK chunk.\n");
                    } else {
                        this.decoderError("Reached end of file before expected end of block. Expected " + (extraBytes % blockSize) + " more bytes in block.");
                    }
                    this.decoderEndSample = this.decodedSamples[this.decodedSamples.length - 1].length;
                    this.decoderFinished = true;
                    return false;
                }
                i = iter(channel, i);
            }
            if (this.header.audioFormat === 0) {
                this.adpcmShift[channel] = adpcmShift;
                this.adpcmFilter[channel] = adpcmFilter;
                this.adpcmOld[channel] = adpcmOld;
                this.adpcmOlder[channel] = adpcmOlder;
                this.adpcmLastByteWasHeader[channel] = adpcmLastByteWasHeader;
            }
        }
        //console.log("Decoded block " + this.numChunks);
        this.numChunks++;
        this.decoderPosition = i;
        this.decoderEndSample = this.decodedSamples[this.decodedSamples.length - 1].length;
        return true;
    }

    decoderError(message) {
        message = "Decoding Error: " + message;
        console.error(message);
    }

    setPosition(sample) {
        this.outputSample = sample;
    }

    getPosition() {
        return this.outputSample;
    }

    getSample() {
        while (this.decoderSample <= this.outputSample) {
            if (!this.nextBlock()) {
                break;
            }
        }
        if (this.outputSample === this.header.loopEnd || this.outputSample >= this.decoderEndSample) {
            this.outputSample = (this.header.loopStart < this.decoderEndSample) ? this.header.loopStart : 0;
        }
        const channelSamples = Array(this.header.numChannels);
        for (let channel = 0; channel < this.header.numChannels; channel++) {
            if (this.outputSample < this.decodedSamples[channel].length) {
                channelSamples[channel] = this.decodedSamples[channel][this.outputSample];
            } else {
                channelSamples[channel] = 0;
            }
        }
        this.outputSample++;
        return channelSamples;
    }

    getSamples(numSamples) {
        if (numSamples <= 0) {
            const samples = Array(this.header.numChannels);
            for (let channel = 0; channel < this.header.numChannels; channel++) {
                samples[channel] = [];
            }
            return samples;
        }
        
        let endSample = this.outputSample + numSamples;
        while (endSample > this.decoderEndSample) {
            if (!this.nextBlock()) {
                break;
            }
        }
        let loopEnd = Math.min(this.header.loopEnd, this.decoderEndSample);
        if (this.outputSample === loopEnd || this.outputSample >= this.decoderEndSample) {
            this.outputSample = (this.header.loopStart < this.decoderEndSample) ? this.header.loopStart : 0;
            endSample = this.outputSample + numSamples;
        } else if (this.outputSample < loopEnd && endSample > loopEnd) {
            // If the range contains the loop point, split it into two contiguous ranges
            const samples = this.getSamples(loopEnd - this.outputSample);
            this.outputSample = (this.header.loopStart < this.decoderEndSample) ? this.header.loopStart : 0;
            const samples2 = this.getSamples(endSample - loopEnd);
            for (let channel = 0; channel < this.header.numChannels; channel++) {
                samples[channel].push(...samples2[channel]);
            }
            return samples;
        }
        const samples = Array(this.header.numChannels);
        for (let channel = 0; channel < this.header.numChannels; channel++) {
            samples[channel] = this.decodedSamples[channel].slice(this.outputSample, endSample);
        }
        this.outputSample = endSample;
        return samples;
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

const adpcmFilterCoefficients = [
    [0, 0],
    [2048, 0],
    [0, 2048],
    [1024, 1024],
    [4096, -2048],
    [3584, -1536],
    [3072, -1024],
    [4608, -2560],
    [4200, -2248],
    [4800, -2300],
    [5120, -3072],
    [2048, -2048],
    [1024, -1024],
    [-1024, 1024],
    [-1024, 0],
    [-2048, 0],
]

/**
 * Decode a sample of ADPCM audio
 * @param {number} shift Shift amount, from the upper 4 bits of the header byte of the current ADPCM block
 * @param {number} filter Selects a row from the filter coefficient table, from the lower 4 bits of the header byte of the current ADPCM block
 * @param {number} nibble 4-bit value taken from the ADPCM block, used to determine the next sample
 * @param {number} old The immediate previous 16-bit decoded sample
 * @param {number} older The next previous 16-bit decoded sample; the one before old
 * @returns {number} 16-bit decoded sample
 */
function adpcmDecode(shift, filter, nibble, old, older) {
    // ADPCM samples are arranged in blocks of 9 bytes; the first byte is the header byte,
    // and the nibbles of the remaining bytes as well as the values of the two previous
    // decoded samples are used to construct the next 16 16-bit samples.
    
    nibble -= (nibble & 0b1000) << 1;
    let result = nibble << shift;
    result += (old * adpcmFilterCoefficients[filter][0] + older * adpcmFilterCoefficients[filter][1]) >> 11;

    // Clamp to 16 bits
    if (result > 0x7FFF) {
        result = 0x7FFF;
    } else if (result < -0x8000) {
        result = -0x8000;
    }
    return result;
}

