import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  isActiveCompareHost,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  ArrowUpRightIcon,
  CheckIcon,
  Columns2Icon,
  FileDiffIcon,
  FolderTreeIcon,
  GlobeIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { cn, newMessageId } from "../../lib/utils";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment, vcsStatusRevalidation } from "../../state/vcs";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
} from "../../types";
import ChatView from "../ChatView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChatHeader } from "./ChatHeader";
import { RewriteProviderIcon, resolveRewriteModelDisplay } from "./Rewrites";
import { ThreadVisitWatermark } from "./ThreadVisitWatermark";
import {
  resolveFocusedContenderId,
  summarizeCompareContenders,
  type CompareBroadcastControl,
  type CompareBroadcastPayload,
} from "./compareThread.logic";

interface CompareContenderColumnProps {
  readonly environmentId: EnvironmentId;
  readonly hostThreadId: ThreadId;
  readonly contenderId: ThreadId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly focused: boolean;
  readonly busyAction: boolean;
  readonly canOperate: boolean;
  readonly rightPanelPortalTarget: HTMLElement | null;
  readonly broadcastControl: CompareBroadcastControl;
  readonly onFocus: (contenderId: ThreadId) => void;
  readonly onOpenDiff: (contenderId: ThreadId) => void;
  readonly onPickWinner: (contenderId: ThreadId) => void;
  readonly onPopOut: (contenderId: ThreadId) => void;
  readonly onDrop: (contenderId: ThreadId) => void;
}

function CompareContenderColumn(props: CompareContenderColumnProps) {
  const {
    environmentId,
    hostThreadId,
    contenderId,
    providers,
    focused,
    busyAction,
    canOperate,
    rightPanelPortalTarget,
    broadcastControl,
    onFocus,
    onOpenDiff,
    onPickWinner,
    onPopOut,
    onDrop,
  } = props;
  const gt = useGT();
  const contenderRef = scopeThreadRef(environmentId, contenderId);
  const hostRef = scopeThreadRef(environmentId, hostThreadId);
  const shell = useQuietThreadShell(contenderRef);
  const project = useProject(
    shell?.projectId ? scopeProjectRef(environmentId, shell.projectId) : null,
  );
  const gitCwd = shell?.worktreePath ?? project?.workspaceRoot ?? null;
  const tracksGitStatus =
    gitCwd !== null && (shell?.worktreePath !== null || shell?.branch !== null);
  useAtomMount(vcsStatusRevalidation(tracksGitStatus ? { environmentId, cwd: gitCwd } : null));
  const vcsStatus = useEnvironmentQuery(
    tracksGitStatus
      ? vcsEnvironment.status({
          environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const workingTree = vcsStatus.data?.workingTree;
  const hasDiffStats =
    workingTree !== undefined &&
    (workingTree.files.length > 0 || workingTree.insertions > 0 || workingTree.deletions > 0);
  const display = shell ? resolveRewriteModelDisplay(shell.modelSelection, providers) : null;
  const isActive = threadRuntimeIsActive(shell?.runtime);
  const needsApproval = shell?.hasPendingApprovals === true;
  const needsInput = shell?.hasPendingUserInput === true;
  const isFailed = shell?.latestRun?.status === "failed";

  const embeddedPanel: SideChatParentPanel = {
    hostRef,
    openToolDiff: () => {
      onOpenDiff(contenderId);
    },
    runShellCommand: () => {
      onFocus(contenderId);
    },
  };

  return (
    <section
      data-testid="compare-contender-column"
      data-contender-thread-id={contenderId}
      data-focused={focused ? "true" : undefined}
      onMouseDownCapture={() => {
        if (!focused) onFocus(contenderId);
      }}
      onFocusCapture={() => {
        if (!focused) onFocus(contenderId);
      }}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden border-r border-border/70 bg-background last:border-r-0",
        focused && "ring-1 ring-inset ring-primary/35",
      )}
    >
      <header
        className={cn(
          "flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-3",
          focused ? "bg-primary/[0.04]" : "bg-muted/20",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {display ? <RewriteProviderIcon display={display} className="size-4 shrink-0" /> : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">
                {display?.modelLabel ?? shell?.modelSelection.model ?? gt("Loading…")}
              </span>
              {needsApproval ? (
                <Badge size="sm" variant="warning">
                  <T>Approval</T>
                </Badge>
              ) : needsInput ? (
                <Badge size="sm" variant="warning">
                  <T>Input</T>
                </Badge>
              ) : isFailed ? (
                <Badge size="sm" variant="error">
                  <T>Failed</T>
                </Badge>
              ) : isActive ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                  <Spinner size="xs" />
                  {shell?.runtime?.status === "preparing" ? gt("Setup") : gt("Running")}
                </span>
              ) : shell?.latestRun !== null ? (
                <Badge size="sm" variant="secondary">
                  <T>Ready</T>
                </Badge>
              ) : null}
            </div>
            {display?.subtitle ? (
              <p className="truncate text-2xs leading-tight text-muted-foreground">
                {display.subtitle}
              </p>
            ) : null}
          </div>
        </div>

        {hasDiffStats && workingTree ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="compare-contender-diff-badge"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenDiff(contenderId);
                  }}
                />
              }
            >
              <span className="inline-flex items-center gap-1 font-mono text-2xs tabular-nums">
                <span className="text-diff-addition-foreground">
                  +{formatDiffCount(workingTree.insertions)}
                </span>
                <span className="text-diff-deletion-foreground">
                  -{formatDiffCount(workingTree.deletions)}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Inspect this model&apos;s changes in the diff panel</T>
            </TooltipPopup>
          </Tooltip>
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="compare-pick-winner"
                  disabled={!canOperate || busyAction}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPickWinner(contenderId);
                  }}
                />
              }
            >
              <CheckIcon className="size-3" />
              <T>Pick</T>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Pick winner: promote to sidebar and settle the others</T>
            </TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  data-testid="compare-pop-out"
                  aria-label={gt("Pop out as standalone thread")}
                  disabled={!canOperate || busyAction}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPopOut(contenderId);
                  }}
                />
              }
            >
              <ArrowUpRightIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Pop out into its own sidebar thread</T>
            </TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  data-testid="compare-drop-contender"
                  aria-label={gt("Remove from comparison")}
                  disabled={!canOperate || busyAction}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDrop(contenderId);
                  }}
                />
              }
            >
              <XIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Drop model from comparison</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ComposerHandleContext value={null}>
          <ChatView
            key={contenderId}
            environmentId={environmentId}
            threadId={contenderId}
            routeKind="server"
            embedded={embeddedPanel}
            rightPanelPortalTarget={focused ? rightPanelPortalTarget : null}
            compareBroadcast={broadcastControl}
          />
        </ComposerHandleContext>
      </div>
    </section>
  );
}

