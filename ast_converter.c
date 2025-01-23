// AST converter - convert .ast audio streams to .wav

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

static void write4_LE(uint8_t *pointer, uint32_t value) {
    pointer[0] = value & 0xFF;
    pointer[1] = (value >> 8) & 0xFF;
    pointer[2] = (value >> 16) & 0xFF;
    pointer[3] = value >> 24;
}

/**
 * Write WAV header to beginning of byte array based on given information. Assumes 16 bits per sample.
 * @param sample_rate Output sample rate.
 * @param num_channels Number of channels.
 * @param file_bytes Pointer to byte array where audio data is stored. Expects a 44-byte space at the beginning where the header will be written.
 * @param file_size Length of byte array, including header.
 * @returns Array of bytes containing WAV file data.
 */
void write_wav_header(uint32_t sample_rate, uint16_t num_channels, uint8_t *file_bytes, size_t file_size) {
    // RIFF[FileSize]WAVE
    file_bytes[0] = 'R'; file_bytes[1] = 'I'; file_bytes[2] = 'F'; file_bytes[3] = 'F'; // "RIFF"
    write4_LE(&file_bytes[4], (uint32_t) (file_size - 8)); // File size minus 8 bytes
    file_bytes[8] = 'W'; file_bytes[9] = 'A'; file_bytes[10] = 'V'; file_bytes[11] = 'E'; // "WAVE"

    // Beginning of format block
    file_bytes[12] = 'f';  file_bytes[13] = 'm';  file_bytes[14] = 't';  file_bytes[15] = ' ';  // "fmt "
    file_bytes[16] = 0x10; file_bytes[17] = 0x00; file_bytes[18] = 0x00; file_bytes[19] = 0x00; // Size of format block minus the initial 8 (always 16)
    file_bytes[20] = 0x01; file_bytes[21] = 0x00; // Audio format - 0x01 indicates PCM integer
    file_bytes[22] = num_channels & 0xFF; file_bytes[23] = num_channels >> 8; // Number of channels
    write4_LE(&file_bytes[24], sample_rate); // Sample rate
    uint16_t bytes_per_block = 2 * num_channels;
    write4_LE(&file_bytes[28], sample_rate * bytes_per_block); // Bytes per second
    file_bytes[32] = bytes_per_block & 0xFF; file_bytes[33] = bytes_per_block >> 8; // Bytes per block
    file_bytes[34] = 0x10; file_bytes[35] = 0x00; // Bits per sample (16)

    // Beginning of data block
    file_bytes[36] = 'd'; file_bytes[37] = 'a'; file_bytes[38] = 't'; file_bytes[39] = 'a'; // "data"
    write4_LE(&file_bytes[40], (uint32_t) (file_size - 44)); // Data size
}

static uint32_t read4_BE(uint8_t *pointer) {
    return pointer[0] << 24 | pointer[1] << 16 | pointer[2] << 8 | pointer[3];
}

static uint16_t read2_BE(uint8_t *pointer) {
    return pointer[0] << 8 | pointer[1];
}

static const int16_t adpcm_filter_coefficients[16][2] = {
    {0, 0},
    {2048, 0},
    {0, 2048},
    {1024, 1024},
    {4096, -2048},
    {3584, -1536},
    {3072, -1024},
    {4608, -2560},
    {4200, -2248},
    {4800, -2300},
    {5120, -3072},
    {2048, -2048},
    {1024, -1024},
    {-1024, 1024},
    {-1024, 0},
    {-2048, 0},
};

/**
 * Decode a sample of ADPCM audio
 * @param shift Shift amount, from the upper 4 bits of the header byte of the current ADPCM block
 * @param filter Selects a row from the filter coefficient table, from the lower 4 bits of the header byte of the current ADPCM block
 * @param nibble 4-bit value taken from the ADPCM block, used to determine the next sample
 * @param old The immediate previous 16-bit decoded sample
 * @param older The next previous 16-bit decoded sample; the one before old
 * @returns 16-bit decoded sample
 */
