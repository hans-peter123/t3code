import type { DesktopNetbirdConfigureInput, DesktopNetbirdState } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { buildNetbirdPacScript, parseNetbirdStatus, type NetbirdStatus } from "./netbirdStatus.ts";

const LOOPBACK = "127.0.0.1";
// Away from NetBird's own defaults (41731, 1080) so an installed client or
// another local proxy keeps working next to this one.
const PREFERRED_DAEMON_PORT = 41739;
const PREFERRED_SOCKS_PORT = 41080;
const DAEMON_READY_TIMEOUT = Duration.seconds(15);
const UP_TIMEOUT = Duration.seconds(90);
const STATUS_TIMEOUT = Duration.seconds(10);
const ADDRESS_WAIT_TIMEOUT = Duration.seconds(30);

export class DesktopNetbirdError extends Schema.TaggedError<DesktopNetbirdError>()(
  "DesktopNetbirdError",
  { message: Schema.String },
) {}

const NetbirdSettings = Schema.Struct({
  enabled: Schema.Boolean,
  binaryPath: Schema.String,
  managementUrl: Schema.String,
  registered: Schema.Boolean,
});
type NetbirdSettings = typeof NetbirdSettings.Type;
const NetbirdSettingsJson = fromLenientJson(NetbirdSettings);
const decodeNetbirdSettings = Schema.decodeEffect(NetbirdSettingsJson);
const encodeNetbirdSettings = Schema.encodeEffect(NetbirdSettingsJson);

const DEFAULT_SETTINGS: NetbirdSettings = {
  enabled: false,
  binaryPath: "",
  managementUrl: "",
  registered: false,
};

interface Daemon {
  readonly scope: Scope.Closeable;
  readonly binary: string;
  readonly daemonAddr: string;
}

interface Runtime {
  readonly status: DesktopNetbirdState["status"];
  readonly error: string | null;
  readonly daemon: Option.Option<Daemon>;
}

const OFF: Runtime = { status: "off", error: null, daemon: Option.none() };

export class DesktopNetbird extends Context.Service<
  DesktopNetbird,
  {
    readonly state: Effect.Effect<DesktopNetbirdState>;
    readonly configure: (
      input: DesktopNetbirdConfigureInput,
    ) => Effect.Effect<DesktopNetbirdState, DesktopNetbirdError>;
    /** Reconnects a peer that was enabled when the app last quit. */
    readonly startFromSettings: Effect.Effect<void>;
  }
