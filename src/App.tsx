import { AppServicesProvider, createAppServices } from "@/app/services";
import { AppStoreProvider } from "@/app/store";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";

/** Created once per page load, outside React, so StrictMode never builds a second set of providers. */
const services = createAppServices();

export default function App() {
  return (
    <ErrorBoundary>
      <AppStoreProvider>
        <AppServicesProvider services={services}>
          <AppShell />
        </AppServicesProvider>
      </AppStoreProvider>
    </ErrorBoundary>
  );
}
