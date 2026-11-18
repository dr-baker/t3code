import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { getProviderOptionDescriptors, rewriteCouncilSeats } from "@t3tools/shared/model";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { serverEnvironment } from "../../state/server";
import { buildModelOptions } from "../../lib/modelOptions";
import { SettingsSection } from "./components/SettingsSection";

export function MobileRewriteCouncil({
  environmentId,
  council,
  disabled,
  onChange,
}: {
  environmentId: EnvironmentId;
  council: ReadonlyArray<ModelSelection>;
  disabled: boolean;
  onChange: (value: ReadonlyArray<ModelSelection>) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const options = buildModelOptions(config, null, undefined, null).filter(
    (o) => !o.isUnavailable && !o.isHidden,
  );
  const actions = options.map((o) => ({ id: o.key, title: o.providerLabel + " · " + o.label }));
  function select(key: string, index: number) {
    const model = options.find((o) => o.key === key);
    if (model && !disabled)
      onChange(
        index === council.length
          ? [...council, model.selection]
          : council.map((seat, i) => (i === index ? model.selection : seat)),
      );
  }
  return (
    <SettingsSection title="Rewrite council">
      <View
        className="gap-2 px-3 py-2"
        pointerEvents={disabled ? "none" : "auto"}
        accessibilityState={{ disabled }}
      >
        {rewriteCouncilSeats(council).map(({ selection: seat, key }, index) => {
          const option = options.find(
            (o) => o.selection.instanceId === seat.instanceId && o.selection.model === seat.model,
          );
          const descriptors = option?.capabilities
            ? getProviderOptionDescriptors({ caps: option.capabilities, selections: seat.options })
            : [];
          return (
            <View key={key} className="flex-row flex-wrap items-center gap-2">
              <Menu
                actions={actions}
                onPressAction={({ nativeEvent }) => select(nativeEvent.event, index)}
              >
                <Pressable accessibilityRole="button" className="rounded-full bg-subtle px-3 py-2">
                  <Text className="text-foreground">{option?.label ?? seat.model}</Text>
                </Pressable>
              </Menu>
              {descriptors.map((d) =>
                d.type === "select" ? (
                  <Menu
                    key={d.id}
                    actions={d.options
                      .filter((c) => !d.promptInjectedValues?.includes(c.id))
                      .map((c) => ({ id: c.id, title: c.label }))}
                    onPressAction={({ nativeEvent }) =>
                      onChange(
                        council.map((s, i) =>
                          i === index
                            ? {
                                ...s,
                                options: [
                                  ...(s.options ?? []).filter((o) => o.id !== d.id),
                                  { id: d.id, value: nativeEvent.event },
                                ],
                              }
                            : s,
                        ),
                      )
                    }
                  >
                    <Pressable
                      accessibilityRole="button"
                      className="rounded-full bg-subtle px-3 py-2"
                    >
                      <Text className="text-foreground">
                        {d.label} ·{" "}
                        {d.options.find((o) => o.id === d.currentValue)?.label ?? "Default"}
                      </Text>
                    </Pressable>
                  </Menu>
                ) : null,
              )}
              <Button
                label="Remove"
                accessibilityLabel={"Remove " + seat.model}
                size="compact"
                tone="text"
                disabled={disabled}
                onPress={() => onChange(council.filter((_, i) => i !== index))}
              />
            </View>
          );
        })}
        <Menu
          actions={actions}
          onPressAction={({ nativeEvent }) => select(nativeEvent.event, council.length)}
        >
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            className="self-start px-3 py-2"
          >
            <Text className="text-primary-text">Add model</Text>
          </Pressable>
        </Menu>
      </View>
    </SettingsSection>
  );
}
