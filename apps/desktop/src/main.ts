import { getVersion } from "@tauri-apps/api/app";
import { shellStatus } from "./appInfo";

async function render(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) return;

  let version = "dev";
  try {
    version = await getVersion();
  } catch {
    // Running in a plain browser (vite dev without Tauri): keep "dev".
  }

  root.innerHTML = `
    <h1>Sayvox</h1>
    <p>Hold Ctrl+Shift, speak, release.</p>
    <p class="status"></p>
  `;
  const status = root.querySelector<HTMLElement>(".status");
  if (status) status.textContent = shellStatus(version);
}

void render();
