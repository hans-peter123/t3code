import { net } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const SpeechRequestSchema = Schema.Struct({
  url: Schema.String,
  method: Schema.Literals(["GET", "POST"]),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.NullOr(Schema.Uint8Array),
});

const SpeechResponseSchema = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.Uint8Array,
});

/**
 * Sends a voice provider request from the main process. Self-hosted speech servers often have no
 * CORS headers, which the renderer would need; the user configured these URLs in Settings > Voice.
 */
export const speechRequest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEECH_REQUEST_CHANNEL,
  payload: SpeechRequestSchema,
  result: SpeechResponseSchema,
  handler: Effect.fn("desktop.ipc.speech.request")(function* (request) {
    const protocol = new URL(request.url).protocol;
    if (protocol !== "https:" && protocol !== "http:") {
      return yield* Effect.die(new Error(`Unsupported voice provider URL: ${request.url}`));
    }
    return yield* Effect.promise(async () => {
      const response = await net.fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body ? { body: request.body as Uint8Array<ArrayBuffer> } : {}),
      });
      return {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body: new Uint8Array(await response.arrayBuffer()),
      };
    });
  }),
});
