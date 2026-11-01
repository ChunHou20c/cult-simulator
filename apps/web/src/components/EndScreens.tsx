import { useEffect, useRef, useState } from "react";
import { rpc } from "../net";
import { t } from "../packs";
import { cultView, useStore } from "../store";
import { refreshDay } from "../game";

const HELP = "https://www.icsahome.com/";

const OUTCOME: Record<string, string> = {
  winner: "Your cult won the Day",
  defector_win: "You left, and the group was exposed",
  fell_with_cult: "You fell with your cult",
  unfinished: "Time ran out before anyone finished",
  lost: "Another cult won the Day",
};

/** The player's own cult result. A fall states the real outcome plainly. */
export function EndCard() {
  const { world, player, packs, dayEnded, set } = useStore();
  const dayId = dayEnded?.dayId ?? world?.dayId;
  if (!world || !dayId) return null;
  const pack = player ? packs[player.cult] : undefined;
  const cult = cultView(world, player?.cult);
  const sameDay = world.dayId === dayId;
  return (
    <main className="end">
      <div className="end-card" style={{ borderColor: pack?.manifest.theme?.accent }}>
        <p className="muted small">Day {dayId}</p>
        <h1>{dayEnded?.reset && !sameDay ? "The Day is over" : cult?.status === "won" ? `${t(pack, "name")} reached its goal` : cult && cult.status !== "standing" ? `${t(pack, "name")} has ended` : "The Day is over"}</h1>
        {sameDay && cult?.fallText && (
          <>
            <p className="history">{t(pack, cult.fallText)}</p>
            <p className="small muted">If this history touches your own life, the <a href={HELP} target="_blank" rel="noreferrer">International Cultic Studies Association</a> offers support.</p>
          </>
        )}
        <div className="row">
          <button className="primary" onClick={() => set({ screen: "summary", summaryDay: dayId })}>See the summary</button>
          <button onClick={async () => { await refreshDay(); set({ screen: "lobby" }); }}>{sameDay ? "Back to the lobby" : "Today's cults"}</button>
        </div>
      </div>
    </main>
  );
}

interface Summary {
  dayId: string;
  headline: string;
  endReason: string;
  winner?: string;
  standings: { cult: string; name: string; status: string; progress: number; fallReason?: string; players: number; defectors: number }[];
  timeline: { at: number; cult?: string; text: string }[];
  top: Record<string, { name: string; value: number }[]>;
  fallen: { cult: string; name: string; historical: boolean; text: string }[];
}

