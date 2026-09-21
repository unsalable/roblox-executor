import { useAppStore } from "@/app/store";
import { healthOf } from "@/features/backend/capabilities";
import { useBackend } from "@/features/backend/useBackend";
import { useDebugger } from "@/features/debugger/useDebugger";
import { ErrorCallout } from "@/features/errors/ErrorCallout";
import { describeBackendError } from "@/features/errors/errorPresentation";
import { useProfiler } from "@/features/profiler/useProfiler";
import {
  backendDescriptor,
  debugDescriptor,
  healthDescriptor,
  profilerDescriptor,
  StatusIndicator,
  targetDescriptor,
} from "@/features/status/StatusIndicator";
import { Row, Rows, Section } from "@/features/status/rows";
import { useTarget } from "@/features/target/useTarget";

/**
 * Developer Status: which backend Nova is running on, what it supplies, and why
 * anything that is unavailable is unavailable.
 *
 * The three lifecycles are shown on separate rows and never merged into one
 * verdict, because they genuinely differ — a ready backend with no target is
 * ordinary, and so is a target with no debugger behind it. The Health column is
 * the fourth, independent answer: whether the provider itself is in a position to
 * do its job.
 *
 * Everything here is state Nova holds about its own adapter layer. There is no
 * process id, memory address, module list or executable path to show, because no
 * backend in this build looks at one.
 *
 * Read-only by design. The actions that change a backend — restart, re-read the
 * capabilities — live in the command palette, so there is one implementation of
 * each and this panel cannot drift from it.
 */
export function DeveloperStatusPanel() {
  const { backend, state, capabilities, health, providers, error, errorAt, readySince, diagnostics } = useBackend();
  const { settings } = useAppStore();
  const target = useTarget();
  const debug = useDebugger();
  const profiler = useProfiler();

  // Read from the descriptor, never from the backend's name: a second
  // simulated backend must say so too, and a real one must not be labelled.
  const simulated = backend.simulated ? "Simulated" : undefined;
  const supported = (yes: boolean) => (yes ? "Supported" : "Not supported");

  return (
    <>
      <Section title="Developer backend">
        <Rows>
          <Row label="Backend" note={simulated}>
            {backend.label}
          </Row>
          <Row label="Backend id">
            <span className="font-mono text-[11px] text-subtle">{backend.id}</span>
          </Row>
          <Row label="State">
            <StatusIndicator descriptor={backendDescriptor[state]} name="Backend" />
          </Row>
          <Row label="Auto start">{settings.developer.autoStartBackend ? "On" : "Off"}</Row>
          <Row label="Ready since">
            {readySince === null ? "—" : new Date(readySince).toLocaleTimeString()}
          </Row>
          <Row label="Last error">
            {errorAt === null ? "—" : `${error?.code ?? "—"} at ${new Date(errorAt).toLocaleTimeString()}`}
          </Row>
        </Rows>

        {error ? (
          <div className="mt-2">
            <ErrorCallout presentation={describeBackendError(error)} />
          </div>
        ) : null}

        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{backend.description}</p>
      </Section>

      {diagnostics.length > 0 ? (
        <Section title="Backend diagnostics">
          <Rows>
            {diagnostics.map((entry) => (
              <Row key={entry.label} label={entry.label}>
                <span className="truncate font-mono text-[11px] text-subtle">{entry.value}</span>
              </Row>
            ))}
          </Rows>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
            What this backend says about itself. No credential, token or secret is shown here, and none is available to
            this panel to show.
          </p>
        </Section>
      ) : null}

      <Section title="Tools">
        <Rows>
          <Row label="Target">
            <StatusIndicator descriptor={targetDescriptor[target.status]} name="Target" />
          </Row>
          <Row label="Debugger">
            <StatusIndicator descriptor={debugDescriptor[debug.state]} name="Debugger" />
          </Row>
          <Row label="Profiler">
            <StatusIndicator descriptor={profilerDescriptor[profiler.state]} name="Profiler" />
          </Row>
        </Rows>
      </Section>

      <Section title="Providers">
        <Rows>
          {providers.length === 0 ? (
            <Row label="Providers">This backend supplies none.</Row>
          ) : (
            providers.map((provider) => {
              const report = healthOf(health, provider.tool);
              return (
                <Row
                  key={provider.tool}
                  label={provider.label}
                  note={provider.simulated ? "Simulated" : undefined}
                >
                  <span className="truncate text-subtle" title={report.reason ?? provider.description}>
                    {provider.providerType}
                  </span>
                  <StatusIndicator descriptor={healthDescriptor[report.health]} name={provider.label} />
                </Row>
              );
            })
          )}
        </Rows>
      </Section>

      <Section title="Capabilities">
        <Rows>
          <Row label="Attach to a target">{supported(capabilities.target.canConnect)}</Row>
          <Row label="Cancel an injection">{supported(capabilities.target.canCancelInject)}</Row>
          <Row label="Debug a script">{supported(capabilities.debugger.canDebug)}</Row>
          <Row label="Pause a run">{supported(capabilities.debugger.canPause)}</Row>
          <Row label="Record a profile">{supported(capabilities.profiler.canProfile)}</Row>
        </Rows>

        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          A capability says what the backend's providers can do, never whether a target happens to be there right now.
          Anything listed as not supported is refused with a reason instead of being reported as having worked.
        </p>
      </Section>
    </>
  );
}
