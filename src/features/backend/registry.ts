import type { BackendDescriptor, DeveloperBackend } from "@/features/backend/types";

/**
 * The developer backend registry.
 *
 * It answers three questions and nothing else: which backends this build knows
 * about, what each of them is called, and which one a stored preference means.
 * It holds no instance, no state and no lifecycle — the composition root creates
 * the one backend it resolved and the backend controller owns it from there, so
 * this stays a lookup table rather than a second place where application state
 * lives.
 */

export interface BackendRegistration {
  readonly descriptor: BackendDescriptor;
  /** Composes the backend. Called at most once per launch, by the composition root. */
  readonly create: () => DeveloperBackend;
}

/** How a preferred id was resolved. */
export type BackendResolution =
  | { readonly status: "resolved"; readonly registration: BackendRegistration }
  /** The preferred id is not registered in this build; the fallback is the default. */
  | { readonly status: "fallback"; readonly registration: BackendRegistration; readonly requestedId: string };

export interface DeveloperBackendRegistry {
  /** Descriptors only, for the UI and the settings picker. */
  readonly descriptors: readonly BackendDescriptor[];
  readonly defaultId: string;
  get: (id: string) => BackendRegistration | null;
  /**
   * The backend a stored preference means. An id this build does not know falls
   * back to the default and says so, rather than leaving Nova with no backend
   * because a preference outlived the build that wrote it.
   */
  resolve: (preferredId: string | null | undefined) => BackendResolution;
}

/**
 * Builds a registry over the given backends. The first registration is the
 * default; registering none is a programming error, because Nova always has one
 * backend to fall back to.
 */
export function createBackendRegistry(registrations: readonly BackendRegistration[]): DeveloperBackendRegistry {
  if (registrations.length === 0) throw new Error("A developer backend registry needs at least one backend");

  const byId = new Map(registrations.map((registration) => [registration.descriptor.id, registration]));
  if (byId.size !== registrations.length) {
    throw new Error("Developer backend ids must be unique");
  }

  const all = Object.freeze([...registrations]);
  const fallback = all[0] as BackendRegistration;

  const resolve = (preferredId: string | null | undefined): BackendResolution => {
    if (preferredId === null || preferredId === undefined || preferredId === "") {
      return { status: "resolved", registration: fallback };
    }
    const found = byId.get(preferredId);
    if (found) return { status: "resolved", registration: found };
    return { status: "fallback", registration: fallback, requestedId: preferredId };
  };

  const registry: DeveloperBackendRegistry = {
    descriptors: Object.freeze(all.map((registration) => registration.descriptor)),
    defaultId: fallback.descriptor.id,
    get: (id) => byId.get(id) ?? null,
    resolve,
  };

  return Object.freeze(registry);
}
