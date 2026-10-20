import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  type EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";
import { CLIENT_EDITORS, ClientEditorId } from "./clientEditor";
import { useEditorAvailability } from "./clientEditors";
import { openRemoteEditorUrl, useRemoteOpenResolution } from "./remoteOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(ClientEditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export function usePreferredEditor(
  availableEditors: ReadonlyArray<ClientEditorId>,
  isResolved = true,
) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, ClientEditorId);

  const effectiveEditor = useMemo(() => {
    if (!isResolved) return lastEditor;
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return CLIENT_EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors, isResolved]);

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(
  availableEditors: readonly ClientEditorId[],
): ClientEditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, ClientEditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = CLIENT_EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, ClientEditorId);
  return editor ?? null;
}

export class ClientEditorLaunchError extends Schema.TaggedError<ClientEditorLaunchError>()(
  "ClientEditorLaunchError",
  { message: Schema.String },
) {}

/** All editor entry points share client/remote routing; Neovim never reaches RPC. */
export function useOpenEditor(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenError =
    | AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>
    | PreferredEditorEnvironmentRequiredError
    | ClientEditorLaunchError
    | EnvironmentAuthorizationError;
  const { state: remote, isResolved } = useRemoteOpenResolution(environmentId);
  return useCallback(
    async (
      editor: ClientEditorId,
      targetPath: string,
    ): Promise<AtomCommandResult<ClientEditorId, OpenError>> => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath })),
        );
      }
      if (!isResolved || remote.mode === "remote-unavailable") {
        return AsyncResult.failure(
          Cause.fail(
            new ClientEditorLaunchError({
              message:
                "No resolved SSH route to this environment. Connect using a saved SSH alias or enable SSH on the host.",
            }),
          ),
        );
      }
      if (
        remote.mode === "local-exec" &&
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot open an editor on this environment.",
            }),
          ),
        );
      }
      if (editor === "neovim") {
        const bridge = window.desktopBridge?.neovim;
        if (bridge === undefined) {
          return AsyncResult.failure(
            Cause.fail(
              new ClientEditorLaunchError({
                message: "Neovim requires the updated desktop app.",
              }),
            ),
          );
        }
        try {
          const error = await bridge.open({
            targetPath,
            ...(remote.mode === "remote-links" ? { sshHost: remote.host.host } : {}),
          });
          return error === null
            ? AsyncResult.success(editor)
            : AsyncResult.failure(Cause.fail(new ClientEditorLaunchError({ message: error })));
        } catch {
          return AsyncResult.failure(
            Cause.fail(
              new ClientEditorLaunchError({
                message: "Could not start Neovim on this desktop.",
              }),
            ),
          );
        }
      }
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor,
          host: remote.host.host,
          absolutePath: targetPath,
        });
        return url !== undefined && (await openRemoteEditorUrl(url))
          ? AsyncResult.success(editor)
          : AsyncResult.failure(
              Cause.fail(
                new ClientEditorLaunchError({ message: "Could not open the remote editor." }),
              ),
            );
      }
      return mapAtomCommandResult(
        await openInEditor({
          environmentId,
          input: { cwd: targetPath, editor },
        }),
        () => editor,
      );
    },
    [environmentId, isResolved, remote, openInEditor],
  );
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const { editors, remote, isResolved } = useEditorAvailability(environmentId, availableEditors);
  const open = useOpenEditor(environmentId);
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof open>>>;

  return useCallback(
    async (
      targetPath: string,
    ): Promise<
      AtomCommandResult<
        ClientEditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | EnvironmentAuthorizationError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      if (
        remote.mode === "local-exec" &&
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      ) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot open an editor on this environment.",
            }),
          ),
        );
      }
      // A pending desktop probe must not replace a saved Neovim preference.
      if (!isResolved) {
        return AsyncResult.failure(
          Cause.fail(
            new ClientEditorLaunchError({
              message: "Editor availability is still loading. Try again in a moment.",
            }),
          ),
        );
      }
      const editor = resolveAndPersistPreferredEditor(editors);
      if (!editor) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: editors,
            }),
          ),
        );
      }
      return open(editor, targetPath);
    },
    [editors, environmentId, isResolved, open, remote.mode],
  );
}
