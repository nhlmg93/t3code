import { EDITORS, EditorId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Renderer preference/desktop IPC only, not an environment RPC EditorId.
export const ClientEditorId = Schema.Union([EditorId, Schema.Literal("neovim")]);
export type ClientEditorId = typeof ClientEditorId.Type;
export const CLIENT_EDITORS = [{ id: "neovim", label: "Neovim" }, ...EDITORS] as const;
