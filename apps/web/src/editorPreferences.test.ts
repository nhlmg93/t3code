import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  remote: { mode: "local-exec" } as RemoteOpenState,
  resolved: true,
  editors: null as readonly ClientEditorId[] | null,
  openNeovim: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));
vi.mock("./clientEditors", () => ({
  useEditorAvailability: (_environmentId: string, available: readonly ClientEditorId[]) => ({
    editors: state.editors ?? available,
    remote: state.remote,
    isResolved: state.resolved,
  }),
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: state.remote, isResolved: state.resolved }),
  openRemoteEditorUrl: state.openUrl,
}));

import { useOpenInPreferredEditor, useOpenEditor } from "./editorPreferences";
import type { ClientEditorId } from "./clientEditor";
import type { RemoteOpenState } from "./remoteOpen";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");

beforeEach(() => {
  state.allowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
  state.remote = { mode: "local-exec" };
  state.resolved = true;
  state.editors = null;
  state.openNeovim.mockReset().mockResolvedValue(null);
  state.openUrl.mockReset().mockResolvedValue(true);
  vi.stubGlobal("window", { desktopBridge: { neovim: { open: state.openNeovim } } });
});
afterEach(() => vi.unstubAllGlobals());

it("does not use another environment's grant or change preferences when denied", async () => {
  state.allowed.add(primary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  const result = await open("/work/readme.md");
  assert(result._tag === "Failure");
  const error = Cause.squash(result.cause);
  expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
  expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
  expect(state.run).not.toHaveBeenCalled();
  expect(state.getPreference).not.toHaveBeenCalled();
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("checks revocation and regrant when a retained editor callback is invoked", async () => {
  state.allowed.add(secondary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  state.allowed.delete(secondary);
  expect((await open("/work/readme.md:5"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  state.allowed.add(secondary);
  expect(await open("/work/readme.md:5")).toMatchObject({ _tag: "Success", value: "vscode" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work/readme.md:5", editor: "vscode" },
  });
  expect(state.setPreference).toHaveBeenCalledTimes(1);
});

it("keeps the stored available editor for an authorized launch", async () => {
  state.allowed.add(secondary);
  state.getPreference.mockReturnValue("cursor");
  const open = useOpenInPreferredEditor(secondary, ["vscode", "cursor"]);
  expect(await open("/work")).toMatchObject({ _tag: "Success", value: "cursor" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work", editor: "cursor" },
  });
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("returns a loading error without reading or replacing the saved preference during detection", async () => {
  state.allowed.add(secondary);
  state.resolved = false;
  state.getPreference.mockReturnValue("neovim");
  const result = await useOpenInPreferredEditor(secondary, ["vscode"])("/work/file.ts:5");
  assert(result._tag === "Failure");
  expect(Cause.squash(result.cause)).toMatchObject({
    message: "Editor availability is still loading. Try again in a moment.",
  });
  expect(state.getPreference).not.toHaveBeenCalled();
  expect(state.setPreference).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.openNeovim).not.toHaveBeenCalled();
});

it("retains the existing fallback policy once Neovim is known to be unavailable", async () => {
  state.allowed.add(secondary);
  state.getPreference.mockReturnValue("neovim");
  expect(await useOpenInPreferredEditor(secondary, ["vscode"])("/work")).toMatchObject({
    _tag: "Success",
    value: "vscode",
  });
  expect(state.setPreference).toHaveBeenCalledExactlyOnceWith(
    "t3code:last-editor",
    "vscode",
    expect.anything(),
  );
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work", editor: "vscode" },
  });
});

it("keeps the saved preference when detection finishes with no available fallback", async () => {
  state.allowed.add(secondary);
  state.getPreference.mockReturnValue("neovim");
  const result = await useOpenInPreferredEditor(secondary, [])("/work");
  assert(result._tag === "Failure");
  expect(Cause.squash(result.cause)).toMatchObject({
    _tag: "PreferredEditorUnavailableError",
    availableEditorIds: [],
  });
  expect(state.setPreference).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  expect(state.openNeovim).not.toHaveBeenCalled();
});

it("returns the existing failures for a missing environment or editor", async () => {
  state.allowed.add(secondary);
  expect((await useOpenInPreferredEditor(null, ["vscode"])("/work"))._tag).toBe("Failure");
  expect((await useOpenInPreferredEditor(secondary, [])("/work"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});

it("opens the preferred local Neovim through desktop IPC, never server RPC", async () => {
  state.allowed.add(secondary);
  state.editors = ["neovim", "vscode"];
  state.getPreference.mockReturnValue("neovim");
  expect(await useOpenInPreferredEditor(secondary, ["vscode"])("/work/file.ts:4:2")).toMatchObject({
    _tag: "Success",
    value: "neovim",
  });
  expect(state.openNeovim).toHaveBeenCalledExactlyOnceWith({ targetPath: "/work/file.ts:4:2" });
  expect(state.run).not.toHaveBeenCalled();
});

it("opens remote Neovim on the client using the resolved SSH alias without a host mutation", async () => {
  state.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "my-workstation" } };
  expect(await useOpenEditor(secondary)("neovim", "/remote/checkout")).toMatchObject({
    _tag: "Success",
  });
  expect(state.openNeovim).toHaveBeenCalledExactlyOnceWith({
    targetPath: "/remote/checkout",
    sshHost: "my-workstation",
  });
  expect(state.run).not.toHaveBeenCalled();
  expect(state.openUrl).not.toHaveBeenCalled();
});

it("routes an advertised Tailscale host and preserves non-Neovim remote links", async () => {
  state.remote = {
    mode: "remote-links",
    host: { kind: "tailscale", host: "workstation.tailnet.ts.net" },
  };
  const open = useOpenEditor(secondary);
  await open("neovim", "/remote/checkout");
  expect(state.openNeovim).toHaveBeenCalledWith({
    targetPath: "/remote/checkout",
    sshHost: "workstation.tailnet.ts.net",
  });
  expect(await open("vscode", "/remote/checkout")).toMatchObject({ _tag: "Success" });
  expect(state.openUrl).toHaveBeenCalledWith(
    "vscode://vscode-remote/ssh-remote+workstation.tailnet.ts.net/remote/checkout",
  );
  expect(state.run).not.toHaveBeenCalled();
});

it("fails closed before route resolution and when SSH is unavailable", async () => {
  state.allowed.add(secondary);
  state.resolved = false;
  expect((await useOpenEditor(secondary)("neovim", "/remote/checkout"))._tag).toBe("Failure");
  state.resolved = true;
  state.remote = { mode: "remote-unavailable" };
  expect((await useOpenEditor(secondary)("neovim", "/remote/checkout"))._tag).toBe("Failure");
  expect(state.openNeovim).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
});

it("does not send Neovim to an older desktop/browser/server when IPC is absent or fails", async () => {
  state.allowed.add(secondary);
  vi.stubGlobal("window", {});
  expect((await useOpenEditor(secondary)("neovim", "/work"))._tag).toBe("Failure");
  vi.stubGlobal("window", { desktopBridge: { neovim: { open: state.openNeovim } } });
  state.openNeovim.mockResolvedValue("Could not identify a supported default terminal.");
  const result = await useOpenEditor(secondary)("neovim", "/work");
  assert(result._tag === "Failure");
  expect(Cause.squash(result.cause)).toMatchObject({
    message: "Could not identify a supported default terminal.",
  });
  state.openNeovim.mockRejectedValue(new Error("IPC disconnected"));
  expect((await useOpenEditor(secondary)("neovim", "/work"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});