int16_t adpcm_decode(uint8_t shift, uint8_t filter, int16_t nibble, int16_t old, int16_t older) {
    // ADPCM samples are arranged in blocks of 9 bytes; the first byte is the header byte,
    // and the nibbles of the remaining bytes as well as the values of the two previous
    // decoded samples are used to construct the next 16 16-bit samples.
    
    nibble -= (nibble & 0x8) << 1;
    int32_t result = nibble << shift;
    result += (old * adpcm_filter_coefficients[filter][0] + older * adpcm_filter_coefficients[filter][1]) >> 11;

    // Clamp to 16 bits
    if (result > 0x7FFF) {
        result = 0x7FFF;
    } else if (result < -0x8000) {
        result = -0x8000;
    }
    return (int16_t) result;
}

typedef struct {
    uint8_t adpcm_shift;
    uint8_t adpcm_filter;
    int16_t adpcm_old;
    int16_t adpcm_older;
    uint8_t adpcm_last_byte_was_header;
} adpcm_state;

/**
 * Decodes AST file data and encodes it in WAV format
 * @param file_bytes Array containing all bytes from the AST file
 * @param file_size Number of bytes in the AST file; length of `file_bytes`
 * @param do_conversion If false, skips decoding and returns `NULL`
 * @param output_file_size Number of bytes of returned data
 * @param print_header print metadata from file header
 * @param print_unknown print unknown values of file header. Only takes effect if `print_header` is also enabled
 * @returns Pointer to re-encoded data in WAV format. Must be freed
 */
