import { CLIENT_EDITORS, type ClientEditorId } from "./clientEditor";

import { getLocalFileManagerName } from "~/lib/utils";

const editorLabels = new Map<ClientEditorId, string>(
  CLIENT_EDITORS.map((editor) => [editor.id, editor.label]),
);

export function editorLabelForPlatform(editorId: ClientEditorId, platform: string): string {
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform);
  }

  return editorLabels.get(editorId) ?? "Editor";
}

export function openInEditorMenuLabel(editorId: ClientEditorId | null): string {
  return editorId === null || editorId === "file-manager"
    ? "Open in editor"
    : `Open in ${editorLabels.get(editorId) ?? "Editor"}`;
}
