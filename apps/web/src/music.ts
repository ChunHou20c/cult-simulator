// Background music: one looping track for the lobby and one per cult room.
// Files live in public/music/<id>.m4a (built by scripts/build-music.sh).
// Browsers block sound until the first tap, so playback starts on the first
// pointer or key press. Muting is remembered per browser.
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

const KEY = "cs.music";
const VOLUME = 0.35;
const FADE_MS = 800;
const TRACKS = new Set(["lobby", "source_family", "synanon", "rajneeshpuram"]);

const listeners = new Set<() => void>();
let muted = readMuted();
let unlocked = false;
let wanted: string | null = null; // track the current screen asks for
let audio: HTMLAudioElement | null = null;
let playing: string | null = null; // track loaded in `audio`
let fadeTimer: number | undefined;

function readMuted(): boolean {
  try {
    return localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

function fadeTo(target: number, done?: () => void) {
  clearInterval(fadeTimer);
  const a = audio;
  if (!a) return done?.();
  const step = (VOLUME / FADE_MS) * 50;
  fadeTimer = window.setInterval(() => {
    const v = a.volume + Math.sign(target - a.volume) * step;
    if (Math.abs(target - a.volume) <= step) {
      a.volume = target;
      clearInterval(fadeTimer);
      done?.();
    } else a.volume = Math.min(1, Math.max(0, v));
  }, 50);
}

// Bring the audio element in line with what should be playing right now.
function sync() {
  const on = unlocked && !muted && !!wanted && document.visibilityState === "visible";
  if (!on) {
    if (audio && !audio.paused) fadeTo(0, () => audio?.pause());
    return;
  }
  if (playing !== wanted) {
    const next = wanted!;
    const start = () => {
      audio ??= Object.assign(new Audio(), { loop: true, preload: "auto" });
      audio.src = `/music/${next}.m4a`;
      audio.volume = 0;
      playing = next;
      audio.play().then(() => fadeTo(VOLUME)).catch(() => (playing = null));
    };
    if (audio && !audio.paused) fadeTo(0, start);
    else start();
  } else if (audio!.paused || audio!.volume < VOLUME) {
    audio!.play().then(() => fadeTo(VOLUME)).catch(() => {});
  }
}

function trackFor(s: ReturnType<typeof useStore.getState>): string | null {
  if (s.screen === "gate") return null;
  const cult = s.screen === "compound" ? s.player?.cult : undefined;
  return cult && TRACKS.has(cult) ? cult : "lobby";
}

export function initMusic() {
  wanted = trackFor(useStore.getState());
  useStore.subscribe((s) => {
    const t = trackFor(s);
    if (t !== wanted) {
      wanted = t;
      sync();
    }
  });
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    sync();
  };
  // Capture phase so the tap that leaves the gate also counts.
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
  document.addEventListener("visibilitychange", sync);
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(KEY, m ? "off" : "on");
  } catch {
    /* private mode: remember for this visit only */
  }
  unlocked = true; // toggling is itself a tap
  sync();
  listeners.forEach((f) => f());
}

export function useMuted(): boolean {
  return useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => muted);
}
