import { useId, useState, type ReactNode } from "react";
import { useAppServices } from "@/app/services";
import { config } from "@/app/config";
import { formatBuildId } from "@/app/releaseVersion";
import { useAppStore } from "@/app/store";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Select, Stepper, Toggle } from "@/components/ui/controls";
import { useBackend } from "@/features/backend/useBackend";
import { DiagnosticsList } from "@/features/status/DiagnosticsList";
import { useExecution } from "@/features/execution/useExecution";
import { useTarget } from "@/features/target/useTarget";
import { isUpdateBusy } from "@/features/updates/updateState";
import { useUpdates } from "@/features/updates/useUpdates";
import { TIMEOUT_LIMITS, type SettingsSection, type ThemeMode } from "@/types/settings";

const CATEGORIES: readonly { id: SettingsSection; label: string }[] = [
  { id: "general", label: "General" },
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Appearance" },
  { id: "executor", label: "Executor" },
  { id: "target", label: "Target" },
  { id: "developer", label: "Developer" },
  { id: "updates", label: "Updates" },
  { id: "performance", label: "Performance" },
];

const THEMES: readonly { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "Follow system" },
];

const TAB_SIZES = [
  { value: "2", label: "2 spaces" },
  { value: "4", label: "4 spaces" },
  { value: "8", label: "8 spaces" },
] as const;

const seconds = (ms: number) => Math.round(ms / 1000);


