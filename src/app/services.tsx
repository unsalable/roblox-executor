import { createContext, useContext, type ReactNode } from "react";
import { bindDevToolsToTarget } from "@/app/devTools";
import { createBackendController, type BackendController } from "@/features/backend/backendController";
import { isLocalMockDeveloperBackend } from "@/features/backend/backends/LocalMockDeveloperBackend";
import { backendRegistry } from "@/features/backend/backends/registry";
import {
  createUnsupportedDebuggerProvider,
  createUnsupportedProfilerProvider,
  createUnsupportedTargetProvider,
} from "@/features/backend/providers/unsupported";
import { isBackendReady } from "@/features/backend/backendState";
import type { BackendDescriptor, DeveloperBackend } from "@/features/backend/types";
import { createDebuggerController, type DebuggerController } from "@/features/debugger/debuggerController";
import { loadBreakpoints, saveBreakpoints } from "@/features/debugger/persistence";
import { createDiagnosticLog } from "@/features/diagnostics/diagnostics";
import { createExecutionController, type ExecutionController } from "@/features/execution/executionController";
import { createExplorerController, type ExplorerController } from "@/features/explorer/explorerController";
import { createMockExplorerProvider } from "@/features/explorer/providers/MockExplorerProvider";
import { createProfilerController, type ProfilerController } from "@/features/profiler/profilerController";
import {
  createLocalTestExecutionProvider,
  LOCAL_TEST_EXECUTION_SCENARIOS,
  type LocalTestExecutionScenario,
} from "@/features/execution/providers/LocalTestExecutionProvider";
import {
  LOCAL_TEST_AVAILABILITY,
  LOCAL_TEST_INJECT_SCENARIOS,
  type LocalTestAvailability,
  type LocalTestInjectScenario,
} from "@/features/target/providers/LocalTestTargetProvider";
import { createTargetController, type TargetController } from "@/features/target/targetController";
import { createTauriUpdateProvider } from "@/features/updates/providers/TauriUpdateProvider";
import { createUpdateController, type UpdateController } from "@/features/updates/updateController";
import { isTargetInjected } from "@/features/target/targetState";
import { loadSettings } from "@/lib/storage";

/** A developer switch offered by a local test provider. */
export interface SimulationControl {
  label: string;
  options: readonly { value: string; label: string }[];
  get: () => string;
  set: (value: string) => void;
}

export interface AppServices {
  execution: ExecutionController;
  target: TargetController;
  /** The developer Explorer: its hierarchy, the shared developer selection and expansion. */
  explorer: ExplorerController;
  /** The developer Debugger: its session, breakpoints, stack, variables and watches. */
  debug: DebuggerController;
  /** The developer Profiler: its recording, samples and session history. */
  profiler: ProfilerController;
  /** The developer backend the three tool providers come from: its lifecycle, capabilities and health. */
  backend: BackendController;
  /**
   * Nova updating itself from its own releases. It is not a developer tool and
   * has no provider from the backend: it is the application's own lifecycle,
   * and the only thing in Nova that reaches the network.
   */
  updates: UpdateController;
  /**
   * Every backend this build could run on, as identity only. The settings picker
   * reads this instead of the registry, so no view can reach a backend — let
   * alone a provider — even by accident.
   */
  backends: readonly BackendDescriptor[];
  /**
   * Test-only outcome switches, one group per provider boundary that offers them.
   * A group is null when the provider behind it is not a local simulation, so a
   * real backend hides its target switches without hiding the execution one.
   */
  simulation: {
    target: { availability: SimulationControl; inject: SimulationControl } | null;
    execution: SimulationControl | null;
  };
  /** Releases the providers: the session is ended and nothing outlives the window. */
  shutdown: () => Promise<void>;
}

function pick<T extends string>(options: readonly { value: T }[], value: string): T | undefined {
  return options.find((option) => option.value === value)?.value;
}

/**
 * The composition root for the developer backend, the providers and the
 * controllers — and the boundary the rest of the application never bypasses: the
 * UI talks to the controllers, reads provider and backend metadata, and never
 * holds a provider or a backend implementation.
 *
 * ```text
 * Nova UI → controllers → provider interfaces → backend (adapter) → providers
 * ```
 *
 * The backend hands its providers over once, here, and the controllers are built
 * on them once. Starting and stopping the backend afterwards changes whether
 * those providers can be used — never which objects they are — so a restart
 * leaves the editor, the open scripts and the breakpoints exactly where they
 * were.
 *
 * Two backends ship. The **Local Mock** is the default and every provider under
 * it is a simulation; the **Local Service** is real — it talks to a service in
 * Nova's own process over the application's IPC — and supplies a target only.
 * Neither leaves Nova: nothing here opens a socket, reads another process or
 * runs anything.
 */