export function SummaryView() {
  const { summaryDay, packs, set } = useStore();
  const [data, setData] = useState<{ summary: Summary; you?: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!summaryDay) return;
    let tries = 0;
    const load = () =>
      rpc<any>("get_summary", { dayId: summaryDay }).then(setData).catch((e) => {
        // The summary is written a moment after the Day ends.
        if (++tries < 10) window.setTimeout(load, 1500);
        else setErr(e.message);
      });
    load();
  }, [summaryDay]);
  if (err) return <main className="summary"><p className="error">{err}</p><button onClick={() => set({ screen: "lobby" })}>Lobby</button></main>;
  if (!data) return <main className="summary"><p className="muted">Building the summary…</p></main>;
  const s = data.summary;

  function share() {
    const c = canvas.current!;
    const g = c.getContext("2d")!;
    c.width = 1080;
    c.height = 1080;
    g.fillStyle = "#16130f";
    g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = "#e0b44c";
    g.font = "600 34px system-ui, sans-serif";
    g.fillText(`Cult Simulator · ${s.dayId}`, 70, 110);
    g.fillStyle = "#f3eadb";
    g.font = "700 54px system-ui, sans-serif";
    wrap(g, s.headline, 70, 200, 940, 64);
    g.font = "400 36px system-ui, sans-serif";
    s.standings.forEach((r, i) => {
      const y = 470 + i * 110;
      g.fillStyle = "#f3eadb";
      g.fillText(`${r.name}`, 70, y);
      g.fillStyle = "#3a332b";
      g.fillRect(70, y + 20, 940, 22);
      g.fillStyle = packs[r.cult]?.manifest.theme?.accent ?? "#e0b44c";
      g.fillRect(70, y + 20, 940 * Math.min(1, r.progress), 22);
    });
    if (data?.you) {
      g.fillStyle = "#b9ad9a";
      g.font = "400 32px system-ui, sans-serif";
      g.fillText(`${data.you.name}: ${OUTCOME[data.you.outcome] ?? ""}, ${data.you.actions} actions`, 70, 1000);
    }
    c.toBlob(async (blob) => {
      if (!blob) return;
      const file = new File([blob], `cult-simulator-${s.dayId}.png`, { type: "image/png" });
      if ((navigator as any).canShare?.({ files: [file] })) await navigator.share({ files: [file], title: s.headline }).catch(() => {});
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
      }
    });
  }

  return (
    <main className="summary">
      <p className="muted small">Day {s.dayId}</p>
      <h1>{s.headline}</h1>
      {data.you && (
        <p className="you">You were <strong>{data.you.name}</strong>: {OUTCOME[data.you.outcome] ?? "No result yet"}, with {data.you.actions} actions{data.you.contribution > 0 ? ` adding ${(data.you.contribution * 100).toFixed(2)}% Progress` : ""}.</p>
      )}
      <h2>Standings</h2>
      <ol className="standings">
        {s.standings.map((r) => (
          <li key={r.cult}>
            <span>{r.name}</span>
            <span className="mono">{Math.round(r.progress * 100)}%</span>
            <span className={`status ${r.status}`}>{r.status}</span>
            <span className="muted small">{r.players} players, {r.defectors} defected</span>
          </li>
        ))}
      </ol>
      {s.timeline.length > 0 && (
        <>
          <h2>Moments</h2>
          <ul className="timeline">
            {s.timeline.map((m, i) => <li key={i}><span className="mono muted">{new Date(m.at * 1000).toUTCString().slice(17, 22)}</span> {m.text}</li>)}
          </ul>
        </>
      )}
      <h2>Top contributors</h2>
      <div className="tops">
        {s.standings.map((r) => (
          <div key={r.cult}>
            <h3>{r.name}</h3>
            {(s.top[r.cult] ?? []).length ? <ol>{s.top[r.cult].map((c) => <li key={c.name}>{c.name}</li>)}</ol> : <p className="muted small">Nobody yet</p>}
          </div>
        ))}
      </div>
      {s.fallen.length > 0 && (
        <>
          <h2>What really happened</h2>
          {s.fallen.map((f) => <p key={f.cult} className="history"><strong>{f.name}.</strong> {f.text}</p>)}
          <p className="small muted">Support: <a href={HELP} target="_blank" rel="noreferrer">International Cultic Studies Association</a>.</p>
        </>
      )}
      <div className="row">
        <button className="primary" onClick={share}>Share</button>
        <button onClick={async () => { await refreshDay(); set({ screen: "lobby" }); }}>Lobby</button>
        <button className="link" onClick={() => set({ screen: "archive" })}>Past Days</button>
      </div>
      <canvas ref={canvas} hidden />
    </main>
  );
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number) {
  let line = "";
  for (const w of text.split(" ")) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > max && line) {
      g.fillText(line, x, y);
      line = w;
      y += lh;
    } else line = test;
  }
  g.fillText(line, x, y);
}

export function Archive() {
  const { set } = useStore();
  const [days, setDays] = useState<{ dayId: string; headline: string }[] | null>(null);
  useEffect(() => {
    rpc<any>("list_archive").then((r) => setDays(r.days)).catch(() => setDays([]));
  }, []);
  return (
    <main className="summary">
      <button className="link" onClick={() => set({ screen: "lobby" })}>← Lobby</button>
      <h1>Past Days</h1>
      {!days ? <p className="muted">Loading…</p> : days.length === 0 ? <p className="muted">No Day has ended yet.</p> : (
        <ul className="archive">
          {days.map((d) => <li key={d.dayId}><button className="link" onClick={() => set({ screen: "summary", summaryDay: d.dayId })}><span className="mono">{d.dayId}</span> {d.headline}</button></li>)}
        </ul>
      )}
    </main>
  );
}

export function Codex() {
  const { codexCult, packs, set } = useStore();
  const pack = codexCult ? packs[codexCult] : undefined;
  return (
    <main className="summary codex">
      <button className="link" onClick={() => set({ screen: "lobby" })}>← Lobby</button>
      {pack ? <Markdown src={pack.codex} /> : <p className="muted">No history for this cult.</p>}
      <p className="small muted">Support: <a href={HELP} target="_blank" rel="noreferrer">International Cultic Studies Association</a>.</p>
    </main>
  );
}

/** Tiny Markdown: headings, paragraphs and *italic* lines, enough for codex text. */
function Markdown({ src }: { src: string }) {
  return (
    <>
      {src.split(/\n\s*\n/).map((block, i) => {
        const b = block.trim();
        if (b.startsWith("# ")) return <h1 key={i}>{b.slice(2)}</h1>;
        if (b.startsWith("## ")) return <h2 key={i}>{b.slice(3)}</h2>;
        if (/^\*[^*].*\*$/.test(b)) return <p key={i} className="small muted"><em>{b.slice(1, -1)}</em></p>;
        return <p key={i}>{b}</p>;
      })}
    </>
  );
}