export function CompareThreadView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  const hostRef = scopeThreadRef(environmentId, threadId);
  const hostShell = useQuietThreadShell(hostRef);
  const project = useProject(
    hostShell?.projectId ? scopeProjectRef(environmentId, hostShell.projectId) : null,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers = config?.providers ?? [];
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const pickWinner = useAtomCommand(threadEnvironment.pickCompareWinner, { reportFailure: false });
  const undoPick = useAtomCommand(threadEnvironment.undoComparePick, { reportFailure: false });
  const popOut = useAtomCommand(threadEnvironment.popOutCompareContender, { reportFailure: false });
  const dropContender = useAtomCommand(threadEnvironment.dropCompareContender, {
    reportFailure: false,
  });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });

  const contenderIds = hostShell?.compare?.contenderThreadIds ?? [];
  const [focusedState, setFocusedState] = useState<ThreadId | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [rightPanelPortalTarget, setRightPanelPortalTarget] = useState<HTMLDivElement | null>(null);

  const focusedContenderId = resolveFocusedContenderId(contenderIds, focusedState);
  const focusedContenderRef: ScopedThreadRef | null = focusedContenderId
    ? scopeThreadRef(environmentId, focusedContenderId)
    : null;

  const activeRightPanelKind = useRightPanelStore((state) =>
    focusedContenderRef ? selectActiveRightPanel(state.byThreadKey, focusedContenderRef) : null,
  );
  const rightPanelOpen = activeRightPanelKind !== null;

  // Keep the single right panel tracking the focused contender without ghost-reopening closed panels.
  const handleFocusContender = (nextId: ThreadId) => {
    if (nextId === focusedContenderId) return;
    const store = useRightPanelStore.getState();
    const prevRef = focusedContenderId ? scopeThreadRef(environmentId, focusedContenderId) : null;
    const prevKind = prevRef ? selectActiveRightPanel(store.byThreadKey, prevRef) : null;
    const nextRef = scopeThreadRef(environmentId, nextId);
    setFocusedState(nextId);
    if (prevRef !== null && prevKind !== null) {
      store.close(prevRef);
    }
    if (prevKind === "diff" || prevKind === "files" || prevKind === "pull-requests") {
      store.open(nextRef, prevKind);
    } else if (prevKind === null) {
      store.close(nextRef);
    }
  };

  const handleOpenContenderPanel = (contenderId: ThreadId, kind: "diff" | "files") => {
    const store = useRightPanelStore.getState();
    if (focusedContenderId && focusedContenderId !== contenderId) {
      store.close(scopeThreadRef(environmentId, focusedContenderId));
    }
    const nextRef = scopeThreadRef(environmentId, contenderId);
    setFocusedState(contenderId);
    store.open(nextRef, kind);
  };

  const handleOpenDiff = (contenderId: ThreadId) => handleOpenContenderPanel(contenderId, "diff");

  const handleBroadcast = async (payload: CompareBroadcastPayload): Promise<boolean> => {
    const text = payload.text.trim();
    if (text.length === 0 || contenderIds.length === 0) return false;
    const results = await Promise.all(
      contenderIds.map((contenderId) =>
        startTurn({
          environmentId,
          input: {
            threadId: contenderId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: hostShell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: hostShell?.interactionMode ?? DEFAULT_INTERACTION_MODE,
            dispatchMode: "auto",
          },
        }),
      ),
    );
    const failures = results.filter((result) => result._tag === "Failure");
    if (failures.length === results.length) {
      toastManager.add({
        type: "error",
        title: gt("Could not send to models"),
      });
      return false;
    }
    if (failures.length > 0) {
      toastManager.add({
        type: "warning",
        title: gt("Sent to {sent} of {total} models", {
          sent: results.length - failures.length,
          total: results.length,
        }),
      });
    }
    return true;
  };

  const broadcastControl: CompareBroadcastControl = {
    count: contenderIds.length,
    onBroadcast: handleBroadcast,
  };

  const handlePickWinner = async (winnerThreadId: ThreadId) => {
    if (busyAction || !canOperate) return;
    setBusyAction(true);
    const result = await pickWinner({
      environmentId,
      input: { threadId, winnerThreadId },
    });
    setBusyAction(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not pick winner"),
          ...(error instanceof Error ? { description: error.message } : {}),
        });
      }
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, winnerThreadId)),
    });
    toastManager.add({
      type: "success",
      title: gt("Picked winner. Other models settled."),
      timeout: 6000,
      actionProps: {
        children: gt("Undo"),
        onClick: () => {
          void undoPick({ environmentId, input: { threadId } }).then((undoResult) => {
            if (undoResult._tag !== "Success") return;
            const hostAtom = environmentThreadShells.threadShellAtom(hostRef);
            const openHost = () => {
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(hostRef),
              });
            };
            if (isActiveCompareHost(appAtomRegistry.get(hostAtom))) {
              openHost();
              return;
            }
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              unsubscribe();
              clearTimeout(fallbackTimer);
              openHost();
            };
            const unsubscribe = appAtomRegistry.subscribe(hostAtom, (shell) => {
              if (isActiveCompareHost(shell)) finish();
            });
            const fallbackTimer = setTimeout(finish, 2000);
          });
        },
      },
    });
  };

  const handlePopOut = async (contenderThreadId: ThreadId) => {
    if (busyAction || !canOperate) return;
    setBusyAction(true);
    const result = await popOut({
      environmentId,
      input: { threadId, contenderThreadId },
    });
    setBusyAction(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not pop out thread"),
          ...(error instanceof Error ? { description: error.message } : {}),
        });
      }
      return;
    }
    if (contenderIds.length <= 1) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, contenderThreadId)),
      });
      return;
    }
    toastManager.add({
      type: "info",
      title: gt("Popped out to sidebar"),
      actionProps: {
        children: gt("Open"),
        onClick: () =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(environmentId, contenderThreadId)),
          }),
      },
    });
  };

  const handleDrop = async (contenderThreadId: ThreadId) => {
    if (busyAction || !canOperate) return;
    setBusyAction(true);
    const result = await dropContender({
      environmentId,
      input: { threadId, contenderThreadId },
    });
    setBusyAction(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not remove model"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const rollup = hostShell?.compareRollup;
  const summary = rollup
    ? {
        total: rollup.totalCount,
        active: rollup.activeCount,
        ready: rollup.readyCount,
        failed: rollup.failedCount,
        needsAttention: rollup.needsAttentionCount,
      }
    : summarizeCompareContenders([]);

  const toggleFocusedPanel = (kind: "diff" | "files") => {
    if (!focusedContenderRef) return;
    const store = useRightPanelStore.getState();
    const current = selectActiveRightPanel(store.byThreadKey, focusedContenderRef);
    if (current === kind) {
      store.close(focusedContenderRef);
    } else {
      store.open(focusedContenderRef, kind);
    }
  };

  return (
    <div
      data-testid="compare-thread-view"
      data-host-thread-id={threadId}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border/80 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end)",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <div className="min-w-0 flex-1">
          <ChatHeader
            activeThreadEnvironmentId={environmentId}
            activeThreadId={threadId}
            activeThreadTitle={hostShell?.title ?? gt("Model comparison")}
            isServerThread
            activeProject={project}
            parentThreadLink={null}
            onOpenThread={(targetId) =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(environmentId, targetId)),
              })
            }
            rightPanelOpen={rightPanelOpen}
            onNewThreadInProject={() => {
              if (project) void handleNewThread({ environmentId, projectId: project.id });
            }}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="secondary" size="sm">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Columns2Icon className="size-3" />
              {summary.active > 0 ? (
                <T>
                  <Var>{summary.ready}</Var>/<Var>{contenderIds.length}</Var> ready
                </T>
              ) : (
                <T>
                  <Var>{contenderIds.length}</Var> models
                </T>
              )}
            </span>
          </Badge>

          {focusedContenderRef ? (
            <div className="flex items-center gap-0.5 border-l border-border/60 pl-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant={activeRightPanelKind === "diff" ? "secondary" : "ghost-muted"}
                      aria-label={gt("Toggle diff panel for focused model")}
                      onClick={() => toggleFocusedPanel("diff")}
                    />
                  }
                >
                  <FileDiffIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Diff (focused model)</T>
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant={activeRightPanelKind === "files" ? "secondary" : "ghost-muted"}
                      aria-label={gt("Toggle files panel for focused model")}
                      onClick={() => toggleFocusedPanel("files")}
                    />
                  }
                >
                  <FolderTreeIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Files (focused model)</T>
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant={activeRightPanelKind === "terminal" ? "secondary" : "ghost-muted"}
                      aria-label={gt("Open terminal for focused model")}
                      onClick={() => {
                        const store = useRightPanelStore.getState();
                        store.openTerminal(focusedContenderRef, DEFAULT_THREAD_TERMINAL_ID);
                      }}
                    />
                  }
                >
                  <TerminalIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Terminal (focused model)</T>
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant={activeRightPanelKind === "preview" ? "secondary" : "ghost-muted"}
                      aria-label={gt("Open browser for focused model")}
                      onClick={() => {
                        const store = useRightPanelStore.getState();
                        store.openBrowser(focusedContenderRef, null);
                      }}
                    />
                  }
                >
                  <GlobeIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  <T>Browser (focused model)</T>
                </TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </div>

      {/* Narrow-viewport model switcher */}
      <div
        role="group"
        aria-label={gt("Compare models")}
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-muted/20 px-2 py-1.5 md:hidden"
      >
        {contenderIds.map((contenderId) => (
          <NarrowContenderTab
            key={contenderId}
            environmentId={environmentId}
            contenderId={contenderId}
            providers={providers}
            active={contenderId === focusedContenderId}
            onSelect={handleFocusContender}
          />
        ))}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop: side-by-side multi-column grid with readable min width; Narrow: focused column only */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-auto md:grid md:auto-cols-[minmax(24rem,1fr)] md:grid-flow-col">
          {contenderIds.map((contenderId) => {
            const focused = contenderId === focusedContenderId;
            return (
              <div
                key={contenderId}
                className={cn("h-full min-h-0 min-w-0", !focused && "hidden md:block")}
              >
                <CompareContenderColumn
                  environmentId={environmentId}
                  hostThreadId={threadId}
                  contenderId={contenderId}
                  providers={providers}
                  focused={focused}
                  busyAction={busyAction}
                  canOperate={canOperate}
                  rightPanelPortalTarget={rightPanelPortalTarget}
                  broadcastControl={broadcastControl}
                  onFocus={handleFocusContender}
                  onOpenDiff={handleOpenDiff}
                  onPickWinner={(id) => void handlePickWinner(id)}
                  onPopOut={(id) => void handlePopOut(id)}
                  onDrop={(id) => void handleDrop(id)}
                />
              </div>
            );
          })}
        </div>

        {/* Single right-panel portal slot fed by the currently focused contender */}
        <div ref={setRightPanelPortalTarget} className="contents" />
      </div>
      <ThreadVisitWatermark threadRef={hostRef} />
    </div>
  );
}

function NarrowContenderTab(props: {
  readonly environmentId: EnvironmentId;
  readonly contenderId: ThreadId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly active: boolean;
  readonly onSelect: (id: ThreadId) => void;
}) {
  const shell = useQuietThreadShell(scopeThreadRef(props.environmentId, props.contenderId));
  const display = shell ? resolveRewriteModelDisplay(shell.modelSelection, props.providers) : null;
  const activeRun = threadRuntimeIsActive(shell?.runtime);
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={() => props.onSelect(props.contenderId)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
        props.active
          ? "border-primary/50 bg-primary/12 text-foreground"
          : "border-border/70 bg-card text-muted-foreground",
      )}
    >
      {display ? <RewriteProviderIcon display={display} className="size-3.5" /> : null}
      <span>{display?.modelLabel ?? shell?.modelSelection.model ?? "…"}</span>
      {activeRun ? <Spinner size="xs" /> : null}
    </button>
  );
}
