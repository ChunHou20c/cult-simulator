import { useState } from "react";
import { start } from "./game";
import { useStore } from "./store";
import { Lobby } from "./components/Lobby";
import { Compound } from "./components/Compound";
import { Archive, Codex, EndCard, SummaryView } from "./components/EndScreens";

function Gate() {
  const { error } = useStore();
  const [busy, setBusy] = useState(false);
  return (
    <main className="gate">
      <h1>Cult Simulator</h1>
      <p className="muted">One shared world a day. Pick a cult, move its numbers with everyone else, and see how it ends.</p>
      <p className="small muted">Every cult here was real. Their tragedies are shown as losses, never as rewards.</p>
      <button className="primary big" disabled={busy && !error} onClick={() => { setBusy(true); start(); }}>
        {busy && !error ? "Entering…" : "Enter"}
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}

export function App() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case "lobby": return <Lobby />;
    case "compound": return <Compound />;
    case "end": return <EndCard />;
    case "summary": return <SummaryView />;
    case "archive": return <Archive />;
    case "codex": return <Codex />;
    default: return <Gate />;
  }
}
