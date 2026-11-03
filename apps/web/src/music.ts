// Background music: one looping track for the lobby and one per cult room.
// Files live in public/music/<cult id>.m4a and lobby.m4a (built by
// scripts/build-music.sh). Nothing here names a cult: a cult without its own
// file falls back to the lobby track.
// Browsers block sound until the first tap, so playback starts on the first
// pointer or key press. Muting is remembered per browser.
import { useSyncExternalStore } from "react";
import { useStore } from "./store";

const KEY = "cs.music";
const VOLUME = 0.35;
const FADE_MS = 800;
const LOBBY = "lobby";
const missing = new Set<string>(); // tracks that failed to load

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
      if (!audio) {
        audio = Object.assign(new Audio(), { loop: true, preload: "auto" });
        audio.addEventListener("error", () => {
          // No file for this cult (or it failed): use the lobby track instead.
          const id = decodeURIComponent(audio!.src.split("/").pop() ?? "").replace(/\.m4a$/, "");
          if (!id || id === LOBBY) return;
          missing.add(id);
          if (playing === id) playing = null;
          if (wanted === id) wanted = LOBBY;
          sync();
        });
      }
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
  return cult && !missing.has(cult) ? cult : LOBBY;
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
