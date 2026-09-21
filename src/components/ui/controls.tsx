import { type ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}

/** One settings row: label and description on the left, control on the right. */
export function Field({ label, hint, htmlFor, children }: FieldProps) {
  return (
    <div className="flex items-start justify-between gap-8 border-b border-border py-3.5 last:border-b-0">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
          {label}
        </label>
        {hint ? <p className="mt-0.5 max-w-sm text-[11px] leading-relaxed text-muted">{hint}</p> : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

export function Toggle({ id, checked, onChange, label }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full border transition-colors duration-[var(--dur-fast)] ${
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-secondary"
      }`}
    >
      <span
        className={`absolute top-0.5 size-3.5 rounded-full transition-[left] duration-[var(--dur-fast)] ease-[var(--ease-out)] ${
          checked ? "left-[18px] bg-accent-foreground" : "left-0.5 bg-muted"
        }`}
      />
    </button>
  );
}

interface SelectProps<T extends string> {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}

export function Select<T extends string>({ id, value, options, onChange, label }: SelectProps<T>) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className="h-7 min-w-32 rounded border border-border-strong bg-surface-secondary px-2 text-xs text-foreground transition-colors duration-[var(--dur-fast)] hover:border-accent"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface StepperProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
  label: string;
}

export function Stepper({ id, value, min, max, step = 1, suffix, onChange, label }: StepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  return (
    <div className="flex items-center overflow-hidden rounded border border-border-strong bg-surface-secondary">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
        className="h-7 w-7 text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        &minus;
      </button>
      <output id={id} aria-label={label} className="w-14 text-center font-mono text-xs">
        {value}
        {suffix}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
        className="h-7 w-7 text-muted transition-colors duration-[var(--dur-fast)] hover:bg-surface-raised hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
