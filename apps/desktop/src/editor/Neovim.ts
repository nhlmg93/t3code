// @effect-diagnostics nodeBuiltinImport:off -- The terminal is an intentionally detached GUI process, not a scoped server subprocess.
import * as NodeChildProcess from "node:child_process";
import type { OpenNeovimInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  quoteShellArgument as quote,
  resolveDefaultTerminal,
  terminalInvocation,
} from "./DefaultTerminal.ts";

class NeovimError extends Schema.TaggedError<NeovimError>()("NeovimError", {
  reason: Schema.Literals(["unsupported", "target", "host", "terminal", "nvim", "ssh", "spawn"]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Neovim requires a Linux or macOS desktop.";
      case "target":
        return "Neovim requires an existing absolute POSIX path (optionally :line:column).";
      case "host":
        return "Invalid SSH host. Use an SSH config alias or DNS name, without options or a port.";
      case "terminal":
        return "Could not identify a supported default terminal. Configure xdg-terminal-exec or TERMINAL on Linux, or the .command file association on macOS; see the remote-access guide.";
      case "nvim":
        return "Neovim was not found on this desktop. Install it with mise or Homebrew.";
      case "ssh":
        return "SSH was not found on this desktop.";
      case "spawn":
        return "Could not start the default terminal on this desktop.";
    }
  }
}

const resolveTools = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  if (platform !== "linux" && platform !== "darwin") return null;

  const find = Effect.fn(function* (candidates: readonly string[]) {
    for (const candidate of candidates) {
      const resolved = yield* resolveCommandPath(candidate, { env });
      if (resolved !== null) return resolved;
    }
    return null;
  });
  const terminal = yield* resolveDefaultTerminal;
  const nvim = yield* find([
    "nvim",
    path.join(home, ".local/share/mise/installs/neovim/latest/bin/nvim"),
    path.join(home, ".local/share/mise/shims/nvim"),
    "/opt/homebrew/bin/nvim",
    "/usr/local/bin/nvim",
    "/usr/bin/nvim",
  ]);
  const ssh = yield* find(["ssh", "/usr/bin/ssh"]);
  return { terminal, nvim, ssh, env };
});

export const probe = resolveTools.pipe(
  Effect.map((tools) => ({
    local: tools?.terminal != null && tools.nvim !== null,
    remote: tools?.terminal != null && tools.ssh !== null,
  })),
);

// SSH joins command arguments into one string for the remote login shell.
// Quote at BOTH shell boundaries; an argv array alone is not safe there.
const safeHost = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const launch = Effect.fn("desktop.editor.Neovim.launch")(function* (input: OpenNeovimInput) {
  const { path: target, line, column } = splitFilePathPosition(input.targetPath);
  const hasControlCharacters = Array.from(target).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    !target.startsWith("/") ||
    hasControlCharacters ||
    (line !== undefined && !Number.isSafeInteger(line)) ||
    (column !== undefined && !Number.isSafeInteger(column))
  ) {
    return yield* new NeovimError({ reason: "target" });
  }
  if (
    input.sshHost !== undefined &&
    (input.sshHost.length > 255 || !safeHost.test(input.sshHost))
  ) {
    return yield* new NeovimError({ reason: "host" });
  }
  const tools = yield* resolveTools;
  if (tools === null) return yield* new NeovimError({ reason: "unsupported" });
  if (tools.terminal === null) return yield* new NeovimError({ reason: "terminal" });
  const path = yield* Path.Path;
  const position = line === undefined ? [] : [`+call cursor(${line},${column ?? 1})`];
  let argv: string[];
  let cwd: string | undefined;

  if (input.sshHost !== undefined) {
    if (tools.ssh === null) return yield* new NeovimError({ reason: "ssh" });
    // No local stat/cwd: this path belongs exclusively to the remote environment.
    // Known install paths also work in non-interactive SSH shells without mise activation.
    const script = [
      `target=${quote(target)}`,
      `if [ -d "$target" ]; then cd "$target" || exit; set -- .; else cd ${quote(path.dirname(target))} || exit; set -- "$target"; fi`,
      'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      "nvim=$(command -v nvim)",
      'if [ -z "$nvim" ]; then',
      '  for candidate in "$HOME/.local/share/mise/installs/neovim/latest/bin/nvim" "$HOME/.local/share/mise/shims/nvim" /opt/homebrew/bin/nvim /usr/local/bin/nvim; do',
      '    if [ -x "$candidate" ]; then nvim=$candidate; break; fi',
      "  done",
      "fi",
      '[ -n "$nvim" ] || { printf "%s\\n" "Neovim not found on SSH host; install it with mise or Homebrew." >&2; exit 127; }',
      `exec "$nvim" ${position.map(quote).join(" ")} -- "$@"`,
    ].join("\n");
    // Keep authentication and remote errors visible even when the terminal has
    // no portable hold option. SSH's arguments remain positional parameters.
    argv = [
      "/bin/sh",
      "-c",
      '"$@"; status=$?; printf "\\nSSH exited (%s). Press Enter to close. " "$status"; read -r answer',
      "t3-neovim",
      tools.ssh,
      "-t",
      "--",
      input.sshHost,
      `sh -c ${quote(script)}`,
    ];
  } else {
    if (tools.nvim === null) return yield* new NeovimError({ reason: "nvim" });
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(target)
      .pipe(Effect.mapError(() => new NeovimError({ reason: "target" })));
    const directory = info.type === "Directory";
    cwd = directory ? target : path.dirname(target);
    argv = [tools.nvim, ...position, "--", directory ? "." : target];
  }

  const invocation = terminalInvocation(tools.terminal, argv, cwd);
  if (tools.terminal.kind === "Terminal" || tools.terminal.kind === "iTerm") {
    // osascript is a short-lived launcher. Wait for its result so denied
    // Automation access or a scripting error is not reported as success.
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          NodeChildProcess.execFile(
            invocation.command,
            invocation.args,
            { env: tools.env, timeout: 10_000, maxBuffer: 64 * 1024 },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
      catch: () => new NeovimError({ reason: "spawn" }),
    });
    return;
  }
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(invocation.command, invocation.args, {
          ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
          env: tools.env,
          detached: true,
          stdio: "ignore",
          shell: false,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      }),
    catch: () => new NeovimError({ reason: "spawn" }),
  });
});

/** IPC returns a bounded, user-facing failure, never raw process output. */
export const open = (input: OpenNeovimInput) =>
  launch(input).pipe(
    Effect.as(null),
    Effect.catchTags({ NeovimError: (error) => Effect.succeed(error.message) }),
  );
