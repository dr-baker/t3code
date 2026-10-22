import type { DesktopSettings } from "./DesktopAppSettings.ts";
import { DEFAULT_LINUX_PASSWORD_STORE } from "../linuxSecretStorage.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  localEnvironmentEnabled: true,
  linuxPasswordStore: DEFAULT_LINUX_PASSWORD_STORE,
  mainWindowBounds: null,
  mainWindowMaximized: false,
  serverExposureMode: "local-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
};

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}
