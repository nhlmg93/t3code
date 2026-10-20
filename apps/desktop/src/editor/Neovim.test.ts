// @effect-diagnostics nodeBuiltinImport:off -- The injection test executes the generated SSH command in real shells; GUI spawns are mocked.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import { describe, it } from "@effect/vitest";
import { beforeEach, expect, vi } from "vite-plus/test";
import { openNeovim, probeNeovim } from "../ipc/methods/desktopEditor.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}));
vi.mock("@t3tools/shared/shell", () => ({
  resolveCommandPath: (...args: unknown[]) => Effect.sync(() => mocks.resolve(...args)),
}));

beforeEach(() => {
  mocks.resolve
    .mockReset()
    .mockImplementation((command: string) =>
      command === "kitty" || command === "nvim" || command === "ssh" ? `/tools/${command}` : null,
    );
  mocks.execFile
    .mockReset()
    .mockImplementation((_command, _args, _options, callback) =>
      callback(null, "/Applications/kitty.app\n", ""),
    );
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new NodeEvents.EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});

const withEnvironment = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
    Effect.provideService(HostProcess.Environment, { PATH: "/tools", TERMINAL: "kitty" }),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  );

describe("Neovim desktop IPC", () => {
  it.effect("opens a local directory with its cwd and no shell, then detaches the GUI", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        expect(yield* openNeovim.handler({ targetPath: dir })).toBeNull();
        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
          "/tools/kitty",
          ["--title", "Neovim", "--directory", dir, "--", "/tools/nvim", "--", "."],
          {
            env: { PATH: "/tools", TERMINAL: "kitty" },
            detached: true,
            stdio: "ignore",
            shell: false,
          },
        );
        expect(mocks.spawn.mock.results[0]!.value.unref).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("passes literal file paths and numeric cursor positions as separate arguments", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = `${dir}/file '$(echo injected);.ts`;
        yield* fs.writeFileString(file, "");
        expect(yield* openNeovim.handler({ targetPath: `${file}:12:7` })).toBeNull();
        expect(mocks.spawn.mock.calls[0]![1]).toEqual([
          "--title",
          "Neovim",
          "--directory",
          dir,
          "--",
          "/tools/nvim",
          "+call cursor(12,7)",
          "--",
          file,
        ]);
      }),
    ),
  );

  it.effect("opens the exact local worktree without redirecting to the repository root", () =>
    withEnvironment(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repo = yield* fs.makeTempDirectoryScoped();
        const worktree = `${repo}/.worktrees/feature branch`;
        yield* fs.makeDirectory(worktree, { recursive: true });
        expect(yield* openNeovim.handler({ targetPath: worktree })).toBeNull();
        expect(mocks.spawn.mock.calls[0]![1]).toEqual([
          "--title",
          "Neovim",
          "--directory",
          worktree,
          "--",
          "/tools/nvim",
          "--",
          ".",
        ]);
      }),
    ),
  );

  it.effect("never stats remote paths locally and starts SSH in the client terminal", () =>
    Effect.gen(function* () {
      expect(
        yield* withEnvironment(
          openNeovim.handler({
            targetPath: "/not-on-this-client/repo",
            sshHost: "user@workstation.tailnet.ts.net",
          }),
        ),
      ).toBeNull();
      const args = mocks.spawn.mock.calls[0]![1] as string[];
      expect(args.slice(0, 6)).toEqual([
        "--title",
        "Neovim",
        "--",
        "/bin/sh",
        "-c",
        '"$@"; status=$?; printf "\\nSSH exited (%s). Press Enter to close. " "$status"; read -r answer',
      ]);
      expect(args.slice(6, 11)).toEqual([
        "t3-neovim",
        "/tools/ssh",
        "-t",
        "--",
        "user@workstation.tailnet.ts.net",
      ]);
      expect(mocks.spawn.mock.calls[0]![2]).not.toHaveProperty("cwd");
    }),
  );

  it.effect.each(["file", "directory"])(
    "round-trips hostile remote %s paths through both real shell boundaries without execution",
    (kind) =>
      withEnvironment(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped();
          const bin = `${dir}/bin`;
          yield* fs.makeDirectory(bin);
          const file = `${dir}/it's a "file"; $(touch INJECTED) & \`touch INJECTED\`.ts`;
          if (kind === "directory") yield* fs.makeDirectory(file);
          else yield* fs.writeFileString(file, "");
          yield* fs.writeFileString(`${bin}/nvim`, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n');
          yield* fs.chmod(`${bin}/nvim`, 0o755);
          expect(
            yield* openNeovim.handler({
              targetPath: kind === "directory" ? file : `${file}:9:3`,
              sshHost: "workstation",
            }),
          ).toBeNull();
          const command = (mocks.spawn.mock.calls[0]![1] as string[]).at(-1)!;
          const result = NodeChildProcess.execFileSync("/bin/sh", ["-c", command], {
            cwd: dir,
            env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` },
            encoding: "utf8",
          });
          expect(result.split("\n")).toEqual(
            kind === "directory"
              ? [file, "--", ".", ""]
              : [dir, "+call cursor(9,3)", "--", file, ""],
          );
          expect(yield* fs.exists(`${dir}/INJECTED`)).toBe(false);
        }),
      ),
  );

  it.effect.each([
    "-oProxyCommand=bad",
    "host;touch x",
    "host\nbad",
    "host bad",
    "ssh://host",
    "host:22",
    "user@-option",
    "$(bad)",
    "host/command",
    "",
  ])("rejects unsafe host %j before spawning", (sshHost) =>
    Effect.gen(function* () {
      expect(yield* withEnvironment(openNeovim.handler({ targetPath: "/repo", sshHost }))).toMatch(
        /Invalid SSH host/,
      );
      expect(mocks.spawn).not.toHaveBeenCalled();
    }),
  );

  it.effect.each(["relative/repo", "-option", "/repo\nbad", "/repo\0bad"])(
    "rejects unsafe path %j",
    (targetPath) =>
      Effect.gen(function* () {
        expect(
          yield* withEnvironment(openNeovim.handler({ targetPath, sshHost: "workstation" })),
        ).toMatch(/absolute POSIX path/);
        expect(mocks.spawn).not.toHaveBeenCalled();
      }),
  );

  it.effect("decodes IPC payloads before touching processes", () =>
    Effect.gen(function* () {
      const failure = yield* withEnvironment(
        openNeovim.handler({ targetPath: "/repo", sshHost: ["-oBad"] }).pipe(Effect.exit),
      );
      expect(failure._tag).toBe("Failure");
      expect(mocks.spawn).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    {
      platform: "linux",
      kitty: "/test-home/.local/bin/kitty",
      nvim: "/test-home/.local/share/mise/installs/neovim/latest/bin/nvim",
    },
    {
      platform: "darwin",
      kitty: "/Applications/kitty.app/Contents/MacOS/kitty",
      nvim: "/opt/homebrew/bin/nvim",
    },
  ] as const)(
    "discovers $platform installs even with a sparse graphical-session PATH",
    ({ platform, kitty, nvim }) =>
      Effect.gen(function* () {
        mocks.resolve.mockImplementation((command: string) =>
          command === "kitty"
            ? kitty
            : [kitty, nvim, "/usr/bin/ssh"].includes(command)
              ? command
              : null,
        );
        expect(
          yield* withEnvironment(
            probeNeovim
              .handler(undefined)
              .pipe(Effect.provideService(HostProcess.Platform, platform)),
          ),
        ).toEqual({ local: true, remote: true });
      }),
  );

  it.effect("offers remote mode without local Neovim and hides the extension on Windows", () =>
    Effect.gen(function* () {
      mocks.resolve.mockImplementation((command: string) =>
        command === "kitty" || command === "ssh" ? `/tools/${command}` : null,
      );
      expect(yield* withEnvironment(probeNeovim.handler(undefined))).toEqual({
        local: false,
        remote: true,
      });
      expect(
        yield* withEnvironment(
          probeNeovim.handler(undefined).pipe(Effect.provideService(HostProcess.Platform, "win32")),
        ),
      ).toEqual({ local: false, remote: false });
    }),
  );

  it.effect("reports missing tools and spawn failure without returning raw exception text", () =>
    Effect.gen(function* () {
      mocks.resolve.mockReturnValue(null);
      expect(yield* withEnvironment(openNeovim.handler({ targetPath: "/repo" }))).toMatch(
        /supported default terminal/,
      );
      mocks.resolve.mockImplementation((command: string) => `/tools/${command}`);
      mocks.spawn.mockImplementation(() => {
        const child = new NodeEvents.EventEmitter();
        queueMicrotask(() => child.emit("error", new Error("secret output")));
        return child;
      });
      expect(
        yield* withEnvironment(openNeovim.handler({ targetPath: "/repo", sshHost: "workstation" })),
      ).toBe("Could not start the default terminal on this desktop.");
    }),
  );

  it.effect.each(["Terminal", "iTerm"])(
    "reports %s Automation failures instead of claiming the terminal opened",
    (app) =>
      Effect.gen(function* () {
        mocks.execFile.mockImplementation((_command, args, _options, callback) => {
          if (args[3].includes("URLForApplicationToOpenURL")) {
            callback(null, `/Applications/${app}.app\n`, "");
          } else {
            callback(new Error("secret Automation error"), "", "");
          }
        });
        expect(
          yield* withEnvironment(
            openNeovim
              .handler({ targetPath: "/remote/.worktrees/branch", sshHost: "workstation" })
              .pipe(Effect.provideService(HostProcess.Platform, "darwin")),
          ),
        ).toBe("Could not start the default terminal on this desktop.");
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(mocks.execFile).toHaveBeenCalledTimes(2);
      }),
  );
});
