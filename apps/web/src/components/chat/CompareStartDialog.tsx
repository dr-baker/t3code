import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import {
  MODEL_COMPARE_LIMITS,
  type EnvironmentId,
  type ModelSelection,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { T, useGT, Var } from "gt-react";
import { CheckIcon, Columns2Icon, GitBranchIcon } from "lucide-react";
import { useState } from "react";

import { cn, newMessageId } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getDisplayModelName } from "./providerIconUtils";
import { defaultCompareSelections, modelIdentityKey } from "./compareThread.logic";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

interface CompareStartDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly hostThreadId: ThreadId;
  readonly sourceRunId: RunId | null;
  readonly currentModelSelection: ModelSelection | null;
  readonly isGitRepo: boolean;
  readonly baseBranch: string | null;
  readonly worktreePath: string | null;
  readonly defaultStartFromOrigin: boolean;
}

export function CompareStartDialog(props: CompareStartDialogProps) {
  const {
    open,
    onOpenChange,
    environmentId,
    hostThreadId,
    sourceRunId,
    currentModelSelection,
    isGitRepo,
    baseBranch,
    worktreePath,
    defaultStartFromOrigin,
  } = props;
  const isWorktreeThread = worktreePath !== null;
  const gt = useGT();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const startCompare = useAtomCommand(threadEnvironment.startCompare, { reportFailure: false });
  const providers: ReadonlyArray<ServerProvider> = (config?.providers ?? []).filter(
    (provider) => provider.enabled && provider.status === "ready" && provider.models.length > 0,
  );
  const [selected, setSelected] = useState<ReadonlyArray<ModelSelection>>(() =>
    defaultCompareSelections({
      providers,
      currentSelection: currentModelSelection,
      rewriteCouncil: settings?.rewriteCouncil,
    }),
  );
  const [useWorktrees, setUseWorktrees] = useState(isGitRepo && baseBranch !== null);
  const [promptText, setPromptText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initializedForRun, setInitializedForRun] = useState<RunId | null>(null);

  if (open && sourceRunId !== null && initializedForRun !== sourceRunId && providers.length > 0) {
    setInitializedForRun(sourceRunId);
    setSelected(
      defaultCompareSelections({
        providers,
        currentSelection: currentModelSelection,
        rewriteCouncil: settings?.rewriteCouncil,
      }),
    );
    setUseWorktrees(isGitRepo && baseBranch !== null);
    setPromptText("");
    setErrorMessage(null);
  }

  const selectedKeys = new Set(selected.map(modelIdentityKey));
  const canToggleMore = selected.length < MODEL_COMPARE_LIMITS.maxContenders;
  const canSubmit =
    !submitting &&
    sourceRunId !== null &&
    selected.length >= MODEL_COMPARE_LIMITS.minContenders &&
    selected.length <= MODEL_COMPARE_LIMITS.maxContenders;

  const toggleModel = (selection: ModelSelection) => {
    const key = modelIdentityKey(selection);
    if (selectedKeys.has(key)) {
      setSelected((prev) => prev.filter((item) => modelIdentityKey(item) !== key));
      return;
    }
    if (!canToggleMore) return;
    setSelected((prev) => [...prev, selection]);
  };

  const handleSubmit = async () => {
    if (!canSubmit || sourceRunId === null) return;
    setSubmitting(true);
    setErrorMessage(null);
    const trimmed = promptText.trim();
    const workspaceStrategy =
      useWorktrees && isGitRepo && baseBranch !== null
        ? {
            type: "worktree" as const,
            baseRef: baseBranch,
            // Branching from a thread's local worktree branch must start from that local ref, not origin.
            startFromOrigin: isWorktreeThread ? false : defaultStartFromOrigin,
          }
        : worktreePath !== null
          ? {
              type: "existing_worktree" as const,
              worktreePath,
              ...(baseBranch ? { branch: baseBranch } : {}),
            }
          : {
              type: "root" as const,
              ...(baseBranch ? { branch: baseBranch } : {}),
            };
    const result = await startCompare({
      environmentId,
      input: {
        mode: "fork",
        hostThreadId,
        sourceRunId,
        contenders: selected.map((modelSelection) => ({ modelSelection })),
        workspaceStrategy,
        ...(trimmed.length > 0
          ? {
              initialMessage: {
                messageId: newMessageId(),
                text: trimmed,
                attachments: [],
              },
            }
          : {}),
      },
    });
    setSubmitting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setErrorMessage(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : gt("Could not start model comparison."),
      );
      return;
    }
    if (result.value.failed.length > 0) {
      toastManager.add({
        type: "warning",
        title: gt("Some models could not be started"),
        description: result.value.failed
          .map((item) => `${item.modelSelection.model}: ${item.error}`)
          .join(" · "),
      });
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg" data-testid="compare-start-dialog">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <Columns2Icon className="size-4 text-muted-foreground" />
              <T>Compare models from this turn</T>
            </span>
          </DialogTitle>
          <DialogDescription>
            <T>
              Fork this conversation into side-by-side model columns under this thread. Pick a
              winner or pop any branch out whenever you are ready.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  <T>
                    Choose <Var>{MODEL_COMPARE_LIMITS.minContenders}</Var>–
                    <Var>{MODEL_COMPARE_LIMITS.maxContenders}</Var> models
                  </T>
                </span>
                <span className="tabular-nums">
                  <T>
                    <Var>{selected.length}</Var> selected
                  </T>
                </span>
              </div>
              <div className="rounded-lg border border-border/80 bg-muted/20">
                <ScrollArea className="max-h-60">
                  <div className="p-2">
                    {providers.length === 0 ? (
                      <p className="p-2 text-xs text-muted-foreground">
                        <T>No ready providers found in this environment.</T>
                      </p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {providers.map((provider) => {
                          const providerName = resolveProviderInstanceDisplayName(provider);
                          return (
                            <div key={provider.instanceId} className="flex flex-col gap-1">
                              <div className="flex items-center gap-1.5 px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                                <ProviderInstanceIcon
                                  driverKind={provider.driver}
                                  displayName={providerName}
                                  accentColor={provider.accentColor}
                                  size="compact"
                                  className="size-3.5"
                                  iconClassName="size-3.5"
                                />
                                <span>{providerName}</span>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {provider.models.map((model) => {
                                  const selection = createModelSelection(
                                    provider.instanceId,
                                    model.slug,
                                  );
                                  const key = modelIdentityKey(selection);
                                  const isChecked = selectedKeys.has(key);
                                  return (
                                    <button
                                      key={key}
                                      type="button"
                                      data-compare-model-option={`${provider.instanceId}:${model.slug}`}
                                      aria-pressed={isChecked}
                                      disabled={!isChecked && !canToggleMore}
                                      onClick={() => toggleModel(selection)}
                                      className={cn(
                                        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                                        isChecked
                                          ? "border-primary/50 bg-primary/12 text-foreground"
                                          : "border-border/70 bg-card text-muted-foreground hover:border-border hover:text-foreground disabled:opacity-40",
                                      )}
                                    >
                                      {isChecked ? (
                                        <CheckIcon className="size-3 text-primary" />
                                      ) : null}
                                      <span>{getDisplayModelName(model)}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>

            {isGitRepo && baseBranch !== null ? (
              <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border/70 bg-card px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-foreground">
                      <T>Separate worktree per model</T>
                    </div>
                    <div className="truncate text-2xs text-muted-foreground">
                      <T>
                        Branch each contender from <Var>{baseBranch}</Var> so code edits never
                        collide.
                      </T>
                    </div>
                  </div>
                </div>
                <Switch checked={useWorktrees} onCheckedChange={setUseWorktrees} />
              </label>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="compare-initial-prompt"
                className="text-xs font-medium text-foreground"
              >
                <T>First prompt (optional)</T>
              </label>
              <Textarea
                id="compare-initial-prompt"
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder={gt(
                  "Send this prompt to all selected models right away, or leave blank to type in each column…",
                )}
                rows={3}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canSubmit) {
                    event.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
            </div>

            {errorMessage ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            <T>Cancel</T>
          </Button>
          <Button
            data-testid="compare-start-confirm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? <Spinner size="xs" /> : <Columns2Icon className="size-3.5" />}
            <T>
              Compare <Var>{selected.length}</Var> models
            </T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