export function createAppServices(): AppServices {
  const backendLog = createDiagnosticLog("Backend", "backendController");
  const settings = loadSettings();

  const resolution = backendRegistry.resolve(settings.developer.backendId);
  if (resolution.status === "fallback") {
    backendLog.warn(
      `This build has no "${resolution.requestedId}" developer backend; falling back to ${resolution.registration.descriptor.label}`,
      `Requested: ${resolution.requestedId}`,
    );
  }
  const developerBackend: DeveloperBackend = resolution.registration.create();
  const backendLabel = developerBackend.descriptor.label;

  /**
   * A tool the backend does not supply still gets a provider, so the panels and
   * the Explorer do not disappear with it — one that refuses every operation with
   * a structured error instead of reporting a success that did not happen.
   */
  const targetProvider = developerBackend.providers.target ?? createUnsupportedTargetProvider(backendLabel);
  const debuggerProvider = developerBackend.providers.debugger ?? createUnsupportedDebuggerProvider(backendLabel);
  const profilerProvider = developerBackend.providers.profiler ?? createUnsupportedProfilerProvider(backendLabel);

  const backend = createBackendController({
    backend: developerBackend,
    // Read when it is used, so changing it in Settings does not need a restart.
    policy: () => loadSettings().developer,
    log: backendLog,
  });

  const executionProvider = createLocalTestExecutionProvider();
  const explorer = createExplorerController({ provider: createMockExplorerProvider() });

  const debug = createDebuggerController({
    provider: debuggerProvider,
    // Breakpoints are local configuration and are restored; no session state is.
    breakpoints: loadBreakpoints(),
    onBreakpointsChanged: (breakpoints) => void saveBreakpoints(breakpoints),
    log: createDiagnosticLog("Debugger", "debuggerController"),
  });

  const profiler = createProfilerController({
    provider: profilerProvider,
    log: createDiagnosticLog("Profiler", "profilerController"),
  });

  const target = createTargetController({
    provider: targetProvider,
    // Read when it is used, so changing it in Settings does not need a restart.
    policy: () => loadSettings().target,
    // The controllers keep their own messages; they are only tagged on the way
    // out, so the console can tell a target line from an execution one.
    log: createDiagnosticLog("Target", "targetController"),
  });

  const updates = createUpdateController({
    provider: createTauriUpdateProvider(),
    // Read when it is used, so changing it in Settings does not need a restart.
    policy: () => loadSettings().updates,
    log: createDiagnosticLog("Updates", "updateController"),
  });

  const execution = createExecutionController({
    provider: executionProvider,
    // Execution needs an injected target, not merely a detected one.
    isTargetReady: () => isTargetInjected(target.getSnapshot().status),
    log: createDiagnosticLog("Execution", "executionController"),
  });

  /**
   * The one link between the two controllers: an execution in flight cannot
   * outlive the target it runs on, so losing the target ends it with
   * `TARGET_DISCONNECTED` instead of leaving it to time out.
   */
  let wasInjected = isTargetInjected(target.getSnapshot().status);
  const unwatchTarget = target.subscribe(() => {
    const injected = isTargetInjected(target.getSnapshot().status);
    if (wasInjected && !injected) {
      execution.interrupt({
        code: "TARGET_DISCONNECTED",
        message: "The target was lost while the script was running.",
        details: `Provider: ${target.provider.label}`,
      });
    }
    wasInjected = injected;
  });

  /**
   * The target provider's health depends on whether a target is visible, so the
   * backend is asked again whenever that changes. Without this the Developer
   * Status panel could show "Healthy" beside a Target row that says the target is
   * gone — two answers to one question, on one screen.
   */
  const unwatchHealth = target.subscribe(() => backend.refreshCapabilities());

  /**
   * The developer tools follow the backend's readiness, the target's presence and
   * what the backend supplies — three separate facts, resolved in one place; see
   * `app/devTools.ts`. They hold no backend or target state of their own.
   */
  const { capabilities } = backend.getSnapshot();
  const unbindDevTools = bindDevToolsToTarget({
    target: { getStatus: () => target.getSnapshot().status, subscribe: target.subscribe },
    backend: { isReady: () => isBackendReady(backend.getSnapshot().state), subscribe: backend.subscribe },
    supports: { debugger: capabilities.debugger.canDebug, profiler: capabilities.profiler.canProfile },
    debug,
    profiler,
  });

  /**
   * The simulated target's own test switches, offered only while the active
   * backend is the local mock. A real backend has none, and `simulation` is null.
   */
  const testSwitches = isLocalMockDeveloperBackend(developerBackend) ? developerBackend.testSwitches : null;

  return {
    execution,
    target,
    explorer,
    debug,
    profiler,
    backend,
    updates,
    backends: backendRegistry.descriptors,
    simulation: {
      // The target switches belong to the backend, and only a simulated one has
      // them. The execution switch does not: the execution provider is its own
      // boundary and is a simulation whichever backend is active, so gating it on
      // the backend would hide a switch that still works.
      target:
        testSwitches === null
          ? null
          : {
              availability: {
                label: "Target availability",
                options: LOCAL_TEST_AVAILABILITY,
                get: testSwitches.getAvailability,
                set: (value) => {
                  const availability = pick<LocalTestAvailability>(LOCAL_TEST_AVAILABILITY, value);
                  if (availability) testSwitches.setAvailability(availability);
                },
              },
              inject: {
                label: "Inject result",
                options: LOCAL_TEST_INJECT_SCENARIOS,
                get: testSwitches.getScenario,
                set: (value) => {
                  const scenario = pick<LocalTestInjectScenario>(LOCAL_TEST_INJECT_SCENARIOS, value);
                  if (scenario) testSwitches.setScenario(scenario);
                },
              },
            },
      execution: {
        label: "Execution outcome",
        options: LOCAL_TEST_EXECUTION_SCENARIOS,
        get: executionProvider.getScenario,
        set: (value) => {
          const scenario = pick<LocalTestExecutionScenario>(LOCAL_TEST_EXECUTION_SCENARIOS, value);
          if (scenario) executionProvider.setScenario(scenario);
        },
      },
    },
    shutdown: async () => {
      updates.dispose();
      unwatchTarget();
      unwatchHealth();
      unbindDevTools();
      profiler.dispose();
      debug.dispose();
      explorer.dispose();
      execution.dispose();
      await target.disconnect().catch(() => undefined);
      target.dispose();
      // Last: the backend owns the providers everything above was built on.
      await backend.stop().catch(() => undefined);
      backend.dispose();
    },
  };
}

const AppServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <AppServicesContext.Provider value={services}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const services = useContext(AppServicesContext);
  if (!services) throw new Error("useAppServices must be used within AppServicesProvider");
  return services;
}
