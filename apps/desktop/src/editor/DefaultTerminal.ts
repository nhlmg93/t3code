// @effect-diagnostics nodeBuiltinImport:off -- Native desktop discovery uses bounded, shell-free queries.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const query = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          command,
          args,
          { env, timeout: 3000, maxBuffer: 64 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
        );
      }),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));

type TerminalKind =
  | "xdg"
  | "kitty"
  | "ghostty"
  | "alacritty"
  | "wezterm"
  | "gnome-terminal"
  | "konsole"
  | "foot"
  | "xterm"
  | "Terminal"
  | "iTerm";

const commandKinds = new Set<TerminalKind>([
  "kitty",
  "ghostty",
  "alacritty",
  "wezterm",
  "gnome-terminal",
  "konsole",
  "foot",
  "xterm",
]);

export type DefaultTerminal = { command: string; kind: TerminalKind };

/** Never infer an executable from TERM/TERM_PROGRAM or scan installed terminals. */
export const resolveDefaultTerminal = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (platform !== "linux" && platform !== "darwin") return null;

  if (platform === "linux") {
    // TERMINAL is an explicit user override, but only a single executable, not
    // a shell fragment. Absolute paths may contain spaces; never split them.
    if (env.TERMINAL) {
      const name = path.basename(env.TERMINAL) as TerminalKind;
      if (!commandKinds.has(name)) return null;
      const command = yield* resolveCommandPath(env.TERMINAL, { env });
      return command === null ? null : { command, kind: name };
    }
    const command = yield* resolveCommandPath("xdg-terminal-exec", { env });
    if (command === null) return null;
    const selected = yield* query(command, ["--print-id"], env);
    if (!selected || !/^[A-Za-z0-9_.-]+\.desktop(?::[A-Za-z0-9_.-]+)?$/.test(selected)) return null;

    // xdg-terminal-exec also scans arbitrary installed apps when no preference
    // applies. Require its selection to be explicitly configured, not guessed.
    const desktops = (env.XDG_CURRENT_DESKTOP ?? "")
      .split(":")
      .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
      .map((name) => `${name.toLowerCase()}-xdg-terminals.list`);
    const names = [...desktops, "xdg-terminals.list"];
    const dirs = [
      env.XDG_CONFIG_HOME || path.join(home, ".config"),
      ...(env.XDG_CONFIG_DIRS || "/etc/xdg").split(":"),
      ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
        .split(":")
        .map((dir) => path.join(dir, "xdg-terminal-exec")),
    ].filter((dir) => path.isAbsolute(dir));
    for (const dir of dirs) {
      for (const name of names) {
        const contents = yield* fs
          .readFileString(path.join(dir, name))
          .pipe(Effect.orElseSucceed(() => ""));
        if (contents.split(/\r?\n/).some((line) => line.trim() === selected)) {
          return { command, kind: "xdg" as const };
        }
      }
    }
    return null;
  }

  // LaunchServices' file association is the macOS default for executable
  // .command documents. A real empty file avoids guessing a nonexistent URL's
  // content type. NSWorkspace is public API; ssh:// is NOT this association.
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "terminal.command");
      yield* fs.writeFileString(file, "#!/bin/sh\n");
      const app = yield* query(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import('AppKit');
function run(argv) {
  const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(argv[0]));
  return app.isNil() ? '' : ObjC.unwrap(app.path);
}`,
          file,
        ],
        env,
      );
      if (!app || !path.isAbsolute(app)) return null;
      const name = path.basename(app);
      if (name === "Terminal.app") return { command: app, kind: "Terminal" as const };
      if (name === "iTerm.app" || name === "iTerm2.app")
        return { command: app, kind: "iTerm" as const };
      const executables: Record<string, string> = {
        "kitty.app": "kitty",
        "Ghostty.app": "ghostty",
        "Alacritty.app": "alacritty",
        "WezTerm.app": "wezterm",
      };
      const executable = executables[name];
      if (!executable) return null;
      const command = yield* resolveCommandPath(path.join(app, "Contents/MacOS", executable), {
        env,
      });
      return command === null ? null : { command, kind: executable as TerminalKind };
    }),
  ).pipe(Effect.orElseSucceed(() => null));
});

export const quoteShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Adapters accept argv, never a user-supplied command string. */
export function terminalInvocation(terminal: DefaultTerminal, argv: string[], cwd?: string) {
  const dir = cwd === undefined ? [] : [cwd];
  switch (terminal.kind) {
    case "xdg":
      return {
        command: terminal.command,
        args: ["--title=Neovim", ...(cwd ? [`--dir=${cwd}`] : []), "--", ...argv],
      };
    case "kitty":
      return {
        command: terminal.command,
        args: ["--title", "Neovim", ...(cwd ? ["--directory", ...dir] : []), "--", ...argv],
      };
    case "ghostty":
      return {
        command: terminal.command,
        args: [...(cwd ? [`--working-directory=${cwd}`] : []), "-e", ...argv],
      };
    case "wezterm":
      return {
        command: terminal.command,
        args: ["start", ...(cwd ? ["--cwd", ...dir] : []), "--", ...argv],
      };
    case "alacritty":
      return {
        command: terminal.command,
        args: [...(cwd ? ["--working-directory", ...dir] : []), "-e", ...argv],
      };
    case "gnome-terminal":
      return {
        command: terminal.command,
        args: [...(cwd ? [`--working-directory=${cwd}`] : []), "--", ...argv],
      };
    case "konsole":
      return {
        command: terminal.command,
        args: [...(cwd ? ["--workdir", ...dir] : []), "-e", ...argv],
      };
    case "foot":
      return {
        command: terminal.command,
        args: [...(cwd ? ["--working-directory", ...dir] : []), "--", ...argv],
      };
    case "xterm":
      return { command: terminal.command, args: ["-e", ...argv], ...(cwd ? { cwd } : {}) };
    case "Terminal":
    case "iTerm": {
      // These apps expose command execution via scripting, not CLI argv.
      // Only generated POSIX code crosses the user's login-shell boundary.
      const script = `${cwd ? `cd ${quoteShellArgument(cwd)} && ` : ""}exec ${argv.map(quoteShellArgument).join(" ")}`;
      const command = `/bin/sh -c ${quoteShellArgument(script)}`;
      return {
        command: "/usr/bin/osascript",
        args: [
          "-l",
          "JavaScript",
          "-e",
          terminal.kind === "Terminal"
            ? "function run(argv) { const app = Application(argv[0]); app.doScript(argv[1]); app.activate(); }"
            : "function run(argv) { const app = Application(argv[0]); app.createWindowWithDefaultProfile({command: argv[1]}); app.activate(); }",
          terminal.command,
          command,
        ],
      };
    }
  }
}
