import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  AuthOrchestrationOperateScope,
  isActiveCompareHost,
  type EnvironmentId,
  type MessageId,
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
import { useRef, useState, type ReactNode } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
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
import { waitForAtomValue } from "../../state/waitForAtomValue";
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
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { RewriteProviderIcon, resolveRewriteModelDisplay } from "./Rewrites";
import { ThreadVisitWatermark } from "./ThreadVisitWatermark";
import {
  CompareColumnContext,
  resolveFocusedContenderId,
  type CompareBroadcastControl,
  type CompareBroadcastPayload,
} from "./compareThread.logic";

function ContenderStatusBadge(props: { readonly shell: EnvironmentThreadShell | null }) {
  const gt = useGT();
  const { shell } = props;
  if (!shell) return null;
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return (
      <Badge size="sm" variant="warning">
        <T>Approval</T>
      </Badge>
    );
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return (
      <Badge size="sm" variant="warning">
        <T>Input</T>
      </Badge>
    );
  }
  if (shell.latestRun?.status === "failed") {
    return (
      <Badge size="sm" variant="error">
        <T>Failed</T>
      </Badge>
    );
  }
  if (threadRuntimeIsActive(shell.runtime)) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
        <Spinner size="xs" />
        {shell.runtime?.status === "preparing" ? gt("Setup") : gt("Running")}
      </span>
    );
  }
  if (shell.latestRun !== null) {
    return (
      <Badge size="sm" variant="secondary">
        <T>Ready</T>
      </Badge>
    );
  }
  return null;
}

function HeaderTooltipButton(props: {
  readonly label: string;
  readonly tooltip: ReactNode;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly size?: "xs" | "icon-xs";
  readonly variant?: "outline" | "ghost" | "ghost-muted" | "secondary";
  readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size={props.size ?? "icon-xs"}
            variant={props.variant ?? (props.active ? "secondary" : "ghost-muted")}
            data-testid={props.testId}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

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
    tracksGitStatus ? vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }) : null,
  );
  const workingTree = vcsStatus.data?.workingTree;
  const diffStat = workingTree
    ? { additions: workingTree.insertions, deletions: workingTree.deletions }
    : null;
  const showDiffBadge =
    workingTree !== undefined &&
    diffStat !== null &&
    (workingTree.files.length > 0 || hasNonZeroStat(diffStat));
  const display = shell ? resolveRewriteModelDisplay(shell.modelSelection, providers) : null;

  const embeddedPanel: SideChatParentPanel = {
    hostRef,
    openToolDiff: () => onOpenDiff(contenderId),
    runShellCommand: () => onFocus(contenderId),
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
              <ContenderStatusBadge shell={shell} />
            </div>
            {display?.subtitle ? (
              <p className="truncate text-2xs leading-tight text-muted-foreground">
                {display.subtitle}
              </p>
            ) : null}
          </div>
        </div>

        {showDiffBadge && diffStat ? (
          <HeaderTooltipButton
            size="xs"
            variant="ghost"
            testId="compare-contender-diff-badge"
            label={gt("Inspect this model's changes in the diff panel")}
            tooltip={<T>Inspect this model&apos;s changes in the diff panel</T>}
            onClick={(event) => {
              event.stopPropagation();
              onOpenDiff(contenderId);
            }}
          >
            <DiffStatLabel
              layout="inline"
              additions={diffStat.additions}
              deletions={diffStat.deletions}
              className="text-2xs"
            />
          </HeaderTooltipButton>
        ) : null}

        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderTooltipButton
            size="xs"
            variant="outline"
            testId="compare-pick-winner"
            label={gt("Pick")}
            disabled={!canOperate || busyAction}
            tooltip={<T>Pick winner: promote to sidebar and settle the others</T>}
            onClick={(event) => {
              event.stopPropagation();
              onPickWinner(contenderId);
            }}
          >
            <CheckIcon className="size-3" />
            <T>Pick</T>
          </HeaderTooltipButton>
          <HeaderTooltipButton
            testId="compare-pop-out"
            label={gt("Pop out as standalone thread")}
            disabled={!canOperate || busyAction}
            tooltip={<T>Pop out into its own sidebar thread</T>}
            onClick={(event) => {
              event.stopPropagation();
              onPopOut(contenderId);
            }}
          >
            <ArrowUpRightIcon className="size-3.5" />
          </HeaderTooltipButton>
          <HeaderTooltipButton
            testId="compare-drop-contender"
            label={gt("Remove from comparison")}
            disabled={!canOperate || busyAction}
            tooltip={<T>Drop model from comparison</T>}
            onClick={(event) => {
              event.stopPropagation();
              onDrop(contenderId);
            }}
          >
            <XIcon className="size-3.5" />
          </HeaderTooltipButton>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <ComposerHandleContext value={null}>
          <CompareColumnContext
            value={{
              broadcast: broadcastControl,
              rightPanelPortalTarget: focused ? rightPanelPortalTarget : null,
              onFocus: () => onFocus(contenderId),
            }}
          >
            <ChatView
              key={contenderId}
              environmentId={environmentId}
              threadId={contenderId}
              routeKind="server"
              embedded={embeddedPanel}
            />
          </CompareColumnContext>
        </ComposerHandleContext>
      </div>
    </section>
  );
}

