import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: () => null }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly name: string;
    constructor(readonly uri: string) {
      this.name = uri.split("/").pop() ?? "";
    }
    async bytes() {
      return new TextEncoder().encode("AUDIO");
    }
  },
}));

// The exact serializer Expo's fetch runs on FormData bodies.
import { convertFormDataAsync } from "expo/src/winter/fetch/convertFormData";

import { recordingPart } from "./speechTranscription";

describe("recordingPart", () => {
  it("is accepted by Expo's FormData serializer", async () => {
    const part = recordingPart("file:///cache/recording-7.m4a");
    const formData = {
      entries: () => [
        ["file", part.file],
        ["model", "whisper-1"],
      ],
    } as unknown as FormData;
    const { body, boundary } = await convertFormDataAsync(formData, "B");
    const text = new TextDecoder().decode(body);
    expect(boundary).toBe("B");
    expect(text).toContain(
      'content-disposition: form-data; name="file"; filename="recording-7.m4a"\r\ncontent-type: audio/m4a\r\n\r\nAUDIO\r\n',
    );
    expect(text).toContain('name="model"\r\n\r\nwhisper-1\r\n');
  });

  it("documents why React Native's { uri } shape fails there", async () => {
    const formData = {
      entries: () => [["file", { uri: "file:///x.m4a", name: "x.m4a", type: "audio/m4a" }]],
    } as unknown as FormData;
    await expect(convertFormDataAsync(formData, "B")).rejects.toThrow(
      "Unsupported FormDataPart implementation",
    );
  });
});
