import {
  createLocalMockDeveloperBackend,
  LOCAL_MOCK_BACKEND_DESCRIPTOR,
} from "@/features/backend/backends/LocalMockDeveloperBackend";
import {
  createLocalServiceDeveloperBackend,
  LOCAL_SERVICE_BACKEND_DESCRIPTOR,
} from "@/features/backend/backends/LocalServiceDeveloperBackend";
import { createBackendRegistry, type DeveloperBackendRegistry } from "@/features/backend/registry";
import { loadSettings } from "@/lib/storage";

/**
 * Every developer backend this build knows about. The first is the default.
 *
 * This is the one place a backend implementation is named. The second backend proved the
 * point of the adapter layer by adding the second one: the **Local Service**
 * backend is one `DeveloperBackend` and one line here, and no controller, hook,
 * view or command had to learn anything about it.
 *
 * The **Local Mock** stays first, and so stays the default. Nova's regression
 * tests and the whole debugger and profiler story run on it, the Local Service
 * backend supplies neither of those tools, and a default that silently changed
 * what a fresh install can do would be a worse answer than a picker.
 *
 * It lives beside the backends rather than in `app/services.tsx` so the settings
 * dialog and the tests can read the catalogue without pulling in the composition
 * root — and so nothing here depends on React.
 */
export const backendRegistry: DeveloperBackendRegistry = createBackendRegistry([
  { descriptor: LOCAL_MOCK_BACKEND_DESCRIPTOR, create: () => createLocalMockDeveloperBackend() },
  {
    descriptor: LOCAL_SERVICE_BACKEND_DESCRIPTOR,
    // Read at each use rather than captured, so Settings › Developer applies
    // without a restart — the same rule the controllers' policies follow.
    create: () =>
      createLocalServiceDeveloperBackend({
        policy: () => ({ healthCheckIntervalMs: loadSettings().developer.healthCheckIntervalMs }),
      }),
  },
]);
