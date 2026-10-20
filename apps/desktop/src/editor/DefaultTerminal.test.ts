// @effect-diagnostics nodeBuiltinImport:off -- Executes generated quoting in a real shell, never a GUI.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeChildProcess from "node:child_process";
import { beforeEach, expect, vi } from "vite-plus/test";
import { resolveDefaultTerminal, terminalInvocation } from "./DefaultTerminal.ts";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), query: vi.fn() }));
vi.mock("@t3tools/shared/shell", () => ({
  resolveCommandPath: (...args: unknown[]) => Effect.sync(() => mocks.resolve(...args)),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: (...args: unknown[]) => mocks.query(...args),
}));

beforeEach(() => {
  mocks.resolve
    .mockReset()
    .mockImplementation((command: string) =>
      command.startsWith("/") ? command : `/tools/${command}`,
    );
  mocks.query
    .mockReset()
    .mockImplementation((_command, _args, _options, callback) =>
      callback(null, "com.example.Terminal.desktop\n", ""),
    );
});

function detect(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux") {
  return resolveDefaultTerminal.pipe(
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.HomeDirectory, "/nonexistent-t3-test-home"),
    Effect.provideService(HostProcess.Environment, {
      PATH: "/tools",
      XDG_CONFIG_DIRS: "/nonexistent-t3-config",
      XDG_DATA_DIRS: "/nonexistent-t3-data",
      ...env,
    }),
    Effect.provide(NodeServices.layer),
  );
}

