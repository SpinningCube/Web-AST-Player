import { ASTDecoder } from "./ast-decoder.js";

/**
 * AudioWorkletProcessor that outputs audio from AST file data
 */
class ASTAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.astDecoder = new ASTDecoder(options.processorOptions.astData);
        this.numTracks = Math.floor(this.astDecoder.header.numChannels * 0.5);
        this.trackVolumes = Array(this.numTracks).fill(0);
        this.trackVolumes[0] = 1;

        this.port.onmessage = (message) => {
            // Send back the current position whenever requested.
            switch (message.data.type) {
                case "get_position":
                    this.port.postMessage({type: "position", param: this.astDecoder.getPosition()});
                    break;
                case "set_position":
                    this.astDecoder.setPosition(+message.data.param);
                    break;
                case "set_track_volume":
                    if (message.data.param.trackNum in this.trackVolumes) {
                        this.trackVolumes[message.data.param.trackNum] = Math.max(0, Math.min(message.data.param.value, 1));
                    }
                    break;
            }
        };
    }

    process(inputs, outputs, parameters) {
        let outputLength = outputs[0][0].length;
        /*const start = this.astDecoder.getPosition();
        const samples = this.astDecoder.getSamples(outputLength);
        const destination = this.astDecoder.getPosition();
        this.astDecoder.setPosition(start); 
        for (let channel = 0; channel < Math.min(2, outputs[0].length); channel++) {
            let sample = 0;
            for (; sample < samples[channel].length; sample++) {
                // Convert from 16-bit signed int to the -1 to 1 floating point range.
                let sampleValue = samples[channel][sample] / 32767;

                // Can't be too careful
                sampleValue = Math.max(-1, Math.min(sampleValue, 1));

                outputs[0][channel][sample] = sampleValue;
            }
            for (; sample < outputLength; sample++) {
                outputs[0][channel][sample] = 0;
            }
        }
        this.astDecoder.setPosition(destination);*/
        for (let sample = 0; sample < outputLength; sample++) {
            const samples = this.astDecoder.getSample();
            for (let channel = 0; channel < Math.min(2, outputs[0].length); channel++) {
                let finalSample = 0;
                for (let track = 0; track < this.numTracks; track++) {
                    // Convert from 16-bit signed int to the -1 to 1 floating point range.
                    let sampleValue = samples[2 * track + channel] / 32767;
    
                    // Can't be too careful
                    sampleValue = Math.max(-1, Math.min(sampleValue, 1));
                    
                    finalSample += sampleValue * this.trackVolumes[track];
                }
                outputs[0][channel][sample] = finalSample;
            }
        }
        return true;
    }
}

registerProcessor('ast-audio-processor', ASTAudioProcessor);