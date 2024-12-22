/**
 * AudioWorkletProcessor that outputs audio from AST file data
 */
class ASTAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processor = this; // why do I have to do this
        this.decodedAST = options.processorOptions.decodedAST;

        this.sample = 0;
        this.chunk = 0;
        const chunkStart = this.decodedAST.chunkStarts[0];
        this.chunkSize = this.decodedAST.chunkSizes[0]
        this.chunkEnd = chunkStart + this.chunkSize;
        this.dataIndex = chunkStart;
        this.oldSample = Array(this.decodedAST.numChannels).fill(0);
        this.olderSample = Array(this.decodedAST.numChannels).fill(0);
        this.adpcmShift = Array(this.decodedAST.numChannels);
        this.adpcmFilter = Array(this.decodedAST.numChannels);
        for (let channel = 0; channel < this.decodedAST.numChannels; channel++) {
            const header = this.decodedAST.astData[chunkStart + channel * this.chunkSize];
            this.adpcmShift[channel] = header >>> 4;
            this.adpcmFilter[channel] = header & 0b1111;
        }
        console.log(this.adpcmShift);
        console.log(this.adpcmFilter);

        this.port.onmessage = function(message) {
            // Send back the current position whenever requested.
            switch (message.data.type) {
                case "get_position":
                    processor.port.postMessage({type: "position", param: processor.sample});
                    break;
                case "set_position":
                    processor.setPosition(message.data.param);
                    break;
            }
        }
    }

    setPosition(targetSample) {
        let left = 0;
        let right = this.decodedAST.chunkStartSamples.length - 1;
        while (left < right) {
            const mid = Math.floor((left + right) * 0.5);
            const chunkStartSample = this.decodedAST.chunkStartSamples[mid];
            const chunkSize = this.decodedAST.chunkSizes[mid];
            if (targetSample >= chunkStartSample) {
                left = mid;
                let numSamples;
                if (this.decodedAST.audioFormat === 0) {
                    // ADPCM
                    numSamples = (chunkSize / 9) * 16;
                } else {
                    // PCM16
                    numSamples = chunkSize * 0.5;
                }
                if (targetSample < chunkStartSample + numSamples) {
                    break;
                } else {
                    left = mid + 1;
                }
            } else {
                right = mid - 1;
            }
        }
        this.setPositionGivenChunk(targetSample, left);
    }

    setPositionGivenChunk(targetSample, chunk) {
        this.sample = targetSample;
        this.chunk = chunk;
        const chunkStart = this.decodedAST.chunkStarts[chunk];
        this.chunkSize = this.decodedAST.chunkSizes[chunk];
        this.chunkEnd = chunkStart + this.chunkSize;
        const sampleDiff = targetSample - this.decodedAST.chunkStartSamples[chunk];
        if (this.decodedAST.audioFormat === 1) {
            // PCM16
            this.dataIndex = chunkStart + 2 * sampleDiff;
        } else {
            // ADPCM
            let old = Array(this.decodedAST.numChannels).fill(0);
            let older = Array(this.decodedAST.numChannels).fill(0);
            let i;
            for (let channel = this.decodedAST.numChannels - 1; channel >= 0; channel--) {
                i = chunkStart + channel * this.chunkSize;
                while (i < chunkStart + 9 * Math.floor(sampleDiff / 16)) {
                    const header = this.decodedAST.astData[i];
                    const shift = header >>> 4;
                    const filter = header & 0b1111;
                    const blockEnd = i + 9;
                    for (i++; i < blockEnd; i++) {
                        const byte = this.decodedAST.astData[i];
                        let next = adpcmDecode(shift, filter, byte >>> 4, old[channel], older[channel]);
                        older[channel] = old[channel];
                        old[channel] = next;

                        next = adpcmDecode(shift, filter, byte & 0b1111, old[channel], older[channel]);
                        older[channel] = old[channel];
                        old[channel] = next;
                    }
                }
                const header = this.decodedAST.astData[i];
                const shift = header >>> 4;
                const filter = header & 0b1111;
                const remainingSamples = sampleDiff % 16;
                const byteEnd = i + Math.floor(remainingSamples * 0.5);
                for (i++; i < byteEnd; i++) {
                    const byte = this.decodedAST.astData[i];
                    let next = adpcmDecode(shift, filter, byte >>> 4, old[channel], older[channel]);
                    older[channel] = old[channel];
                    old[channel] = next;

                    next = adpcmDecode(shift, filter, byte & 0b1111, old[channel], older[channel]);
                    older[channel] = old[channel];
                    old[channel] = next;
                }
                if (remainingSamples % 2 === 1) {
                    const byte = this.decodedAST.astData[i];
                    let next = adpcmDecode(shift, filter, byte >>> 4, old[channel], older[channel]);
                    older[channel] = old[channel];
                    old[channel] = next;
                }
                this.adpcmShift[channel] = shift;
                this.adpcmFilter[channel] = filter;
            }
            this.oldSample = old;
            this.olderSample = older;
            this.dataIndex = i;
        }
    }

    process(inputs, outputs, parameters) {
        let outputLength = outputs[0][0].length;
        for (let sample = 0; sample < outputLength; sample++) {
            if (this.sample > this.decodedAST.numSamplesAccordingToHeader) {
                // Out of bounds; end song
                for (;sample < outputLength; sample++) {
                    for (let channel = 0; channel < Math.min(2, outputs[0].length); channel++) {
                        outputs[0][channel][sample] = 0;
                    }
                }
                this.port.postMessage({type: "finish"});
                return true;
            }
            if (this.sample === this.decodedAST.loopEnd) {
                // After finishing the loop end sample, jump to the loop start sample.
                this.setPositionGivenChunk(this.decodedAST.loopStart, this.decodedAST.loopStartChunk);
            }
            if (this.decodedAST.audioFormat === 0 && this.sample % 16 === 0) {
                // Read ADPCM header bytes for each channel
                for (let channel = 0; channel < this.decodedAST.numChannels; channel++) {
                    const header = this.decodedAST.astData[this.dataIndex + channel * this.chunkSize];
                    this.adpcmShift[channel] = header >>> 4;
                    this.adpcmFilter[channel] = header & 0b1111;
                }
                this.dataIndex++;
            }
            const dataIndexReset = this.dataIndex;
            for (let channel = 0; channel < Math.min(2, outputs[0].length); channel++) {
                let sampleValue;
                if (this.decodedAST.audioFormat === 1) {
                    // PCM16
                    sampleValue = (this.decodedAST.astData[this.dataIndex] << 8) | (this.decodedAST.astData[this.dataIndex + 1] & 0xFF);
                    sampleValue -= (sampleValue & 0x8000) << 1;
                } else {
                    // ADPCM
                    const byte = this.decodedAST.astData[this.dataIndex];
                    let nibble;
                    if (this.sample % 2 === 0) {
                        nibble = byte >>> 4;
                    } else {
                        nibble = byte & 0b1111;
                    }
                    sampleValue = adpcmDecode(this.adpcmShift[channel], this.adpcmFilter[channel], nibble, this.oldSample[channel], this.olderSample[channel]);
                    this.olderSample[channel] = this.oldSample[channel];
                    this.oldSample[channel] = sampleValue;
                }
                // Convert from 16-bit signed int to the -1 to 1 floating point range.
                outputs[0][channel][sample] = sampleValue / 32767;
                this.dataIndex += this.chunkSize;
            }
            this.sample++;
            this.dataIndex = dataIndexReset;
            if (this.decodedAST.audioFormat === 1) {
                // PCM16
                this.dataIndex += 2;
            } else if (this.sample % 2 === 0) {
                // Increment ADPCM every other cycle
                this.dataIndex++;
            }
            if (this.dataIndex === this.chunkEnd) {
                // Advance to next chunk
                this.chunk++;
                this.dataIndex = this.decodedAST.chunkStarts[this.chunk];
                this.chunkSize = this.decodedAST.chunkSizes[this.chunk];
                this.chunkEnd = this.dataIndex + this.chunkSize;
                //this.oldSample = Array(this.decodedAST.numChannels).fill(0);
                //this.olderSample = Array(this.decodedAST.numChannels).fill(0);
            }
        }
        return true;
    }
}

registerProcessor('ast-audio-processor', ASTAudioProcessor);

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
    [-2048, 0]
]

/**
 * Decode a sample of ADPCM audio
 * @param {number} shift Shift amount, from the upper 4 bits of the header byte of the current ADPCM block
 * @param {number} filter Selects a row from the filter coefficient table, from the lower 4 bits of the header byte of the current ADPCM block
 * @param {number} nibble 4-bit value taken from the ADPCM block, used to determine the next sample
 * @param {number} old The immediate previous 15-bit decoded sample
 * @param {number} older The next previous 15-bit decoded sample; the one before old
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