import { NeovimAvailability, OpenNeovimInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Neovim from "../../editor/Neovim.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const probeNeovim = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROBE_NEOVIM_CHANNEL,
  payload: Schema.Undefined,
  result: NeovimAvailability,
  handler: () => Neovim.probe,
});

export const openNeovim = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_NEOVIM_CHANNEL,
  payload: OpenNeovimInput,
  result: Schema.NullOr(Schema.String),
  handler: Neovim.open,
});
