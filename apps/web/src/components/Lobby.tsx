import { useState } from "react";
import { pickCult, enterCompound } from "../game";
import { t } from "../packs";
import { useStore } from "../store";
import { Countdown, Emblem, MusicButton, ProgressBar, statusLabel } from "./widgets";
import { Ticker } from "./Ticker";

export function Lobby() {
  const { world, packs, player, clockSkew, name, set } = useStore();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (!world) return null;
  const live = world.phase === "live";

  async function go(id: string) {
    setBusy(true);
    setErr(null);
    try {
      await pickCult(id);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <main className="lobby">
      <header className="top">
        <div>
          <h1>Today's world</h1>
          <p className="muted">You are <strong>{name}</strong>. {live ? <>Resets in <Countdown endsAt={world.endsAt} skew={clockSkew} /></> : "This Day is over."}</p>
        </div>
        <nav className="links">
          <button className="link" onClick={() => set({ screen: "archive" })}>Past Days</button>
          <MusicButton />
        </nav>
      </header>
      {!live && (
        <div className="notice">
          The Day has ended. <button className="link" onClick={() => set({ screen: "summary", summaryDay: world.dayId })}>See the summary</button>. A new world is opening.
        </div>
      )}
      <section className="cards">
        {world.cults.map((c) => {
          const pack = packs[c.id];
          const theme = pack?.manifest.theme ?? {};
          const mine = player?.cult === c.id;
          return (
            <article key={c.id} className={`card ${c.status}`} style={{ borderColor: theme.primary }}>
              <div className="card-art" style={{ background: `linear-gradient(135deg, ${theme.primary ?? "#555"}, ${theme.floor ?? "#222"})` }}>
                <Emblem pack={pack} size={64} className="card-emblem" />
                <span className="diff">{pack?.manifest.difficulty}</span>
                {pack?.manifest.contentNote && <span className="content-note">{pack.manifest.contentNote}</span>}
              </div>
              <div className="card-head">
                <h2>{t(pack, "name")}</h2>
                <button className={`round ${open[c.id] ? "on" : ""}`} aria-label={`About ${t(pack, "name")}`} aria-expanded={!!open[c.id]} onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}>?</button>
              </div>
              {open[c.id] && (
                <div className="card-more">
                  <p className="muted small">{t(pack, "era")}</p>
                  <p>{t(pack, "tagline")}</p>
                  <p className="goal"><strong>Goal:</strong> {t(pack, "summary")}</p>
                  <button className="link" onClick={() => set({ screen: "codex", codexCult: c.id })}>History</button>
                </div>
              )}
              <ProgressBar value={c.progress ?? 0} color={theme.accent} label="Progress" />
              <div className="card-meta">
                <span className="mono">{Math.round((c.progress ?? 0) * 100)}%</span>
                <span>{c.players ?? 0} playing</span>
                <span className={`status ${c.status}`}>{statusLabel(c)}</span>
              </div>
              <div className="card-actions">
                {mine ? (
                  <button className="primary" disabled={!live} onClick={() => enterCompound()}>Return to the compound</button>
                ) : (
                  <button className="primary" disabled={!live || !!player || c.status !== "standing" || busy} onClick={() => setConfirm(c.id)}>
                    {player ? "Your pick is locked" : "Join"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
      {err && <p className="error">{err}</p>}
      <Ticker />
      {confirm && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-box">
            <h3>Join {t(packs[confirm], "name")}?</h3>
            <p>Your pick is locked for the rest of today's Day. If your cult falls, you can switch once, with half your energy.</p>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => go(confirm)}>Join for today</button>
              <button onClick={() => setConfirm(null)}>Not yet</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
