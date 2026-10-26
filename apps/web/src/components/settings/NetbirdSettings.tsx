import type { DesktopNetbirdConfigureInput, DesktopNetbirdState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeStatus(state: DesktopNetbirdState): string {
  switch (state.status) {
    case "off":
      return "Join your NetBird network without admin rights. Only this app's connections to NetBird addresses use it.";
    case "starting":
      return "Connecting…";
    case "connected":
      return state.ip ? `Connected as ${state.ip.split("/")[0]}.` : "Connected.";
    case "error":
      return "Not connected.";
  }
}

export function NetbirdSettings() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.netbird;
  const [state, setState] = useState<DesktopNetbirdState | null>(null);
  const [managementUrl, setManagementUrl] = useState("");
  const [binaryPath, setBinaryPath] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [pending, setPending] = useState(false);

  // oxlint-disable-next-line t3code/react-effect-budget -- desktop state lives in the main process; read it once when the section mounts
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setManagementUrl(next.managementUrl);
        setBinaryPath(next.binaryPath);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge || !state) return null;

  const configure = (enabled: boolean) => {
    if (pending) return;
    const input: DesktopNetbirdConfigureInput = {
      enabled,
      managementUrl,
      binaryPath,
      ...(setupKey.trim() ? { setupKey: setupKey.trim() } : {}),
    };
    setPending(true);
    setState({ ...state, enabled, status: enabled ? "starting" : "off", error: null });
    void bridge
      .configure(input)
      .then((next) => {
        setState(next);
        if (next.registered) setSetupKey("");
      })
      .catch((error: unknown) =>
        setState({
          ...state,
          status: "error",
          error: error instanceof Error ? error.message : "Something went wrong.",
        }),
      )
      .finally(() => setPending(false));
  };

  const canConnect = managementUrl.trim().length > 0 && (state.registered || setupKey.trim());

  return (
    <SettingsSection {...searchableSetting("netbird")}>
      <SettingsRow
        title="NetBird"
        description={describeStatus(state)}
        status={state.error ? <span className="block text-destructive">{state.error}</span> : null}
        control={
          <Switch
            checked={state.enabled}
            disabled={pending || (!state.enabled && !canConnect)}
            onCheckedChange={configure}
            aria-label="Connect to NetBird"
          />
        }
      >
        <form
          className="grid gap-3 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canConnect) configure(true);
          }}
        >
          <fieldset disabled={pending} className="contents">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="netbird-management-url">Management URL</Label>
                <Input
                  id="netbird-management-url"
                  size="sm"
                  autoComplete="off"
                  placeholder="https://netbird.example.com"
                  value={managementUrl}
                  onChange={(event) => setManagementUrl(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="netbird-setup-key">Setup key</Label>
                <SecretInput
                  id="netbird-setup-key"
                  size="sm"
                  configured={state.registered}
                  placeholder="Needed once to register this device"
                  value={setupKey}
                  onChange={(event) => setSetupKey(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="netbird-binary-path">NetBird binary</Label>
              <Input
                id="netbird-binary-path"
                size="sm"
                autoComplete="off"
                spellCheck={false}
                placeholder="netbird on your PATH, or the full path to netbird.exe"
                value={binaryPath}
                onChange={(event) => setBinaryPath(event.target.value)}
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" size="xs" disabled={!canConnect || pending}>
                {state.enabled ? "Reconnect" : "Connect"}
              </Button>
            </div>
          </fieldset>
        </form>
        {state.status === "connected" && state.peers.length > 0 ? (
          <ul className="grid gap-1 pt-3 text-xs">
            {state.peers.map((peer) => (
              <li key={peer.ip} className="flex justify-between gap-3">
                <span className={peer.connected ? undefined : "text-muted-foreground"}>
                  {peer.name}
                </span>
                <code className="text-muted-foreground">{peer.ip}</code>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
