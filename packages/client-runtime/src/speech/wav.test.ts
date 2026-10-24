import { describe, expect, it } from "vite-plus/test";

import { encodeWav, parseWav } from "./wav.ts";

const format = { sampleRate: 24_000, channels: 1 };

describe("wav", () => {
  it("round-trips joined PCM pieces", () => {
    const wav = encodeWav([
      { format, samples: new Uint8Array([1, 2, 3, 4]) },
      { format, samples: new Uint8Array([5, 6]) },
    ]);
    const parsed = parseWav(wav);
    expect(parsed.format).toEqual(format);
    expect([...parsed.samples]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("clamps a streaming placeholder length to the received whole samples", () => {
    const wav = encodeWav([{ format, samples: new Uint8Array([1, 2, 3, 4]) }]);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    const truncated = new Uint8Array([...wav, 9]);
    expect([...parseWav(truncated).samples]).toEqual([1, 2, 3, 4]);
  });

  it("rejects mismatched formats", () => {
    expect(() =>
      encodeWav([
        { format, samples: new Uint8Array(2) },
        { format: { sampleRate: 44_100, channels: 1 }, samples: new Uint8Array(2) },
      ]),
    ).toThrow(/changed audio formats/);
  });

  it("rejects non-WAV responses", () => {
    expect(() => parseWav(new TextEncoder().encode("ID3 not a wav file"))).toThrow(/WAV/);
  });
});
