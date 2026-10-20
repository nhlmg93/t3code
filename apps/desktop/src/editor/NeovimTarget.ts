// @effect-diagnostics nodeBuiltinImport:off -- Read-only, bounded native desktop discovery; never connects over SSH.
import * as NodeChildProcess from "node:child_process";
import * as NodeDns from "node:dns";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { parseSshResolveOutput } from "@t3tools/ssh/command";
import { parseTailscaleStatus } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const query = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          command,
          args,
          { env, signal, timeout: 1500, maxBuffer: 256 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        );
      }),
    catch: () => null,
  }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );

const normalizeName = (name: string) => name.toLowerCase().replace(/\.$/, "");
const decodeSelfAddresses = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ Self: Schema.Struct({ TailscaleIPs: Schema.Array(Schema.String) }) }),
  ),
);

/**
 * Saved external connections can point back at this desktop. Only bypass SSH
 * after resolving its config: the input alias/name alone says nothing about
 * HostName, User, port forwarding, or a proxy's actual destination.
 * Any failed/ambiguous discovery keeps the original SSH invocation intact.
 */
export const isClientLocalSshTarget = Effect.fn("desktop.editor.Neovim.isClientLocalSshTarget")(
  function* (ssh: string, host: string) {
    const env = yield* HostProcess.Environment;
    const config = yield* query(ssh, ["-G", "--", host], env);
    if (config === null) return false;
    const values = new Map(
      config
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const [key, ...value] = line.trim().split(/\s+/);
          return [key, value.join(" ")] as const;
        }),
    );
    const target = parseSshResolveOutput(host, config);
    const user = yield* Effect.try(() => NodeOS.userInfo().username).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (
      user === null ||
      target.username !== user ||
      target.port !== 22 ||
      !values.has("hostname") ||
      ["proxyjump", "proxycommand"].some((key) => {
        const value = values.get(key);
        return value !== undefined && value !== "none";
      })
    ) {
      return false;
    }

    const addresses = yield* Effect.try(
      () =>
        new Set(
          Object.values(NodeOS.networkInterfaces())
            .flat()
            .flatMap((entry) => (entry ? [entry.address] : [])),
        ),
    ).pipe(Effect.orElseSucceed(() => new Set<string>()));
    const resolved = yield* Effect.tryPromise(() =>
      NodeDns.promises.lookup(target.hostname, { all: true }),
    ).pipe(
      Effect.timeoutOption("1500 millis"),
      Effect.map(Option.getOrElse(() => [])),
      Effect.orElseSucceed(() => []),
    );
    // Require every answer to be ours; a mixed local/remote DNS pool is not local.
    const allLocal = () =>
      resolved.length > 0 && resolved.every((entry) => addresses.has(entry.address));
    if (allLocal()) return true;

    // On macOS the Tailscale network extension need not expose its address via
    // networkInterfaces(). Ask its read-only status, including sparse GUI PATHs.
    const platform = yield* HostProcess.Platform;
    for (const candidate of [
      "tailscale",
      ...(platform === "darwin"
        ? ["/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
        : []),
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
    ]) {
      const command = yield* resolveCommandPath(candidate, { env });
      if (command === null) continue;
      const output = yield* query(command, ["status", "--json"], env);
      if (output === null) continue;
      const status = yield* parseTailscaleStatus(output).pipe(Effect.orElseSucceed(() => null));
      if (status === null) continue;
      for (const address of status.tailnetIpv4Addresses) addresses.add(address);
      // The shared status helper exposes IPv4 only. MagicDNS also answers with
      // IPv6, so include those Self addresses before requiring every DNS answer.
      const self = yield* decodeSelfAddresses(output).pipe(Effect.orElseSucceed(() => null));
      for (const address of self?.Self.TailscaleIPs ?? []) {
        if (NodeNet.isIP(address)) addresses.add(address);
      }
      return (
        allLocal() ||
        (resolved.length === 0 &&
          status.magicDnsName !== null &&
          normalizeName(target.hostname) === normalizeName(status.magicDnsName))
      );
    }
    return false;
  },
);