void *convert_ast_file(uint8_t *file_bytes, size_t file_size, int do_conversion, size_t *output_file_size, int print_header, int print_unknown) {
    if (file_size < 0x40) {
        fprintf(stderr, "Error: File data is not in AST format; not enough file data to fit entire AST header\n");
        return NULL;
    }
    if (!(file_bytes[0] == 'S' && file_bytes[1] == 'T' && file_bytes[2] == 'R' && file_bytes[3] == 'M')) {
        fprintf(stderr, "Error: File data is not in AST format; missing \"STRM\" magic number\n");
        return NULL; // Missing "STRM"
    }

    // Read header information
    uint32_t data_size = read4_BE(&file_bytes[4]);
    uint16_t audio_format = read2_BE(&file_bytes[8]);
    uint16_t bits_per_sample = read2_BE(&file_bytes[10]); // This is ignored and instead we assume 16 bit
    uint16_t num_channels = read2_BE(&file_bytes[12]);
    uint16_t unknown1 = read2_BE(&file_bytes[14]);
    uint32_t sample_rate = read4_BE(&file_bytes[16]);
    uint32_t num_samples = read4_BE(&file_bytes[20]);
    uint32_t loop_start = read4_BE(&file_bytes[24]);
    uint32_t loop_end = read4_BE(&file_bytes[28]);
    uint32_t first_block_size = read4_BE(&file_bytes[32]);
    uint32_t unknown2 = read4_BE(&file_bytes[36]);
    uint32_t unknown3 = read4_BE(&file_bytes[40]);
    if (print_header) {
        printf("header information:\n");
        printf("    Size of all sound blocks: %d bytes\n", data_size);
        printf("    Audio format (0 = ADPCM, 1 = PCM16): %u\n", audio_format);
        printf("    Bit depth: %u\n", bits_per_sample);
        printf("    Number of channels: %u\n", num_channels);
        if (print_unknown) {
            printf("    Unknown: %x\n", unknown1);
        }
        printf("    Sample rate: %u\n", sample_rate);
        printf("    Number of samples: %u\n", num_samples);
        printf("    Loop start sample: %u\n", loop_start);
        printf("    Loop end sample: %u\n", loop_end);
        printf("    Probably size of first block: %u\n", first_block_size);
        if (print_unknown) {
            printf("    Unknown: %x\n", unknown2);
            printf("    Unknown: %x\n", unknown3);
        }
        printf("End of file header\n");
    }

    if (!do_conversion) {
        return NULL;
    }

    if (audio_format > 1) {
        fprintf(stderr, "Error: Unrecognized audio format; this decoder only recognizes formats 0 = ADPCM, 1 = PCM16, but this file uses format %d\n", audio_format);
        return NULL;
    }

    // ADPCM decoder state for each channel
    adpcm_state *adpcm_states = (adpcm_state *) malloc(num_channels * sizeof(adpcm_state));

    // Allocate space based on an overestimate of final file size, probably by several kilobytes.
    size_t wav_estimated_size = file_size - 0x40;
    if (audio_format == 0) {
        // ADPCM
        wav_estimated_size = wav_estimated_size / 9 * 32;
    } else {
        wav_estimated_size += wav_estimated_size % 2;
    }
    wav_estimated_size += 44;
    uint8_t *wav_data = (uint8_t *) malloc(wav_estimated_size); 
    size_t wav_index = 44;
    
    size_t chunk_num = 0;
    size_t processed = 0;
    for (size_t i = 0x40; i < file_size;) {
        size_t samples_before_chunk = processed;
        if (!(file_bytes[i] == 'B' && file_bytes[i + 1] == 'L' && file_bytes[i + 2] == 'C' && file_bytes[i + 3] == 'K')) {
            if (chunk_num == 1) {
                // Nothing has been decoded, output nothing
                fprintf(stderr, "Error: Missing \"BLCK\" magic number where BLCK chunk 1 is expected to start\n");
                free(wav_data);
                free(adpcm_states);
                return NULL;
            }
            fprintf(stderr, "Warning: Missing \"BLCK\" magic number where BLCK chunk %zu is expected to start. Remaining bytes will be ignored\n", chunk_num);
            break;
        }
        //printf("Start of BLCK chunk %zu\n", chunk_num);
        i += 4;
        uint32_t block_size = read4_BE(&file_bytes[i]);
        //printf("Block size: %u\n", block_size);
        i += 28;
        size_t wav_block_start = wav_index;
        for (uint16_t channel = 0; channel < num_channels; channel++) {
            //printf("Start of block for channel %u\n", channel);
            processed = samples_before_chunk;
            size_t block_end = i + block_size;
            wav_index = wav_block_start;
            if (audio_format == 1) {
                // PCM16
                while (i < block_end && i + 1 < file_size) {
                    // AST uses big-endian while WAV uses little-endian, so we swap the bytes.
                    wav_data[wav_index] = file_bytes[i + 1];
                    wav_data[wav_index + 1] = file_bytes[i];
                    wav_index += 2 * num_channels;
                    i += 2;
                    processed++;
                }
            } else {
                // ADPCM
                adpcm_state *ch_state = &adpcm_states[channel];
                while (i < block_end && i < file_size) {
                    uint8_t file_byte = file_bytes[i];
                    if (processed % 16 == 0 && !ch_state->adpcm_last_byte_was_header) {
                        // Read ADPCM header bytes for each channel
                        ch_state->adpcm_shift = file_byte >> 4;
                        ch_state->adpcm_filter = file_byte & 0xF;
                        ch_state->adpcm_last_byte_was_header = 1;
                    } else {
                        ch_state->adpcm_last_byte_was_header = 0;
                        
                        // Upper nibble
                        int16_t sample = adpcm_decode(ch_state->adpcm_shift, ch_state->adpcm_filter, file_byte >> 4, ch_state->adpcm_old, ch_state->adpcm_older);
                        wav_data[wav_index] = (uint8_t) (sample & 0xFF);
                        wav_data[wav_index + 1] = (uint8_t) (sample >> 8);
                        wav_index += 2 * num_channels;
                        ch_state->adpcm_older = ch_state->adpcm_old;
                        ch_state->adpcm_old = sample;

                        // Lower nibble
                        sample = adpcm_decode(ch_state->adpcm_shift, ch_state->adpcm_filter, file_byte & 0xF, ch_state->adpcm_old, ch_state->adpcm_older);
                        wav_data[wav_index] = (uint8_t) (sample & 0xFF);
                        wav_data[wav_index + 1] = (uint8_t) (sample >> 8);
                        wav_index += 2 * num_channels;
                        ch_state->adpcm_older = ch_state->adpcm_old;
                        ch_state->adpcm_old = sample;

                        processed += 2;
                    }
                    i++;
                }
            }
            if (i < block_end) {
                // Fill remaining parts of wav file with zeroes
                uint16_t remaining_blocks = num_channels - channel - 1;
                size_t samples_left_in_block = block_end - i;
                fprintf(stderr, "Warning: Reached end of file before expected end of block. Expected %zu more bytes in this block and %u more blocks in this BLCK chunk.\n", samples_left_in_block, remaining_blocks);
                if (audio_format == 1) {
                    // PCM16
                    for (size_t j = i; j < block_end && wav_index < wav_estimated_size; j += 2) {
                        wav_data[wav_index] = 0;
                        wav_data[wav_index + 1] = 0;
                        wav_index += 2 * num_channels;
                        processed++;
                    }
                } else {
                    // ADPCM
                    adpcm_state *ch_state = &adpcm_states[channel];
                    for (size_t j = i; j < block_end; j++) {
                        if (processed % 16 == 0 && !ch_state->adpcm_last_byte_was_header) {
                            ch_state->adpcm_last_byte_was_header = 1;
                        } else {
                            ch_state->adpcm_last_byte_was_header = 0;
                            if (wav_index >= wav_estimated_size) {
                                break;
                            }
                            wav_data[wav_index] = 0;
                            wav_data[wav_index + 1] = 0;
                            wav_index += 2 * num_channels;
                            if (wav_index >= wav_estimated_size) {
                                break;
                            }
                            wav_data[wav_index] = 0;
                            wav_data[wav_index + 1] = 0;
                            wav_index += 2 * num_channels;
                            processed += 2;
                        }
                    }
                }
                size_t samples_in_block = processed - samples_before_chunk;
                wav_block_start += 2;
                for (size_t k = channel + 1; k < num_channels && wav_index < wav_estimated_size; k++) {
                    wav_index = wav_block_start;
                    for (size_t j = 0; j < samples_in_block && wav_index < wav_estimated_size; j++) {
                        wav_data[wav_index] = 0;
                        wav_data[wav_index + 1] = 0;
                        wav_index += 2 * num_channels;
                    }
                    wav_block_start += 2;
                }
                break;
            }
            wav_block_start += 2;
        }
        wav_index -= 2 * (num_channels - 1);
        chunk_num++;
    }
    free(adpcm_states);
    *output_file_size = 44 + 2 * num_channels * processed;
    write_wav_header(sample_rate, num_channels, wav_data, *output_file_size);
    return wav_data;
}