>()("@t3tools/desktop/netbird/DesktopNetbird") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const layerScope = yield* Effect.scope;
  const path = environment.path;
  const directory = path.join(environment.stateDir, "netbird");
  const settingsPath = path.join(directory, "settings.json");
  const fail = (message: string) => new DesktopNetbirdError({ message });

  const settingsRef = yield* Ref.make(
    yield* fs.readFileString(settingsPath).pipe(
      Effect.flatMap(decodeNetbirdSettings),
      Effect.orElseSucceed(() => DEFAULT_SETTINGS),
    ),
  );
  const runtimeRef = yield* Ref.make(OFF);
  const mutex = yield* Semaphore.make(1);

  const saveSettings = Effect.fn("DesktopNetbird.saveSettings")(
    function* (settings: NetbirdSettings) {
      yield* Ref.set(settingsRef, settings);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(settingsPath, `${yield* encodeNetbirdSettings(settings)}\n`);
    },
    Effect.mapError(() => fail("Could not save the NetBird settings.")),
  );

  const resolveBinary = (settings: NetbirdSettings) =>
    settings.binaryPath.trim() || (environment.platform === "win32" ? "netbird.exe" : "netbird");

  const runCli = (daemon: Daemon, args: ReadonlyArray<string>, timeout: Duration.Input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(daemon.binary, [...args, "--daemon-addr", daemon.daemonAddr], {
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      }),
    ).pipe(
      Effect.mapError(() => fail(`Could not run ${daemon.binary}.`)),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(fail(`netbird ${args[0]} timed out.`)),
      }),
    );

  const readStatus = (daemon: Daemon) =>
    runCli(daemon, ["status", "--json"], STATUS_TIMEOUT).pipe(
      Effect.map((result) => parseNetbirdStatus(result.stdout)),
    );

  const setProxy = (config: Electron.ProxyConfig) =>
    Effect.tryPromise({
      try: () => Electron.session.defaultSession.setProxy(config),
      catch: () => fail("Could not route NetBird addresses through the proxy."),
    });

  const stop = Effect.gen(function* () {
    const runtime = yield* Ref.getAndSet(runtimeRef, OFF);
    if (Option.isNone(runtime.daemon)) return;
    yield* setProxy({ mode: "system" }).pipe(Effect.ignore);
    // Closing the scope terminates the daemon; netstack mode leaves no
    // adapter, route or DNS change behind on the host.
    yield* Scope.close(runtime.daemon.value.scope, Exit.void);
  }).pipe(Effect.withSpan("DesktopNetbird.stop"));

  const start = Effect.fn("DesktopNetbird.start")(function* (
    settings: NetbirdSettings,
    setupKey: Option.Option<string>,
  ) {
    yield* stop;
    if (settings.managementUrl.trim().length === 0) {
      return yield* fail("Enter the URL of your NetBird management server.");
    }
    if (!settings.registered && Option.isNone(setupKey)) {
      return yield* fail("This device is not registered yet. Enter a setup key.");
    }

    const daemonPort = yield* net
      .findAvailablePort(PREFERRED_DAEMON_PORT)
      .pipe(Effect.mapError(() => fail("No free local port for the NetBird daemon.")));
    const socksPort = yield* net
      .findAvailablePort(PREFERRED_SOCKS_PORT)
      .pipe(Effect.mapError(() => fail("No free local port for the NetBird proxy.")));
    const stateDirectory = path.join(directory, "state");
    yield* fs
      .makeDirectory(stateDirectory, { recursive: true })
      .pipe(Effect.mapError(() => fail(`Could not create ${stateDirectory}.`)));

    const scope = yield* Scope.fork(layerScope, "sequential");
    const daemon: Daemon = {
      scope,
      binary: resolveBinary(settings),
      daemonAddr: `tcp://${LOOPBACK}:${daemonPort}`,
    };
    yield* Ref.set(runtimeRef, { status: "starting", error: null, daemon: Option.some(daemon) });

    // Netstack mode runs WireGuard in userspace, so no TUN driver and no admin
    // rights are needed. The price is that only traffic sent through its SOCKS
    // proxy reaches the NetBird network.
    yield* spawner
      .spawn(
        ChildProcess.make(
          daemon.binary,
          [
            "service",
            "run",
            "--daemon-addr",
            daemon.daemonAddr,
            "--config",
            path.join(directory, "config.json"),
            "--log-file",
            path.join(directory, "daemon.log"),
          ],
          {
            env: {
              NB_USE_NETSTACK_MODE: "true",
              NB_SOCKS5_LISTENER_PORT: String(socksPort),
              NB_STATE_DIR: stateDirectory,
            },
            extendEnv: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            killSignal: "SIGTERM",
            forceKillAfter: Duration.seconds(3),
          },
        ),
      )
      .pipe(
        Scope.provide(scope),
        Effect.mapError(() =>
          fail(`Could not start ${daemon.binary}. Check the path to the NetBird binary.`),
        ),
      );

    yield* net.hasListenerOnHost(daemonPort, LOOPBACK).pipe(
      Effect.flatMap((listening) => (listening ? Effect.void : Effect.fail(fail("not ready")))),
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(250)) }),
      Effect.timeoutOrElse({
        duration: DAEMON_READY_TIMEOUT,
        orElse: () =>
          Effect.fail(fail(`The NetBird daemon did not start. See ${directory}/daemon.log.`)),
      }),
    );

    const up = yield* runCli(
      daemon,
      [
        "up",
        "--management-url",
        settings.managementUrl.trim(),
        "--disable-dns",
        ...Option.match(setupKey, { onNone: () => [], onSome: (key) => ["--setup-key", key] }),
      ],
      UP_TIMEOUT,
    );
    if (up.exitCode !== 0) {
      return yield* fail(
        (up.stderr || up.stdout).trim() || `netbird up exited with ${up.exitCode}.`,
      );
    }
    if (!settings.registered) yield* saveSettings({ ...settings, registered: true });

    const status = yield* readStatus(daemon).pipe(
      Effect.flatMap((parsed) =>
        Option.isSome(parsed) && parsed.value.ip !== null
          ? Effect.succeed(parsed.value)
          : Effect.fail(fail("NetBird has no address yet.")),
      ),
      Effect.retry({ schedule: Schedule.spaced(Duration.seconds(1)) }),
      Effect.timeoutOrElse({
        duration: ADDRESS_WAIT_TIMEOUT,
        orElse: () => Effect.fail(fail("NetBird connected but never received an address.")),
      }),
    );
    const pacScript = buildNetbirdPacScript(status.ip ?? "", socksPort);
    if (Option.isNone(pacScript)) {
      return yield* fail(`Unexpected NetBird address ${status.ip}.`);
    }
    yield* setProxy({
      mode: "pac_script",
      pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacScript.value).toString("base64")}`,
    });
    yield* Ref.set(runtimeRef, { status: "connected", error: null, daemon: Option.some(daemon) });
  });

  const startRecordingFailure = (settings: NetbirdSettings, setupKey: Option.Option<string>) =>
    start(settings, setupKey).pipe(
      Effect.tapError((error) =>
        stop.pipe(
          Effect.andThen(Ref.set(runtimeRef, { ...OFF, status: "error", error: error.message })),
        ),
      ),
    );

  const state = Effect.gen(function* () {
    const settings = yield* Ref.get(settingsRef);
    const runtime = yield* Ref.get(runtimeRef);
    const status: Option.Option<NetbirdStatus> =
      runtime.status === "connected" && Option.isSome(runtime.daemon)
        ? yield* readStatus(runtime.daemon.value).pipe(Effect.orElseSucceed(() => Option.none()))
        : Option.none();
    return {
      enabled: settings.enabled,
      binaryPath: settings.binaryPath,
      managementUrl: settings.managementUrl,
      registered: settings.registered,
      status: runtime.status,
      error: runtime.error,
      ip: Option.match(status, { onNone: () => null, onSome: (value) => value.ip }),
      peers: Option.match(status, { onNone: () => [], onSome: (value) => value.peers }),
    } satisfies DesktopNetbirdState;
  }).pipe(Effect.withSpan("DesktopNetbird.state"));

  const configure = Effect.fn("DesktopNetbird.configure")(function* (
    input: DesktopNetbirdConfigureInput,
  ) {
    const previous = yield* Ref.get(settingsRef);
    const managementUrl = input.managementUrl.trim();
    const settings: NetbirdSettings = {
      enabled: input.enabled,
      binaryPath: input.binaryPath.trim(),
      managementUrl,
      // A different management server needs a fresh registration.
      registered: previous.registered && previous.managementUrl === managementUrl,
    };
    yield* saveSettings(settings);
    const setupKey = Option.fromNullishOr(input.setupKey?.trim() || undefined);
    // A failed start is reported through state.error, next to the form.
    yield* mutex
      .withPermits(1)(settings.enabled ? startRecordingFailure(settings, setupKey) : stop)
      .pipe(Effect.ignore);
    return yield* state;
  });

  yield* Effect.addFinalizer(() => stop);

  return DesktopNetbird.of({
    state,
    configure,
    startFromSettings: Effect.gen(function* () {
      const settings = yield* Ref.get(settingsRef);
      if (!settings.enabled) return;
      yield* mutex
        .withPermits(1)(startRecordingFailure(settings, Option.none()))
        .pipe(Effect.ignore);
    }).pipe(Effect.withSpan("DesktopNetbird.startFromSettings")),
  });
});

export const layer = Layer.effect(DesktopNetbird, make);
