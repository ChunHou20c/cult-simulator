// The action icons. They are the same in every cult so players learn them
// once: a person with a plus (Recruit), a coin (Work), a heart (Devote); and
// for a defector a magnifying glass (evidence), a phone (call family) and a
// newspaper (talk to a journalist).
import type { IconKind } from "../packs";

export function SlotIcon({ slot, size = 30 }: { slot: IconKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      {slot === "recruit" && (
        <>
          <circle cx="12" cy="10" r="5" />
          <path d="M3 27c0-5.5 4-9 9-9s9 3.5 9 9" />
          <path d="M25 9v10M20 14h10" />
        </>
      )}
      {slot === "work" && (
        <>
          <circle cx="16" cy="16" r="12" />
          <circle cx="16" cy="16" r="8" strokeWidth={1.6} />
          <path d="M16 11v10" />
        </>
      )}
      {slot === "evidence" && (
        <>
          <circle cx="13" cy="13" r="8" />
          <path d="M19 19l9 9" />
        </>
      )}
      {slot === "family" && (
        <path d="M8 4h5l2 7-3.5 2.5a16 16 0 0 0 9 9L23 19l7 2v5a3 3 0 0 1-3 3C14.5 29 3 17.5 3 7a3 3 0 0 1 3-3z" />
      )}
      {slot === "journalist" && (
        <>
          <rect x="4" y="6" width="20" height="21" rx="2" />
          <path d="M24 11h4v13a3 3 0 0 1-6 0M8 11h12M8 16h12M8 21h8" />
        </>
      )}
      {slot === "devote" && (
        <path d="M16 27S4 19.5 4 11.5C4 7.4 7 5 10.2 5c2.5 0 4.6 1.5 5.8 3.5C17.2 6.5 19.3 5 21.8 5 25 5 28 7.4 28 11.5 28 19.5 16 27 16 27z" />
      )}
    </svg>
  );
}

/** Perfect, Good and Miss as symbols. */
export function gradeMark(g: number): string {
  return g >= 1 ? "★" : g > 0 ? "✓" : "✕";
}
