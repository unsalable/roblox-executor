import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import { config } from "@/app/config";
import { logger } from "@/lib/logger";
import "@/styles/globals.css";

window.addEventListener("error", (event) => {
  logger.error(event.message, event.error);
});

window.addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled promise rejection", event.reason);
});

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root was not found");

logger.info(`${config.appName} ${config.version} starting in ${config.environment} mode`);

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