export function CompareThreadView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly fallbackHostShell?:
    | (Pick<EnvironmentThreadShell, "projectId" | "title" | "runtimeMode" | "interactionMode"> & {
        readonly compare?: EnvironmentThreadShell["compare"] | undefined;
      })
    | null;
}) {
  const { environmentId, threadId } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const isDesktop = useMediaQuery("md");
  const handleNewThread = useNewThreadHandler();
  const hostRef = scopeThreadRef(environmentId, threadId);
  const liveHostShell = useQuietThreadShell(hostRef);
  const hostShell = liveHostShell ?? props.fallbackHostShell ?? null;
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
  // Retains failed targets + message IDs so retrying after a partial broadcast never double-sends.
  const pendingFailedBroadcastRef = useRef<{
    readonly text: string;
    readonly targets: ReadonlyMap<ThreadId, MessageId>;
  } | null>(null);

  const focusedContenderId = resolveFocusedContenderId(contenderIds, focusedState);
  const focusedContenderRef: ScopedThreadRef | null = focusedContenderId
    ? scopeThreadRef(environmentId, focusedContenderId)
    : null;
  const activeRightPanelKind = useRightPanelStore((state) =>
    focusedContenderRef ? selectActiveRightPanel(state.byThreadKey, focusedContenderRef) : null,
  );

  const openThread = (targetId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, targetId)),
    });

  // Keep the single right panel tracking the focused contender without ghost-reopening closed panels.
  const handleFocusContender = (nextId: ThreadId) => {
    if (nextId === focusedContenderId) return;
    const store = useRightPanelStore.getState();
    const prevRef = focusedContenderId ? scopeThreadRef(environmentId, focusedContenderId) : null;
    const prevKind = prevRef ? selectActiveRightPanel(store.byThreadKey, prevRef) : null;
    const nextRef = scopeThreadRef(environmentId, nextId);
    setFocusedState(nextId);
    if (prevRef !== null && prevKind !== null) store.close(prevRef);
    if (prevKind === "diff" || prevKind === "files" || prevKind === "pull-requests") {
      store.open(nextRef, prevKind);
    } else if (prevKind === null) {
      store.close(nextRef);
    }
  };

  const handleOpenDiff = (contenderId: ThreadId) => {
    const store = useRightPanelStore.getState();
    if (focusedContenderId && focusedContenderId !== contenderId) {
      store.close(scopeThreadRef(environmentId, focusedContenderId));
    }
    setFocusedState(contenderId);
    store.open(scopeThreadRef(environmentId, contenderId), "diff");
  };

  const handleBroadcast = async (payload: CompareBroadcastPayload): Promise<boolean> => {
    const text = payload.text.trim();
    if (text.length === 0 || contenderIds.length === 0) return false;
    const previousFailed = pendingFailedBroadcastRef.current;
    const targetEntries: ReadonlyArray<readonly [ThreadId, MessageId]> =
      previousFailed !== null && previousFailed.text === text
        ? contenderIds.flatMap((id) => {
            const messageId = previousFailed.targets.get(id);
            return messageId !== undefined ? ([[id, messageId]] as const) : [];
          })
        : contenderIds.map((id) => [id, newMessageId()] as const);
    if (targetEntries.length === 0) {
      pendingFailedBroadcastRef.current = null;
      return true;
    }
    const outcomes = await Promise.all(
      targetEntries.map(async ([contenderId, messageId]) => ({
        contenderId,
        messageId,
        result: await startTurn({
          environmentId,
          input: {
            threadId: contenderId,
            message: { messageId, role: "user", text, attachments: [] },
            runtimeMode: hostShell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: hostShell?.interactionMode ?? DEFAULT_INTERACTION_MODE,
            dispatchMode: "auto",
          },
        }),
      })),
    );
    const failed = outcomes.filter((item) => item.result._tag === "Failure");
    if (failed.length === 0) {
      pendingFailedBroadcastRef.current = null;
      return true;
    }
    pendingFailedBroadcastRef.current = {
      text,
      targets: new Map(failed.map((item) => [item.contenderId, item.messageId] as const)),
    };
    if (failed.length === outcomes.length) {
      toastManager.add({ type: "error", title: gt("Could not send to models") });
    } else {
      toastManager.add({
        type: "warning",
        title: gt("Sent to {sent} of {total} models", {
          sent: outcomes.length - failed.length,
          total: outcomes.length,
        }),
        description: gt("Send again to retry only the failed models."),
      });
    }
    return false;
  };

  const runCompareAction = async <A, E>(
    run: () => Promise<AtomCommandResult<A, E>>,
    errorTitle: string,
    onSuccess?: () => void,
  ) => {
    if (busyAction || !canOperate) return;
    setBusyAction(true);
    const result = await run();
    setBusyAction(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: errorTitle,
          ...(error instanceof Error ? { description: error.message } : {}),
        });
      }
      return;
    }
    onSuccess?.();
  };

  const handlePickWinner = (winnerThreadId: ThreadId) =>
    void runCompareAction(
      () => pickWinner({ environmentId, input: { threadId, winnerThreadId } }),
      gt("Could not pick winner"),
      () => {
        const claim = ThreadUndo.begin("compare", `${environmentId}/${threadId}`);
        openThread(winnerThreadId);
        showThreadUndoNotice({
          action: "Picked",
          claim,
          failureTitle: gt("Could not undo winner pick"),
          undo: async () => {
            const undoResult = await undoPick({ environmentId, input: { threadId } });
            if (undoResult._tag === "Success") {
              await waitForAtomValue({
                registry: appAtomRegistry,
                atom: environmentThreadShells.threadShellAtom(hostRef),
                predicate: isActiveCompareHost,
                timeoutMs: 2_000,
              });
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(hostRef),
              });
            }
            return undoResult;
          },
        });
      },
    );

  const handlePopOut = (contenderThreadId: ThreadId) =>
    void runCompareAction(
      () => popOut({ environmentId, input: { threadId, contenderThreadId } }),
      gt("Could not pop out thread"),
      () => {
        if (contenderIds.length <= 1) {
          openThread(contenderThreadId);
          return;
        }
        toastManager.add({
          type: "info",
          title: gt("Popped out to sidebar"),
          actionProps: { children: gt("Open"), onClick: () => openThread(contenderThreadId) },
        });
      },
    );

  const handleDrop = (contenderThreadId: ThreadId) =>
    void runCompareAction(
      () => dropContender({ environmentId, input: { threadId, contenderThreadId } }),
      gt("Could not remove model"),
    );

  const rollup = liveHostShell?.compareRollup;
  const summary = { active: rollup?.activeCount ?? 0, ready: rollup?.readyCount ?? 0 };
  const renderedContenderIds = isDesktop
    ? contenderIds
    : focusedContenderId !== null
      ? [focusedContenderId]
      : [];

  const toggleFocusedPanel = (kind: "diff" | "files") => {
    if (!focusedContenderRef) return;
    const store = useRightPanelStore.getState();
    if (selectActiveRightPanel(store.byThreadKey, focusedContenderRef) === kind) {
      store.close(focusedContenderRef);
    } else {
      store.open(focusedContenderRef, kind);
    }
  };

  const panelButtons = focusedContenderRef
    ? [
        {
          kind: "diff" as const,
          label: gt("Toggle diff panel for focused model"),
          tooltip: <T>Diff (focused model)</T>,
          icon: <FileDiffIcon className="size-3.5" />,
          onClick: () => toggleFocusedPanel("diff"),
        },
        {
          kind: "files" as const,
          label: gt("Toggle files panel for focused model"),
          tooltip: <T>Files (focused model)</T>,
          icon: <FolderTreeIcon className="size-3.5" />,
          onClick: () => toggleFocusedPanel("files"),
        },
        {
          kind: "terminal" as const,
          label: gt("Open terminal for focused model"),
          tooltip: <T>Terminal (focused model)</T>,
          icon: <TerminalIcon className="size-3.5" />,
          onClick: () =>
            useRightPanelStore
              .getState()
              .openTerminal(focusedContenderRef, DEFAULT_THREAD_TERMINAL_ID),
        },
        {
          kind: "preview" as const,
          label: gt("Open browser for focused model"),
          tooltip: <T>Browser (focused model)</T>,
          icon: <GlobeIcon className="size-3.5" />,
          onClick: () => useRightPanelStore.getState().openBrowser(focusedContenderRef, null),
        },
      ]
    : [];

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
            onOpenThread={openThread}
            rightPanelOpen={activeRightPanelKind !== null}
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

          {panelButtons.length > 0 ? (
            <div className="flex items-center gap-0.5 border-l border-border/60 pl-1.5">
              {panelButtons.map((button) => (
                <HeaderTooltipButton
                  key={button.kind}
                  active={activeRightPanelKind === button.kind}
                  label={button.label}
                  tooltip={button.tooltip}
                  onClick={button.onClick}
                >
                  {button.icon}
                </HeaderTooltipButton>
              ))}
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
        {/* Desktop: side-by-side multi-column grid with readable min width; Narrow: mount focused column only */}
        <div className="min-h-0 min-w-0 flex-1 overflow-x-auto md:grid md:auto-cols-[minmax(24rem,1fr)] md:grid-flow-col">
          {renderedContenderIds.map((contenderId) => {
            const focused = contenderId === focusedContenderId;
            return (
              <div key={contenderId} className="h-full min-h-0 min-w-0">
                <CompareContenderColumn
                  environmentId={environmentId}
                  hostThreadId={threadId}
                  contenderId={contenderId}
                  providers={providers}
                  focused={focused}
                  busyAction={busyAction}
                  canOperate={canOperate}
                  rightPanelPortalTarget={rightPanelPortalTarget}
                  broadcastControl={{ count: contenderIds.length, onBroadcast: handleBroadcast }}
                  onFocus={handleFocusContender}
                  onOpenDiff={handleOpenDiff}
                  onPickWinner={handlePickWinner}
                  onPopOut={handlePopOut}
                  onDrop={handleDrop}
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
