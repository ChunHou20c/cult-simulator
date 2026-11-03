// Keeps the PWA on the latest release. The service worker precaches the app
// shell, so a new release is only picked up when this code swaps workers and
// reloads. A reload mid-Day would drop the player out of their room, so it
// only happens on its own off the compound screen; in the room the player
// gets a small "Update" button instead.
import { registerSW } from "virtual:pwa-register";
import { S, useStore, type Screen } from "./store";

const CHECK_MS = 15 * 60 * 1000;
const SAFE: Screen[] = ["gate", "lobby", "end", "summary", "archive", "codex"];

let registration: ServiceWorkerRegistration | undefined;
let applying = false;

function updateFound() {
  S().set({ updateReady: true });
  if (SAFE.includes(S().screen)) applyUpdate();
}

// workbox-window misses an update that lands in the very tab that installed
// the first worker, so waiting workers are also watched here directly.
function watch(reg: ServiceWorkerRegistration) {
  const waiting = () => navigator.serviceWorker.controller && updateFound();
  if (reg.waiting) waiting();
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    w?.addEventListener("statechange", () => { if (w.state === "installed") waiting(); });
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    registration = reg;
    watch(reg);
    // Long-lived game tabs: look for a new release every 15 minutes.
    window.setInterval(() => reg.update().catch(() => {}), CHECK_MS);
  },
  onNeedRefresh: updateFound,
});

/** Swap to the waiting worker and reload into the new version. */
export function applyUpdate() {
  if (applying) return;
  applying = true;
  const w = registration?.waiting;
  if (!w) return location.reload();
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  w.postMessage({ type: "SKIP_WAITING" });
}

/** Ask the browser for a new release now, e.g. when the server says this client is too old. */
export function checkForUpdate() {
  registration?.update().catch(() => {});
}

// An update that arrived mid-Day applies as soon as the player leaves the room.
useStore.subscribe((s, prev) => {
  if (s.updateReady && s.screen !== prev.screen && SAFE.includes(s.screen)) applyUpdate();
});
