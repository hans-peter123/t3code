import { DesktopNetbirdConfigureInputSchema, DesktopNetbirdStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopNetbird from "../../netbird/DesktopNetbird.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getNetbirdState = makeIpcMethod({
  channel: IpcChannels.NETBIRD_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopNetbirdStateSchema,
  handler: Effect.fn("desktop.ipc.netbird.getState")(function* () {
    return yield* (yield* DesktopNetbird.DesktopNetbird).state;
  }),
});

export const configureNetbird = makeIpcMethod({
  channel: IpcChannels.NETBIRD_CONFIGURE_CHANNEL,
  payload: DesktopNetbirdConfigureInputSchema,
  result: DesktopNetbirdStateSchema,
  handler: Effect.fn("desktop.ipc.netbird.configure")(function* (input) {
    return yield* (yield* DesktopNetbird.DesktopNetbird).configure(input);
  }),
});
