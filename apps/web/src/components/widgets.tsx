import { useEffect, useState } from "react";
import { CORE_STATS, formatStat, t, type Pack, type StatDef } from "../packs";
import type { CultView } from "../store";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function Countdown({ endsAt, skew }: { endsAt: number; skew: number }) {
  const now = useNow();
  const left = Math.max(0, endsAt - (now + skew) / 1000);
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = Math.floor(left % 60);
  return <span className="mono">{h}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}</span>;
}

export function ProgressBar({ value, color, label }: { value: number; color?: string; label?: string }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-fill" style={{ width: `${Math.min(100, value * 100)}%`, background: color }} />
    </div>
  );
}

/** One stat, drawn by its widget type. Unknown widgets fall back to a plain number. */
export function Stat({ pack, id, def, value, danger }: { pack?: Pack; id: string; def: StatDef; value: number; danger?: boolean }) {
  const label = t(pack, def.label);
  if (def.widget === "bar") {
    return (
      <div className={`stat stat-bar ${danger && value >= 70 ? "hot" : ""}`} title={label}>
        <div className="stat-head"><span>{label}</span><span className="mono">{formatStat("bar", value)}</span></div>
        <div className="bar"><div style={{ width: `${Math.min(100, value)}%` }} /></div>
      </div>
    );
  }
  return (
    <div className="stat" title={label} data-stat={id}>
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{formatStat(def.widget, value)}</span>
    </div>
  );
}

export function StatList({ pack, cult, include }: { pack?: Pack; cult: CultView; include?: string[] }) {
  const defs: [string, StatDef][] = [
    ...Object.entries(CORE_STATS),
    ...Object.entries(pack?.manifest.stats ?? {}),
  ].filter(([id]) => !include || include.includes(id)) as [string, StatDef][];
  return (
    <div className="stats">
      {defs.map(([id, def]) => (
        <Stat key={id} pack={pack} id={id} def={def} value={cult.stats[id] ?? 0} danger={id === "scrutiny" || id === "paranoia" || id === "exposure"} />
      ))}
    </div>
  );
}

export function statusLabel(c: CultView): string {
  switch (c.status) {
    case "won": return "Reached its goal";
    case "fallen": return "Fell";
    case "exposed": return "Exposed";
    default: return "Standing";
  }
}
