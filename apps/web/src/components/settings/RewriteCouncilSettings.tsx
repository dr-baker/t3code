import type { EnvironmentId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  createModelSelection,
  pickModelSelection,
  rewriteCouncilSeats,
} from "@t3tools/shared/model";
import { PlusIcon, XIcon } from "lucide-react";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  providerInstanceEntriesFor,
  resolveDefaultProviderModelSelection,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";

export function RewriteCouncilSettings({
  environmentId,
  providers,
}: {
  environmentId: EnvironmentId | null;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const settings = useScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["rewriteCouncil"]);
  const canWrite = useScopedSettingsWriteAllowed();
  const multipleEnvironments = connectedEnvironments.length > 1;
  const disabled = multipleEnvironments || !canWrite;
  const update = useUpdateScopedSettings();
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const disabledReason = useScopedModelDisabledReason(settings, entries);
  const council = settings.rewriteCouncil ?? [];
  const defaultSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.defaultModelSelection,
  );
  const save = (rewriteCouncil: ReadonlyArray<ModelSelection>) => update({ rewriteCouncil });
  const replace = (index: number, selection: ModelSelection) =>
    save(council.map((seat, i) => (i === index ? selection : seat)));
  return (
    <SettingsSection title="Rewrites">
      <SettingsRow
        serverScoped
        settingKeys={["rewriteCouncil"]}
        mixed={mixed}
        status={
          multipleEnvironments
            ? mixed
              ? "Council settings differ across environments. Select an environment to edit its council."
              : "Select an environment to configure its council."
            : undefined
        }
        {...searchableSetting("rewrite-council")}
        description="Each member writes an independent answer when you choose Rewrites on a finished turn."
        control={
          <div className="flex flex-col items-start gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !defaultSelection}
              onClick={() => !disabled && defaultSelection && save([...council, defaultSelection])}
            >
              <PlusIcon />
              Add model
            </Button>
            {!multipleEnvironments &&
              rewriteCouncilSeats(council).map(({ selection: seat, key }, index) => {
                const entry = entries.find((candidate) => candidate.instanceId === seat.instanceId);
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2 py-1">
                    <ProviderModelPicker
                      disabled={disabled}
                      environmentId={environmentId}
                      activeInstanceId={seat.instanceId}
                      model={seat.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        seat.instanceId,
                        seat.model,
                      )}
                      getModelDisabledReason={disabledReason}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onInstanceModelChange={(instance, model) =>
                        replace(index, pickModelSelection(seat, instance, model))
                      }
                    />
                    {entry && (
                      <TraitsPicker
                        disabled={disabled}
                        provider={entry.driverKind}
                        models={entry.models}
                        model={seat.model}
                        modelOptions={seat.options ?? []}
                        allowPromptInjectedEffort={false}
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        onModelOptionsChange={(options) =>
                          replace(index, createModelSelection(seat.instanceId, seat.model, options))
                        }
                      />
                    )}
                    <Button
                      variant="ghost-muted"
                      size="icon-xs"
                      disabled={disabled}
                      aria-label={`Remove ${seat.model} from council`}
                      onClick={() => save(council.filter((_, i) => i !== index))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
          </div>
        }
      />
    </SettingsSection>
  );
}
