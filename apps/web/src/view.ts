// Which compound renderer to use. 2D is the default and the fallback; 3D is
// opt-in for now via ?3d=1 or the switch in the help panel, and only where
// WebGL2 works. The choice is remembered per browser.
import { useSyncExternalStore } from "react";

export type View = "2d" | "3d";
const KEY = "cs.view";
const listeners = new Set<() => void>();

function read(): View {
  try {
    const q = new URLSearchParams(location.search).get("3d");
    if (q === "1" || q === "0") localStorage.setItem(KEY, q === "1" ? "3d" : "2d");
    return localStorage.getItem(KEY) === "3d" ? "3d" : "2d";
  } catch {
    return new URLSearchParams(location.search).get("3d") === "1" ? "3d" : "2d";
  }
}

let current: View = read();

export function canUse3D(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export function setView(v: View) {
  current = v;
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode: keep it for this visit only */
  }
  listeners.forEach((f) => f());
}

export function useView(): View {
  const v = useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => current);
  return v === "3d" && canUse3D() ? "3d" : "2d";
}
