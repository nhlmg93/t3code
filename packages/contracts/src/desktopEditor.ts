import * as Schema from "effect/Schema";

// Desktop IPC only. Do not add this editor to EditorId/ServerConfig: installed
// mobile clients can have a strict, older decoder for those wire values.
export const NeovimAvailability = Schema.Struct({
  local: Schema.Boolean,
  remote: Schema.Boolean,
});
export type NeovimAvailability = typeof NeovimAvailability.Type;

export const OpenNeovimInput = Schema.Struct({
  targetPath: Schema.String,
  /** An SSH config alias or advertised DNS name, never shell/SSH options. */
  sshHost: Schema.optionalKey(Schema.String),
});
export type OpenNeovimInput = typeof OpenNeovimInput.Type;
