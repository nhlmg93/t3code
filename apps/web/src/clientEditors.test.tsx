import { EnvironmentId, type NeovimAvailability } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RemoteOpenState } from "./remoteOpen";
import { useEditorAvailability } from "./clientEditors";
import { ClientEditorId } from "./clientEditor";
import { EditorId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { buildFileContextMenuItems } from "./fileContextMenu";

const isClientEditorId = Schema.is(ClientEditorId);
const isWireEditorId = Schema.is(EditorId);
const detectedEditors = [
  "cursor",
  "vscode",
  "vscode-insiders",
  "zed",
  "vscodium",
  "file-manager",
] as const;

const state = vi.hoisted(() => ({
  remote: { mode: "local-exec" } as RemoteOpenState,
  resolved: true,
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: state.resolved }),
  useRemoteCapableEditors: () => detectedEditors,
}));

let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useEditorAvailability>;
function Consumer() {
  const available = useEditorAvailability(EnvironmentId.make("selected"), detectedEditors);
  useEffect(() => {
    result = available;
  }, [available]);
  return null;
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<Consumer />);
    else renderer = create(<Consumer />);
  });
}
beforeEach(() => {
  state.remote = { mode: "local-exec" };
  state.resolved = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("leaves browser choices unchanged", async () => {
  await render();
  expect(result.isResolved).toBe(true);
  expect(result.editors).toEqual(detectedEditors);
  state.remote = { mode: "remote-links", host: { kind: "tailscale", host: "workstation" } };
  await render();
  expect(result.editors).toEqual(detectedEditors);
  expect(result.isResolved).toBe(true);
});

it("keeps detection pending until the shared desktop probe resolves", async () => {
  let resolveProbe!: (value: NeovimAvailability) => void;
  const probe = vi.fn(
    () =>
      new Promise<NeovimAvailability>((resolve) => {
        resolveProbe = resolve;
      }),
  );
  vi.stubGlobal("window", { desktopBridge: { neovim: { probe } } });
  await render();
  expect(result.isResolved).toBe(false);
  expect(result.editors).toEqual([]);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
  expect(result.isResolved).toBe(false);
  expect(probe).toHaveBeenCalledOnce();

  await act(async () => resolveProbe({ local: true, remote: true }));
  expect(result.isResolved).toBe(true);
  expect(result.editors).toEqual(["neovim", "zed", "vscodium", "file-manager"]);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
  expect(result.isResolved).toBe(true);
  expect(result.editors).toEqual(["neovim", "zed", "vscodium", "file-manager"]);
  expect(probe).toHaveBeenCalledOnce();
});

it("adds a probed desktop editor only where it can run and probes once across remounts", async () => {
  const probe = vi.fn().mockResolvedValue({ local: false, remote: true });
  vi.stubGlobal("window", { desktopBridge: { neovim: { probe } } });
  await render();
  expect(result.editors).toEqual(["zed", "vscodium", "file-manager"]);
  state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "workstation" } };
  await render();
  expect(result.editors).toEqual(["neovim", "zed", "vscodium", "file-manager"]);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
  expect(probe).toHaveBeenCalledOnce();
  expect(result.editors).toContain("neovim");
  state.remote = { mode: "remote-unavailable" };
  await render();
  expect(result.editors).toEqual([]);
});

it("does not mistake unresolved remote metadata for a local checkout", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      neovim: {
        probe: vi.fn().mockResolvedValue({ local: true, remote: true }),
      },
    },
  });
  state.resolved = false;
  await render();
  expect(result.editors).toEqual([]);
  state.resolved = true;
  await render();
  expect(result.editors).toEqual(["neovim", "zed", "vscodium", "file-manager"]);
});

it("keeps only allowed editor options when the desktop probe fails", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      neovim: {
        probe: vi.fn().mockRejectedValue(new Error("old main process")),
      },
    },
  });
  await render();
  expect(result.editors).toEqual(["zed", "vscodium", "file-manager"]);
  expect(result.isResolved).toBe(true);
});

it.each(["local-exec", "remote-links"] as const)(
  "hides desktop editors from the %s file menu even without Neovim IPC",
  async (mode) => {
    vi.stubGlobal("window", { desktopBridge: {} });
    state.remote =
      mode === "local-exec" ? { mode } : { mode, host: { kind: "ssh-alias", host: "workstation" } };
    await render();
    expect(result.editors).toEqual(["zed", "vscodium", "file-manager"]);
    expect(
      buildFileContextMenuItems({
        hasAbsolutePath: true,
        capabilities: {
          revealLabel: undefined,
          canOpenDefault: true,
          editorIds: result.editors,
        },
      }),
    ).toEqual([
      { id: "open", label: "Open", icon: "pencil" },
      {
        id: "open-with",
        label: "Open with",
        children: [
          { id: "editor:zed", label: "Zed" },
          { id: "editor:vscodium", label: "VSCodium" },
        ],
      },
    ]);
  },
);

it("keeps the extended preference out of the wire EditorId decoder", () => {
  expect(isClientEditorId("neovim")).toBe(true);
  expect(isWireEditorId("neovim")).toBe(false);
});