static void *get_file_contents(char *file_path, size_t *file_size) {
    FILE *file = fopen(file_path, "r");

    if (file == NULL) {
        fprintf(stderr, "Error: could not open file %s\n", file_path);
        return NULL;
    }

    fseek(file, 0, SEEK_END);             // Jump to the end of the file
    *file_size = (size_t) ftell(file);    // Get the current byte offset in the file
    rewind(file);                         // Jump back to the beginning of the file

    void *contents = malloc(*file_size);
    fread(contents, *file_size, 1, file); // Read in the entire file
    fclose(file);

    return contents;
}

static int file_exists(char *file_path) {
    FILE *file = fopen(file_path, "r+");
    if (file == NULL) {
        return 0;
    }
    fclose(file);
    return 1;
}

static int write_file(char *file_path, void *file_data, size_t file_size) {
    FILE *file = fopen(file_path, "wb");

    if (file == NULL) {
        fprintf(stderr, "Error: could not open file %s\n", file_path);
        return 1;
    }

    fwrite(file_data, sizeof(uint8_t), file_size, file);
    fclose(file);
    return 0;
}

static char *filename_from_path(char *file_path) {
    size_t i = strlen(file_path) - 1;
    while (i > 0 && file_path[i - 1] != '/'
#ifdef _WIN32
           && file_path[i - 1] != '\\'
#endif
    ) {
        i--;
    }
    return &file_path[i];
}

