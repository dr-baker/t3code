import { createContext } from "react";
import type { ModelSelection, ServerProvider, ThreadId } from "@t3tools/contracts";
import { MODEL_COMPARE_LIMITS } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { createModelSelection } from "@t3tools/shared/model";

export interface CompareBroadcastPayload {
  readonly sourceThreadId: ThreadId;
  readonly text: string;
}

export interface CompareBroadcastControl {
  readonly count: number;
  readonly onBroadcast: (payload: CompareBroadcastPayload) => Promise<boolean>;
}

export interface CompareColumnContextValue {
  readonly broadcast: CompareBroadcastControl;
  readonly rightPanelPortalTarget: HTMLElement | null;
}

export const CompareColumnContext = createContext<CompareColumnContextValue | null>(null);

export function resolveFocusedContenderId(
  contenderIds: ReadonlyArray<ThreadId>,
  currentFocusedId: ThreadId | null,
): ThreadId | null {
  if (contenderIds.length === 0) return null;
  if (currentFocusedId !== null && contenderIds.includes(currentFocusedId)) {
    return currentFocusedId;
  }
  return contenderIds[0] ?? null;
}

export function isBroadcastSubmitShortcut(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  mac: boolean,
): boolean {
  if (event.key !== "Enter" || !event.shiftKey || event.altKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function modelIdentityKey(selection: Pick<ModelSelection, "instanceId" | "model">): string {
  return `${selection.instanceId}::${selection.model}`;
}

export function selectionKey(selection: ModelSelection): string {
  const options =
    selection.options && selection.options.length > 0
      ? selection.options
          .map((option) => `${option.id}=${String(option.value)}`)
          .toSorted()
          .join(",")
      : "";
  return `${selection.instanceId}::${selection.model}::${options}`;
}

export function defaultCompareSelections(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly currentSelection: ModelSelection | null;
  readonly rewriteCouncil?: ReadonlyArray<ModelSelection> | undefined;
  readonly maxDefaults?: number | undefined;
}): ReadonlyArray<ModelSelection> {
  const maxDefaults = Math.min(input.maxDefaults ?? 3, MODEL_COMPARE_LIMITS.maxContenders);
  const availableProviders = input.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.status === "ready" &&
      provider.models.some((model) => !model.isCustom || model.slug.length > 0),
  );
  const providerById = new Map(
    availableProviders.map((provider) => [provider.instanceId, provider] as const),
  );
  const picked: ModelSelection[] = [];
  const seen = new Set<string>();
  const add = (selection: ModelSelection) => {
    if (picked.length >= maxDefaults) return;
    const provider = providerById.get(selection.instanceId);
    if (!provider) return;
    const key = modelIdentityKey(selection);
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(selection);
  };

  if (input.currentSelection) {
    add(input.currentSelection);
  }
  const currentProvider = input.currentSelection
    ? providerById.get(input.currentSelection.instanceId)
    : undefined;
  // When comparing from a Replay (dev) thread, fill from Replay scenarios first instead of paid models.
  if (currentProvider?.instanceId === "devReplay") {
    for (const model of currentProvider.models) {
      add(createModelSelection(currentProvider.instanceId, model.slug));
      if (picked.length >= maxDefaults) break;
    }
    return picked;
  }
  for (const seat of input.rewriteCouncil ?? []) {
    add(seat);
  }
  // Prefer one model from each ready provider first so defaults span providers.
  for (const provider of availableProviders) {
    const firstModel = provider.models[0];
    if (firstModel) {
      add(createModelSelection(provider.instanceId, firstModel.slug));
    }
    if (picked.length >= maxDefaults) break;
  }
  for (const provider of availableProviders) {
    for (const model of provider.models) {
      add(createModelSelection(provider.instanceId, model.slug));
      if (picked.length >= maxDefaults) break;
    }
    if (picked.length >= maxDefaults) break;
  }
  return picked;
}

export interface CompareStageSummary {
  readonly total: number;
  readonly active: number;
  readonly ready: number;
  readonly failed: number;
  readonly needsAttention: number;
}

export function summarizeCompareContenders(
  contenders: ReadonlyArray<EnvironmentThreadShell | null>,
): CompareStageSummary {
  let active = 0;
  let ready = 0;
  let failed = 0;
  let needsAttention = 0;
  for (const shell of contenders) {
    if (!shell) continue;
    if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
      needsAttention += 1;
    }
    if (threadRuntimeIsActive(shell.runtime)) {
      active += 1;
    } else if (shell.latestRun?.status === "failed") {
      failed += 1;
    } else if (shell.latestRun !== null) {
      ready += 1;
    }
  }
  return {
    total: contenders.length,
    active,
    ready,
    failed,
    needsAttention,
  };
}
