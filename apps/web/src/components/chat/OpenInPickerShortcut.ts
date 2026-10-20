import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const openPreferred = useOpenInPreferredEditor(environmentId, availableEditors);

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!isOpenFavoriteEditorShortcut(event, keybindings)) return;
      if (!openInCwd) return;

      event.preventDefault();
      void openPreferred(openInCwd).then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({
            type: "error",
            title: "Could not open preferred editor",
            description: String(squashAtomCommandFailure(result)),
          });
        }
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybindings, openInCwd, openPreferred]);
}
