import type { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import * as Equal from "effect/Equal";

import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function SpokenSummaryModelSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const providers = serverProviders.filter((provider) => provider.supportsTextGeneration !== false);
  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    target?.projectId ?? null,
  );
  const selection = settings.spokenSummaryModelSelection;
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const mixed = useScopedSettingsMixed(["spokenSummaryModelSelection"]);
  const isDirty = !Equal.equals(selection, DEFAULT_UNIFIED_SETTINGS.spokenSummaryModelSelection);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["spokenSummaryModelSelection"]}
      {...searchableSetting("spoken-summary-model")}
      description="Writes the short spoken version of a reply when one is read aloud. It reads the whole thread, so a stronger model helps. Runs on this provider's subscription."
      resetAction={
        connectedEnvironments.length > 0 && isDirty ? (
          <SettingResetButton
            label="spoken summary model"
            onClick={() =>
              updateSettings({
                spokenSummaryModelSelection: DEFAULT_UNIFIED_SETTINGS.spokenSummaryModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to choose its spoken summary model.
          </span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Spoken summary model"
              {...(mixed ? { triggerLabel: "Mixed" } : {})}
              getModelDisabledReason={disabledReason}
              {...(environmentId
                ? {
                    onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                      void navigate({
                        to: "/settings/providers",
                        search: { environmentId, instanceId },
                      });
                    },
                  }
                : {})}
              onInstanceModelChange={(instanceId, model) => {
                const reason = disabledReason(instanceId, model);
                if (reason) {
                  toastManager.add({
                    type: "error",
                    title: "Spoken summary model not saved",
                    description: reason,
                  });
                  return;
                }
                updateSettings({
                  spokenSummaryModelSelection: createModelSelection(instanceId, model),
                });
              }}
            />
            {instanceEntry && !mixed ? (
              <TraitsPicker
                provider={instanceEntry.driverKind}
                models={instanceEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={settings.planModeEnabled || selectsPlanAgent(selection.options)}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    spokenSummaryModelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
          </div>
        )
      }
    />
  );
}
