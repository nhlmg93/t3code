import { EnvironmentId, type NeovimAvailability } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RemoteOpenState } from "./remoteOpen";
import { useEditorAvailability } from "./clientEditors";
import { ClientEditorId } from "./clientEditor";
import { EditorId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

const isClientEditorId = Schema.is(ClientEditorId);
const isWireEditorId = Schema.is(EditorId);

const state = vi.hoisted(() => ({
  remote: { mode: "local-exec" } as RemoteOpenState,
  resolved: true,
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: state.resolved }),
  useRemoteCapableEditors: () => ["vscode"],
}));

let renderer: ReactTestRenderer | undefined;
let result: ReturnType<typeof useEditorAvailability>;
function Consumer() {
  const available = useEditorAvailability(EnvironmentId.make("selected"), ["cursor"]);
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

it("leaves browser and older desktop choices unchanged", async () => {
  await render();
  expect(result.isResolved).toBe(true);
  expect(result.editors).toEqual(["cursor"]);
  state.remote = { mode: "remote-links", host: { kind: "tailscale", host: "workstation" } };
  await render();
  expect(result.editors).toEqual(["vscode"]);
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
  expect(result.editors).toEqual(["neovim", "cursor"]);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await render();
  expect(result.isResolved).toBe(true);
  expect(result.editors).toEqual(["neovim", "cursor"]);
  expect(probe).toHaveBeenCalledOnce();
});

it("adds a probed desktop editor only where it can run and probes once across remounts", async () => {
  const probe = vi.fn().mockResolvedValue({ local: false, remote: true });
  vi.stubGlobal("window", { desktopBridge: { neovim: { probe } } });
  await render();
  expect(result.editors).toEqual(["cursor"]);
  state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "workstation" } };
  await render();
  expect(result.editors).toEqual(["neovim", "vscode"]);
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
  expect(result.editors).toEqual(["neovim", "cursor"]);
});

it("keeps standard editor options when the desktop probe fails", async () => {
  vi.stubGlobal("window", {
    desktopBridge: {
      neovim: {
        probe: vi.fn().mockRejectedValue(new Error("old main process")),
      },
    },
  });
  await render();
  expect(result.editors).toEqual(["cursor"]);
  expect(result.isResolved).toBe(true);
});

it("keeps the extended preference out of the wire EditorId decoder", () => {
  expect(isClientEditorId("neovim")).toBe(true);
  expect(isWireEditorId("neovim")).toBe(false);
});