/**
 * Settings surface. Every control here is backed by the settings model and
 * persists through `lib/storage`. Controls whose effect depends on a later
 * phase say so in their description rather than pretending to do something.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, updateSettings } = useAppStore();
  const { provider: targetProvider } = useTarget();
  const { provider: executionProvider } = useExecution();
  const updates = useUpdates();
  const { backend } = useBackend();
  /**
   * The backends this build can run on, for the picker. A choice is only offered
   * when there is more than one: a select with a single option asks a question
   * that has no other answer.
   */
  const { backends } = useAppServices();
  const [section, setSection] = useState<SettingsSection>("general");
  const fieldId = useId();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Settings"
      description="Stored locally on this machine. Nothing is sent anywhere."
    >
      {/* Fixed body height keeps the dialog from jumping as sections change. */}
      <div className="flex h-96 min-h-0 shrink">
        <nav aria-label="Settings categories" className="w-44 shrink-0 border-r border-border p-2">
          {CATEGORIES.map((category) => {
            const isActive = category.id === section;
            return (
              <button
                key={category.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                onClick={() => setSection(category.id)}
                className={`mb-0.5 flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs transition-colors duration-[var(--dur-fast)] ${
                  isActive
                    ? "bg-accent-soft font-medium text-foreground"
                    : "text-muted hover:bg-surface-raised hover:text-foreground"
                }`}
              >
                {category.label}
              </button>
            );
          })}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {section === "general" ? (
            <>
              <SectionTitle>General</SectionTitle>
              <Field
                label="Confirm before closing"
                hint="Ask what to do with unsaved changes when closing a tab or the window. When off, tabs and the window close right away and unsaved changes are kept as drafts for the next launch."
                htmlFor={`${fieldId}-confirm-exit`}
              >
                <Toggle
                  id={`${fieldId}-confirm-exit`}
                  label="Confirm before closing"
                  checked={settings.general.confirmOnExit}
                  onChange={(confirmOnExit) => updateSettings("general", { confirmOnExit })}
                />
              </Field>
            </>
          ) : null}

          {section === "editor" ? (
            <>
              <SectionTitle>Editor</SectionTitle>
              <Field
                label="Font size"
                hint="Applies to the code editor immediately."
                htmlFor={`${fieldId}-font-size`}
              >
                <Stepper
                  id={`${fieldId}-font-size`}
                  label="Editor font size"
                  value={settings.editor.fontSize}
                  min={10}
                  max={24}
                  suffix="px"
                  onChange={(fontSize) => updateSettings("editor", { fontSize })}
                />
              </Field>
              <Field label="Tab size" htmlFor={`${fieldId}-tab-size`}>
                <Select
                  id={`${fieldId}-tab-size`}
                  label="Tab size"
                  value={String(settings.editor.tabSize)}
                  options={TAB_SIZES}
                  onChange={(value) => updateSettings("editor", { tabSize: Number(value) })}
                />
              </Field>
              <Field
                label="Word wrap"
                hint="Wrap long lines instead of scrolling horizontally."
                htmlFor={`${fieldId}-word-wrap`}
              >
                <Toggle
                  id={`${fieldId}-word-wrap`}
                  label="Word wrap"
                  checked={settings.editor.wordWrap}
                  onChange={(wordWrap) => updateSettings("editor", { wordWrap })}
                />
              </Field>
              <Field
                label="Minimap"
                hint="Show a scaled overview of the script beside the scrollbar."
                htmlFor={`${fieldId}-minimap`}
              >
                <Toggle
                  id={`${fieldId}-minimap`}
                  label="Minimap"
                  checked={settings.editor.minimap}
                  onChange={(minimap) => updateSettings("editor", { minimap })}
                />
              </Field>
            </>
          ) : null}

          {section === "appearance" ? (
            <>
              <SectionTitle>Appearance</SectionTitle>
              <Field
                label="Theme"
                hint="Applies to the whole interface, including the code editor. Dark is the designed default."
                htmlFor={`${fieldId}-theme`}
              >
                <Select
                  id={`${fieldId}-theme`}
                  label="Theme"
                  value={settings.appearance.theme}
                  options={THEMES}
                  onChange={(theme) => updateSettings("appearance", { theme })}
                />
              </Field>
            </>
          ) : null}

          {section === "executor" ? (
            <>
              <SectionTitle>Executor</SectionTitle>
              <ProviderNotice>
                Scripts run on {executionProvider.label}, a simulation inside Nova used to develop the execution
                pipeline. Executing needs an injected target; the source is not evaluated, and no external process is
                contacted.
              </ProviderNotice>
              <Field
                label="Confirm before executing"
                hint="Show the script, mode and provider and ask before an execution starts."
                htmlFor={`${fieldId}-confirm-run`}
              >
                <Toggle
                  id={`${fieldId}-confirm-run`}
                  label="Confirm before executing"
                  checked={settings.executor.confirmBeforeRun}
                  onChange={(confirmBeforeRun) => updateSettings("executor", { confirmBeforeRun })}
                />
              </Field>
              <Field
                label="Clear console before executing"
                hint="Empty the console right before an execution starts, so its output stands alone. Requests that are refused leave the console untouched."
                htmlFor={`${fieldId}-clear-console`}
              >
                <Toggle
                  id={`${fieldId}-clear-console`}
                  label="Clear console before executing"
                  checked={settings.executor.clearConsoleBeforeRun}
                  onChange={(clearConsoleBeforeRun) => updateSettings("executor", { clearConsoleBeforeRun })}
                />
              </Field>
              <Field
                label="Execution timeout"
                hint="An execution still running after this long is stopped and reported as timed out."
                htmlFor={`${fieldId}-execution-timeout`}
              >
                <Stepper
                  id={`${fieldId}-execution-timeout`}
                  label="Execution timeout in seconds"
                  value={seconds(settings.executor.timeoutMs)}
                  min={seconds(TIMEOUT_LIMITS.execution.min)}
                  max={seconds(TIMEOUT_LIMITS.execution.max)}
                  suffix="s"
                  onChange={(value) => updateSettings("executor", { timeoutMs: value * 1000 })}
                />
              </Field>
            </>
          ) : null}

          {section === "target" ? (
            <>
              <SectionTitle>Target</SectionTitle>
              <ProviderNotice>
                The target is whatever Nova attaches to before it can execute anything. The provider the active backend
                supplies is the {targetProvider.label}
                {targetProvider.simulated
                  ? ": detection, injection and the session are simulated inside Nova."
                  : ", and it is not a simulation: what it reports came back from the backend it talks to."}{" "}
                No process is enumerated, opened or written to, no code is loaded into anything, and nothing leaves this
                machine.
              </ProviderNotice>
              <Field
                label="Auto detect target"
                hint="Look for the target when Nova starts, and follow it while Nova runs. With this off, use Detect in the target control instead."
                htmlFor={`${fieldId}-auto-detect`}
              >
                <Toggle
                  id={`${fieldId}-auto-detect`}
                  label="Auto detect target"
                  checked={settings.target.autoDetect}
                  onChange={(autoDetect) => updateSettings("target", { autoDetect })}
                />
              </Field>
              <Field
                label="Auto inject"
                hint="Inject as soon as a detected target becomes ready. It never executes a script by itself; Execute stays a separate action."
                htmlFor={`${fieldId}-auto-inject`}
              >
                <Toggle
                  id={`${fieldId}-auto-inject`}
                  label="Auto inject"
                  checked={settings.target.autoInject}
                  onChange={(autoInject) => updateSettings("target", { autoInject })}
                />
              </Field>
              <Field
                label="Inject timeout"
                hint="An injection still pending after this long is abandoned and reported as timed out. A late answer is ignored, so the target never appears injected afterwards."
                htmlFor={`${fieldId}-inject-timeout`}
              >
                <Stepper
                  id={`${fieldId}-inject-timeout`}
                  label="Inject timeout in seconds"
                  value={seconds(settings.target.injectTimeoutMs)}
                  min={seconds(TIMEOUT_LIMITS.inject.min)}
                  max={seconds(TIMEOUT_LIMITS.inject.max)}
                  suffix="s"
                  onChange={(value) => updateSettings("target", { injectTimeoutMs: value * 1000 })}
                />
              </Field>
              <Field
                label="Auto reconnect"
                hint="Inject again once the target is ready after an unexpected disconnect. A disconnect you asked for is never undone this way."
                htmlFor={`${fieldId}-auto-reconnect`}
              >
                <Toggle
                  id={`${fieldId}-auto-reconnect`}
                  label="Auto reconnect"
                  checked={settings.target.autoReconnect}
                  onChange={(autoReconnect) => updateSettings("target", { autoReconnect })}
                />
              </Field>
            </>
          ) : null}

          {section === "developer" ? (
            <>
              <SectionTitle>Developer</SectionTitle>
              <ProviderNotice>
                Nova&rsquo;s developer tools — the target, the debugger and the profiler — come from one developer
                backend. The one running now is <strong className="text-foreground">{backend.label}</strong>:{" "}
                {backend.description} Its live state, the providers it supplies and what they support are shown in the
                developer diagnostics, reachable from the status bar.
              </ProviderNotice>
              {backends.length > 1 ? (
                <Field
                  label="Developer backend"
                  hint="Which backend supplies the target, debugger and profiler providers. Changing it takes effect on the next launch."
                  htmlFor={`${fieldId}-backend`}
                >
                  <Select
                    id={`${fieldId}-backend`}
                    label="Developer backend"
                    value={settings.developer.backendId}
                    options={backends.map((entry) => ({ value: entry.id, label: entry.label }))}
                    onChange={(backendId) => updateSettings("developer", { backendId })}
                  />
                </Field>
              ) : (
                <Field label="Developer backend" hint="This build has one backend, so there is nothing to choose.">
                  <span className="font-mono text-[11px] text-muted">{backend.label}</span>
                </Field>
              )}
              <Field
                label="Auto start backend"
                hint="Start the developer backend when Nova launches. With this off, start it from the palette with Developer: Restart Backend; the tools stay unavailable until it is ready."
                htmlFor={`${fieldId}-auto-start-backend`}
              >
                <Toggle
                  id={`${fieldId}-auto-start-backend`}
                  label="Auto start backend"
                  checked={settings.developer.autoStartBackend}
                  onChange={(autoStartBackend) => updateSettings("developer", { autoStartBackend })}
                />
              </Field>
              <Field
                label="Startup timeout"
                hint="A backend still starting after this long is abandoned and reported as timed out. A late answer is ignored, so nothing can report itself ready afterwards."
                htmlFor={`${fieldId}-backend-startup-timeout`}
              >
                <Stepper
                  id={`${fieldId}-backend-startup-timeout`}
                  label="Backend startup timeout in seconds"
                  value={seconds(settings.developer.backendStartupTimeoutMs)}
                  min={seconds(TIMEOUT_LIMITS.backendStartup.min)}
                  max={seconds(TIMEOUT_LIMITS.backendStartup.max)}
                  suffix="s"
                  onChange={(value) => updateSettings("developer", { backendStartupTimeoutMs: value * 1000 })}
                />
              </Field>
              <Field
                label="Health check interval"
                hint="How often a backend that watches something asks it how it is doing, and how quickly a lost session is noticed. The Local Mock has nothing outside itself to ask, so this changes nothing while it is the backend."
                htmlFor={`${fieldId}-health-check-interval`}
              >
                <Stepper
                  id={`${fieldId}-health-check-interval`}
                  label="Health check interval in seconds"
                  value={seconds(settings.developer.healthCheckIntervalMs)}
                  min={seconds(TIMEOUT_LIMITS.healthCheck.min)}
                  max={seconds(TIMEOUT_LIMITS.healthCheck.max)}
                  suffix="s"
                  onChange={(value) => updateSettings("developer", { healthCheckIntervalMs: value * 1000 })}
                />
              </Field>
            </>
          ) : null}

          {section === "updates" ? (
            <>
              <SectionTitle>Updates</SectionTitle>
              <ProviderNotice>
                Nova updates itself from {updates.provider.source}. Every update is verified against a signing key built
                into this application before anything is installed, and an update that does not verify is refused. The
                source cannot be changed from here or from stored data: it is compiled into the application.
              </ProviderNotice>
              <Field
                label="Check for updates on startup"
                hint="Ask the release source shortly after launch whether a newer build exists. This is the only request Nova makes to anything outside this machine; with it off, Nova makes none at all and updates are found only by Check for Updates."
                htmlFor={`${fieldId}-check-updates`}
              >
                <Toggle
                  id={`${fieldId}-check-updates`}
                  label="Check for updates on startup"
                  checked={settings.updates.checkOnStartup}
                  onChange={(checkOnStartup) => updateSettings("updates", { checkOnStartup })}
                />
              </Field>
              <Field label="Installed build" hint={`Version ${config.version}.`}>
                <span className="font-mono text-xs text-foreground tabular-nums">{formatBuildId(config.version)}</span>
              </Field>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  onClick={updates.check}
                  disabled={!updates.provider.available || isUpdateBusy(updates.status)}
                  className="h-7 rounded border border-border-strong px-3 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-50"
                >
                  Check for Updates
                </button>
                <span className="text-[11px] text-muted">
                  {updates.provider.available
                    ? "Opens the update dialog with whatever the source answers."
                    : "This build cannot update itself; it was not installed from a release."}
                </span>
              </div>
            </>
          ) : null}

          {section === "performance" ? (
            <>
              <SectionTitle>Performance</SectionTitle>
              <Field
                label="Show diagnostics"
                hint="Adds the measured UI frame rate to the status bar. The meter only runs while this is on."
                htmlFor={`${fieldId}-diagnostics`}
              >
                <Toggle
                  id={`${fieldId}-diagnostics`}
                  label="Show diagnostics"
                  checked={settings.performance.showDiagnostics}
                  onChange={(showDiagnostics) => updateSettings("performance", { showDiagnostics })}
                />
              </Field>
              <h4 className="mt-5 mb-2 text-[10px] font-semibold tracking-[0.12em] text-subtle uppercase">
                Runtime
              </h4>
              <DiagnosticsList />
            </>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-1 text-xs font-semibold tracking-tight text-foreground">{children}</h3>;
}

function ProviderNotice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 mb-2 rounded border border-border bg-surface-secondary px-3 py-2 text-[11px] leading-relaxed text-muted">
      {children}
    </p>
  );
}
