import { useId, useState } from "react";
import { config } from "@/app/config";
import { useAppServices, type SimulationControl } from "@/app/services";
import { useAppStore } from "@/app/store";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/controls";
import { DeveloperStatusPanel } from "@/features/backend/DeveloperStatusPanel";
import { ErrorCallout } from "@/features/errors/ErrorCallout";
import {
  describeExecutionError,
  describeTargetError,
  type ErrorActionId,
} from "@/features/errors/errorPresentation";
import { useExecution } from "@/features/execution/useExecution";
import { executionDescriptor, sessionDescriptor, StatusIndicator, targetDescriptor } from "@/features/status/StatusIndicator";
import { Row, Rows, Section } from "@/features/status/rows";
import { TargetHistoryView } from "@/features/target/TargetHistoryView";
import { useTarget } from "@/features/target/useTarget";

function SimulationSelect({ control }: { control: SimulationControl }) {
  const id = useId();
  const [value, setValue] = useState(control.get);

  return (
    <div className="flex items-center justify-between gap-6 py-1.5">
      <label htmlFor={id} className="text-xs text-foreground">
        {control.label}
      </label>
      <div className="w-52 [&_select]:w-full">
        <Select
          id={id}
          label={control.label}
          value={value}
          options={control.options}
          onChange={(next) => {
            control.set(next);
            setValue(control.get());
          }}
        />
      </div>
    </div>
  );
}

/**
 * Everything here is state Nova itself holds: the configured provider, the
 * status its own controller owns, the session, and the timeouts from Settings.
 * Nothing is read from — or claimed about — another process: there is no
 * process id, memory address, module list or executable path to show, because
 * the application never looks at one.
 */
export function TargetDiagnosticsDialog({
  open,
  onClose,
  onErrorAction,
}: {
  open: boolean;
  onClose: () => void;
  /** Runs the next step an error offers. The dialog decides nothing itself. */
  onErrorAction: (action: ErrorActionId) => void;
}) {
  const { status, session, error, result, diagnostics, provider } = useTarget();
  const { provider: executionProvider, phase, result: executionResult, rejection } = useExecution();
  const { simulation } = useAppServices();
  const { settings } = useAppStore();

  // A refusal is the newest thing that happened when there is one; otherwise
  // the last execution's failure, if it failed.
  const executionError = rejection ?? executionResult?.error ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Developer diagnostics"
      description="Local state only. Nothing here is read from another process."
      widthClassName="max-w-md"
    >
      <div className="min-h-0 overflow-y-auto px-5 py-4">
        <DeveloperStatusPanel />

        <Section title="Target">
          <Rows>
            <Row label="Provider" note={diagnostics.simulated ? "Simulated" : undefined}>
              {diagnostics.provider}
            </Row>
            <Row label="State">
              <StatusIndicator descriptor={targetDescriptor[status]} name="Target" />
            </Row>
            <Row label="Session">
              <StatusIndicator descriptor={sessionDescriptor[session]} name="Session" />
            </Row>
            <Row label="Transport">{diagnostics.transport}</Row>
            <Row label="Latency" note={diagnostics.simulated && diagnostics.latency ? "Test data" : undefined}>
              {diagnostics.latency ?? "—"}
            </Row>
            <Row label="Target version">{diagnostics.targetVersion ?? "—"}</Row>
            <Row label="Inject timeout">{settings.target.injectTimeoutMs} ms</Row>
            <Row label="Cancellation">{provider.supportsCancel ? "Supported" : "Not supported"}</Row>
            <Row label="Last injection">
              {result === null ? "—" : result.success ? `${result.durationMs} ms` : (result.error?.code ?? "Cancelled")}
            </Row>
            <Row label="Nova">{config.version}</Row>
          </Rows>

          {error ? (
            <div className="mt-2">
              <ErrorCallout presentation={describeTargetError(error)} onAction={onErrorAction} />
            </div>
          ) : null}
        </Section>

        <Section title="Target history">
          <TargetHistoryView />
        </Section>

        <Section title="Execution">
          <Rows>
            <Row label="Provider" note={simulation.execution ? "Simulated" : undefined}>
              {executionProvider.label}
            </Row>
            <Row label="State">
              <StatusIndicator descriptor={executionDescriptor[phase]} name="Execution" />
            </Row>
            <Row label="Requires target">{executionProvider.requiresTarget ? "Yes" : "No"}</Row>
            <Row label="Cancellation">{executionProvider.supportsCancel ? "Supported" : "Not supported"}</Row>
            <Row label="Timeout">{settings.executor.timeoutMs} ms</Row>
          </Rows>

          {executionError ? (
            <div className="mt-2">
              <ErrorCallout
                presentation={describeExecutionError(executionError)}
                onAction={onErrorAction}
                tone={rejection ? "warning" : "danger"}
              />
            </div>
          ) : null}
        </Section>

        {simulation.target || simulation.execution ? (
          <section className="mt-4">
            <h3 className="mb-1 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">Simulation controls</h3>
            {/*
              Two separate claims, because they are two separate boundaries: the
              target switches exist only while the target provider is a
              simulation, and the execution one exists whichever backend is
              running. Naming the target provider in one sentence about both
              would call a real provider simulated as soon as there is one.
            */}
            <p className="mb-1 text-[11px] leading-relaxed text-muted">
              {simulation.target
                ? `The ${provider.label} simulates detection and injection inside Nova. `
                : ""}
              Execution is simulated inside Nova whichever backend is running. No game, external process or network
              endpoint is contacted, no code is loaded into anything, and script source is never evaluated. These
              switches choose the simulated outcome of the next attempt and reset when Nova restarts.
              {simulation.target
                ? " Setting the target to Unavailable while a session is active simulates an unexpected disconnect."
                : ""}
            </p>
            {simulation.target ? <SimulationSelect control={simulation.target.availability} /> : null}
            {simulation.target ? <SimulationSelect control={simulation.target.inject} /> : null}
            {simulation.execution ? <SimulationSelect control={simulation.execution} /> : null}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
