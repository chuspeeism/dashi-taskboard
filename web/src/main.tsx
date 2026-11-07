import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AgentboardViewer } from "./AgentboardViewer";
import { getTaskboardMetadata } from "./api";
import { initializeTaskboardStorage } from "./storage";
import "./styles.css";

async function main() {
  const metadata = await getTaskboardMetadata().catch(() => undefined);
  const mode = metadata?.mode;
  if (mode === "agentboard") document.title = "TaskDock";
  else await initializeTaskboardStorage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {mode === "agentboard" ? <AgentboardViewer pollIntervalMs={metadata?.realtime?.transport === "poll" ? metadata.realtime.intervalMs : undefined} /> : <App />}
    </StrictMode>,
  );
}

void main();