describe("default terminal selection", () => {
  it.effect("uses an explicit executable including spaces, without shell splitting", () =>
    Effect.gen(function* () {
      expect(yield* detect({ TERMINAL: "/my tools/kitty" })).toEqual({
        command: "/my tools/kitty",
        kind: "kitty",
      });
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.resolve).toHaveBeenCalledWith("/my tools/kitty", expect.anything());
    }),
  );

  it.effect.each(["kitty --hold", "kitty;touch bad", "$(kitty)", "sh", "-kitty"])(
    "rejects unsupported or shell-valued TERMINAL=%s instead of guessing",
    (TERMINAL) =>
      Effect.gen(function* () {
        expect(yield* detect({ TERMINAL })).toBeNull();
        expect(mocks.query).not.toHaveBeenCalled();
        expect(mocks.resolve).not.toHaveBeenCalled();
      }),
  );

  it.effect("never treats TERM or TERM_PROGRAM as the default executable", () =>
    Effect.gen(function* () {
      mocks.resolve.mockReturnValue(null);
      expect(yield* detect({ TERM: "xterm-kitty", TERM_PROGRAM: "kitty" })).toBeNull();
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith("xdg-terminal-exec", expect.anything());
    }),
  );

  it.effect.each(["xdg-terminals.list", "kde-xdg-terminals.list"])(
    "delegates desktop-entry parsing only for an explicitly configured default in %s",
    (name) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          yield* fs.writeFileString(
            `${dir}/${name}`,
            "# preferred terminal\ncom.example.Terminal.desktop\n",
          );
          expect(yield* detect({ XDG_CONFIG_HOME: dir, XDG_CURRENT_DESKTOP: "KDE" })).toEqual({
            command: "/tools/xdg-terminal-exec",
            kind: "xdg",
          });
          expect(mocks.query).toHaveBeenCalledWith(
            "/tools/xdg-terminal-exec",
            ["--print-id"],
            expect.objectContaining({ timeout: 3000, maxBuffer: 65536 }),
            expect.any(Function),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects xdg-terminal-exec's arbitrary installed-terminal fallback", () =>
    Effect.gen(function* () {
      expect(yield* detect({ XDG_CONFIG_HOME: "/nonexistent-t3-config" })).toBeNull();
    }),
  );

  it.effect.each(["kitty.desktop\nunexpected", "$(touch bad).desktop", "../kitty.desktop"])(
    "rejects invalid desktop IDs from a discovery helper: %j",
    (output) =>
      Effect.gen(function* () {
        mocks.query.mockImplementation((_command, _args, _options, callback) =>
          callback(null, output, ""),
        );
        expect(yield* detect({})).toBeNull();
      }),
  );

  it.effect("fails closed when the native discovery process fails", () =>
    Effect.gen(function* () {
      mocks.query.mockImplementation((_command, _args, _options, callback) =>
        callback(new Error("query failed"), "", ""),
      );
      expect(yield* detect({}, "darwin")).toBeNull();
      expect(yield* detect({})).toBeNull();
    }),
  );

  it.effect("accepts an explicit distro default from XDG_DATA_DIRS, including an action", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${dir}/xdg-terminal-exec`);
        yield* fs.writeFileString(
          `${dir}/xdg-terminal-exec/xdg-terminals.list`,
          "kitty.desktop:new-window\n",
        );
        mocks.query.mockImplementation((_command, _args, _options, callback) =>
          callback(null, "kitty.desktop:new-window\n", ""),
        );
        expect(yield* detect({ XDG_DATA_DIRS: dir })).toMatchObject({ kind: "xdg" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    {
      app: "/System/Applications/Utilities/Terminal.app",
      kind: "Terminal",
      command: "/System/Applications/Utilities/Terminal.app",
    },
    { app: "/Applications/iTerm.app", kind: "iTerm", command: "/Applications/iTerm.app" },
    {
      app: "/Applications/kitty.app",
      kind: "kitty",
      command: "/Applications/kitty.app/Contents/MacOS/kitty",
    },
    {
      app: "/Applications/Ghostty.app",
      kind: "ghostty",
      command: "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    },
    {
      app: "/Applications/Alacritty.app",
      kind: "alacritty",
      command: "/Applications/Alacritty.app/Contents/MacOS/alacritty",
    },
    {
      app: "/Applications/WezTerm.app",
      kind: "wezterm",
      command: "/Applications/WezTerm.app/Contents/MacOS/wezterm",
    },
  ] as const)("queries the native .command association for $app", ({ app, kind, command }) =>
    Effect.gen(function* () {
      mocks.query.mockImplementation((_command, _args, _options, callback) =>
        callback(null, app, ""),
      );
      expect(yield* detect({}, "darwin")).toEqual({ kind, command });
      const [executable, args] = mocks.query.mock.calls[0]!;
      expect(executable).toBe("/usr/bin/osascript");
      expect(args[3]).toContain("URLForApplicationToOpenURL");
      expect(args[4]).toMatch(/\/terminal\.command$/);
    }),
  );

  it.effect.each(["/Applications/Unknown.app", "", "not/an/absolute.app"])(
    "fails closed for an unsupported or missing macOS association %j",
    (app) =>
      Effect.gen(function* () {
        mocks.query.mockImplementation((_command, _args, _options, callback) =>
          callback(null, app, ""),
        );
        expect(yield* detect({}, "darwin")).toBeNull();
        expect(mocks.resolve).not.toHaveBeenCalled();
      }),
  );

  it.effect("does not query native apps on Windows", () =>
    Effect.gen(function* () {
      expect(yield* detect({ TERMINAL: "kitty" }, "win32")).toBeNull();
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }),
  );
});

describe("terminal argv adapters", () => {
  const cwd = "/work/.worktrees/branch '$(touch INJECTED)'";
  const argv = ["/tools/nvim", "+call cursor(12,7)", "--", `${cwd}/file ;&.ts`];
  it.each([
    ["xdg", [`--title=Neovim`, `--dir=${cwd}`, "--", ...argv]],
    ["kitty", ["--title", "Neovim", "--directory", cwd, "--", ...argv]],
    ["ghostty", [`--working-directory=${cwd}`, "-e", ...argv]],
    ["wezterm", ["start", "--cwd", cwd, "--", ...argv]],
    ["alacritty", ["--working-directory", cwd, "-e", ...argv]],
    ["gnome-terminal", [`--working-directory=${cwd}`, "--", ...argv]],
    ["konsole", ["--workdir", cwd, "-e", ...argv]],
    ["foot", ["--working-directory", cwd, "--", ...argv]],
    ["xterm", ["-e", ...argv]],
  ] as const)("preserves argv and worktree paths with %s", (kind, expected) => {
    expect(terminalInvocation({ command: `/tools/${kind}`, kind }, argv, cwd)).toEqual({
      command: `/tools/${kind}`,
      args: expected,
      ...(kind === "xterm" ? { cwd } : {}),
    });
  });

  it.each(["Terminal", "iTerm"] as const)(
    "round-trips hostile literal arguments through %s's command-string boundary",
    (kind) => {
      const values = ["it's a $(echo INJECTED) file", 'a "quoted" ;& file', "`echo INJECTED`"];
      const invocation = terminalInvocation(
        { command: `/Applications/${kind}.app`, kind },
        ["/usr/bin/printf", "%s\\n", ...values],
        "/tmp",
      );
      expect(invocation.command).toBe("/usr/bin/osascript");
      expect(invocation.args.at(-2)).toBe(`/Applications/${kind}.app`);
      const output = NodeChildProcess.execFileSync("/bin/sh", ["-c", invocation.args.at(-1)!], {
        encoding: "utf8",
      });
      expect(output).toBe(values.join("\n") + "\n");
      expect(invocation.args[3]).toContain(
        kind === "Terminal" ? "doScript" : "createWindowWithDefaultProfile",
      );
    },
  );
});
