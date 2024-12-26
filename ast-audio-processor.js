import { ASTDecoder } from "./ast-decoder.js";

/**
 * AudioWorkletProcessor that outputs audio from AST file data
 */
class ASTAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processor = this; // why do I have to do this
        this.astDecoder = new ASTDecoder(options.processorOptions.astData);

        this.port.onmessage = function(message) {
            // Send back the current position whenever requested.
            switch (message.data.type) {
                case "get_position":
                    processor.port.postMessage({type: "position", param: processor.astDecoder.getPosition()});
                    break;
                case "set_position":
                    processor.astDecoder.setPosition(+message.data.param);
                    break;
            }
        }
    }

    process(inputs, outputs, parameters) {
        let outputLength = outputs[0][0].length;
        const samples = this.astDecoder.getSamples(outputLength);
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
        return true;
    }
}

registerProcessor('ast-audio-processor', ASTAudioProcessor);