import {
  createSpeechSettingsStore,
  setSpeechFetch,
  type SpeechSettings,
  type SpeechSettingsStore,
} from "@t3tools/client-runtime/speech";
import { useSyncExternalStore } from "react";

// Client-only: API keys stay on this device and go only to the chosen provider.
const STORAGE_KEY = "t3code.speech.settings";

const store: SpeechSettingsStore = createSpeechSettingsStore({
  read: async () => window.localStorage.getItem(STORAGE_KEY),
  write: async (value) => window.localStorage.setItem(STORAGE_KEY, value),
});

export const loadSpeechSettings = store.load;
export const updateSpeechSettings = store.update;
export const currentSpeechSettings = store.current;

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(store.subscribe, store.current);
}

// The desktop app sends provider requests from its main process: self-hosted speech servers
// often lack the CORS headers a renderer request needs.
const desktopSpeechRequest = window.desktopBridge?.speechRequest;
if (desktopSpeechRequest) {
  setSpeechFetch(async (url, init) => {
    const request = new Request(url, init);
    const method = request.method === "GET" ? "GET" : "POST";
    const response = await desktopSpeechRequest({
      url,
      method,
      headers: Object.fromEntries(request.headers),
      body: method === "GET" ? null : new Uint8Array(await request.arrayBuffer()),
    });
    init.signal?.throwIfAborted();
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : (response.body as Uint8Array<ArrayBuffer>), {
      status: response.status,
      headers: { "content-type": response.contentType },
    });
  });
} else {
  setSpeechFetch(async (url, init) => {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!(error instanceof TypeError) || init.signal?.aborted) throw error;
      throw new Error(
        `Could not reach ${new URL(url).host}. In a browser the server must send CORS headers; the desktop app does not need them.`,
        { cause: error },
      );
    }
  });
}
