import type {
  DesktopBridge,
  EditorId,
  EnvironmentId,
  NeovimAvailability,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { useRemoteCapableEditors, useRemoteOpenResolution } from "./remoteOpen";
import type { ClientEditorId } from "./clientEditor";

const UNAVAILABLE: NeovimAvailability = { local: false, remote: false };
type NeovimProbe = {
  availability: NeovimAvailability | null;
  promise: Promise<NeovimAvailability>;
};
const probes = new WeakMap<NonNullable<DesktopBridge["neovim"]>, NeovimProbe>();

function useNeovimAvailability() {
  // null means detection is pending, not evidence that Neovim is unavailable.
  const [available, setAvailable] = useState<NeovimAvailability | null>(() => {
    const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.neovim;
    return bridge === undefined ? UNAVAILABLE : (probes.get(bridge)?.availability ?? null);
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = window.desktopBridge?.neovim;
    if (bridge === undefined) return;
    let probe = probes.get(bridge);
    if (probe === undefined) {
      const entry: NeovimProbe = {
        availability: null,
        promise: Promise.resolve()
          .then(() => bridge.probe())
          .catch(() => UNAVAILABLE)
          .then((value) => {
            entry.availability = value;
            return value;
          }),
      };
      probe = entry;
      probes.set(bridge, probe);
    }
    let cancelled = false;
    void probe.promise.then((value) => {
      if (!cancelled) setAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

/** Combine server editors with capabilities of the viewing desktop only. */
export function useEditorAvailability(
  environmentId: EnvironmentId | null,
  serverEditors: readonly EditorId[],
) {
  const { state: remote, isResolved: isRouteResolved } = useRemoteOpenResolution(environmentId);
  const clientEditors = useRemoteCapableEditors(isRouteResolved && remote.mode === "remote-links");
  const neovim = useNeovimAvailability();
  const isResolved = isRouteResolved && neovim !== null;
  const editors = useMemo<readonly ClientEditorId[]>(() => {
    // A not-yet-loaded catalog is not evidence that a path is client-local.
    if (!isResolved || neovim === null || remote.mode === "remote-unavailable") return [];
    const base = remote.mode === "local-exec" ? serverEditors : clientEditors;
    const available = remote.mode === "local-exec" ? neovim.local : neovim.remote;
    return available ? ["neovim", ...base] : base;
  }, [isResolved, remote.mode, serverEditors, clientEditors, neovim]);
  return { editors, remote, isResolved };
}
