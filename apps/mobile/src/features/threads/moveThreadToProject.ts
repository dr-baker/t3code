import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadEnvironment } from "../../state/threads";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import * as Dialog from "../../components/ui/Dialog";

export function useThreadProjectMoveTargets(thread: EnvironmentThreadShell) {
  const projects = useProjects();
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(thread.environmentId);
  if (config?.environment.capabilities.threadProjectMove !== true) return undefined;
  return projects
    .filter(
      (project) =>
        project.environmentId === thread.environmentId &&
        project.id !== thread.projectId &&
        project.archivedAt == null,
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function moveThreadToProject(
  thread: EnvironmentThreadShell,
  project: EnvironmentProject,
): void {
  if (
    project.environmentId !== thread.environmentId ||
    !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)
  ) {
    Dialog.alert("Could not move conversation", "This connection cannot move these threads.");
    return;
  }
  Dialog.confirm({
    title: `Move to ${project.title}?`,
    message:
      "This moves the conversation and all its forks. Working folders and files stay where they are. Future turns keep using those folders.",
    confirmText: "Move",
    onConfirm: async () => {
      const result = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.moveProject,
        {
          environmentId: thread.environmentId,
          input: { threadId: thread.id, projectId: project.id },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not move conversation",
          error instanceof Error ? error.message : "Try again.",
        );
      }
    },
  });
}
