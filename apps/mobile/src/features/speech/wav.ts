export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
}

export interface PcmAudio {
  readonly format: PcmFormat;
  /** Signed 16-bit little-endian samples. */
  readonly samples: Uint8Array;
}

const WAV_HEADER_LENGTH = 44;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Reads 16-bit PCM from a WAV file. Streaming encoders often write a placeholder data length, so
 * the data chunk is clamped to the bytes actually received.
 */
export function parseWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("The voice server did not return WAV audio.");
  }
  let format: PcmFormat | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      const encoding = view.getUint16(body, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (encoding !== 1 || bitsPerSample !== 16) {
        throw new Error("The voice server must return 16-bit PCM WAV audio.");
      }
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
      };
    } else if (id === "data") {
      if (!format) break;
      const end = Math.min(bytes.length, body + size);
      // Keep whole samples so a truncated stream cannot shift every later byte pair.
      const length = end - body - ((end - body) % (2 * format.channels));
      return { format, samples: bytes.subarray(body, body + length) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("The voice server returned WAV audio without PCM data.");
}

/** Joins PCM pieces of one format into a single WAV file. */
export function encodeWav(pieces: readonly PcmAudio[]): Uint8Array {
  const format = pieces[0]?.format;
  if (!format) throw new Error("There is no audio to play.");
  const dataLength = pieces.reduce((total, piece) => {
    if (
      piece.format.sampleRate !== format.sampleRate ||
      piece.format.channels !== format.channels
    ) {
      throw new Error("The voice server changed audio formats between parts of one message.");
    }
    return total + piece.samples.length;
  }, 0);
  const bytes = new Uint8Array(WAV_HEADER_LENGTH + dataLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  const blockAlign = 2 * format.channels;
  writeAscii(0, "RIFF");
  view.setUint32(4, WAV_HEADER_LENGTH - 8 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  let offset = WAV_HEADER_LENGTH;
  for (const piece of pieces) {
    bytes.set(piece.samples, offset);
    offset += piece.samples.length;
  }
  return bytes;
}