static char *change_filename_extension(char *file_name, char *extension) {
    char *extension_start = strrchr(file_name, '.');
    size_t extension_len = strlen(extension);
    size_t base_len;
    if (extension_start == NULL) {
        // Source file has no extension
        base_len = strlen(file_name);
    } else {
        base_len = (extension_start - file_name) / sizeof(char);
    }
    size_t new_len = base_len + 1 + extension_len;
    char *new_name = (char *) malloc((new_len + 1) * sizeof(char));
    memcpy(new_name, file_name, base_len * sizeof(char));
    memcpy(&new_name[base_len + 1], extension, (extension_len + 1) * sizeof(char));
    new_name[base_len] = '.';
    return new_name;
}

static char *program_name;

static void helptext(void) {
    printf("Usage:\n    %s [options] file1.ast file2.ast file3.ast ...\n", program_name);
    printf("Convert .ast audio streams to .wav\n");
    printf("Converted results will be written to .wav files of the same names in the current working directory\n");
    printf("\nOptions:\n");
    printf("    --overwrite     Write output files even if files of the same name already exist\n");
    printf("    --fileinfo      Print information from input file headers\n");
    printf("    --unknowns      Print file header values whose purpose is unknown. Only takes effect if `--fileinfo` is also used\n");
}

int main(int argc, char *argv[]) {
    program_name = filename_from_path(argv[0]);
    if (argc < 2) {
        helptext();
        return 1;
    }

    // Options
    int fileinfo = 0;
    int overwrite = 0;
    int include_unknowns = 0;

    char **file_paths = malloc(argc * sizeof(char *));
    size_t num_files = 0;
    for (int i = 1; i < argc; i++) {
        char *nextparam = argv[i];
        if (nextparam[0] == '-') {
            // Decode options
            if (strcmp(nextparam, "--overwrite") == 0) {
                overwrite = 1;
            } else if (strcmp(nextparam, "--fileinfo") == 0) {
                fileinfo = 1;
            } else if (strcmp(nextparam, "--unknowns") == 0) {
                include_unknowns = 1;
            } else {
                printf("Unrecognized option `%s`\n", nextparam);
                helptext();
                free(file_paths);
                return 1;
            }
        } else {
            file_paths[num_files++] = nextparam;
        }
    }

    if (num_files == 0) {
        printf("No files were provided\n");
        helptext();
        free(file_paths);
        return 1;
    }

    size_t num_completed = 0;
    for (size_t i = 0; i < num_files; i++) {
        size_t file_size;
        char *input_file_path = file_paths[i];
        void *input_file_data = get_file_contents(input_file_path, &file_size);
        if (input_file_data == NULL) {
            continue;
        }
        //printf("Input file size: %ld bytes\n", file_size);
        char *input_filename = filename_from_path(input_file_path);
        char *output_file_path = change_filename_extension(input_filename, "wav");
        //printf("Output file path: %s\n", output_file_path);
        if (fileinfo) {
            printf("%s ", input_filename);
            convert_ast_file(input_file_data, file_size, 0, NULL, 1, include_unknowns);
        }
        if (!overwrite && file_exists(output_file_path)) {
            // Skip conversion if file already exists
            printf("Skipping conversion of %s, file %s already exists\n", input_filename, output_file_path);
        } else {
            // Do conversion
            size_t output_file_size;
            printf("Beginning conversion on %s\n", input_filename);
            void *output_file_data = convert_ast_file(input_file_data, file_size, 1, &output_file_size, 0, 0);
            //printf("Finished converting %s\n", input_file_path);
            free(input_file_data);
            if (output_file_data == NULL) {
                fprintf(stderr, "Failed to convert %s\n", input_file_path);
            } else {
                //printf("Output file size: %zu\n", output_file_size);
                if (!overwrite && file_exists(output_file_path)) {
                    // Also check after converting
                    // Note that this is still not thread safe
                    printf("File %s already exists, aborting\n", output_file_path);
                } else {
                    if (write_file(output_file_path, output_file_data, output_file_size) == 0) {
                        printf("Wrote decoded data to %s\n", output_file_path);
                        num_completed++;
                    }
                }
            }
            free(output_file_data);
        }
        free(output_file_path);
    }
    free(file_paths);
    if (num_files > 1) {
        printf("Converted %zu/%zu files\n", num_completed, num_files);
    }

    return 0;
}
