import { useEffect, useRef, useState } from "react";
import { CompoundScene } from "../CompoundScene";
import { act, backToLobby, defect, ritual, rise, switchCult } from "../game";
import { actionDef, DEFECTOR_ACTIONS, t } from "../packs";
import { cultView, energyNow, useStore } from "../store";
import { Countdown, ProgressBar, StatList, useNow } from "./widgets";
import { Ticker } from "./Ticker";

const REASONS: Record<string, string> = {
  no_energy: "Not enough energy",
  cooldown: "Still cooling down",
  requirement: "Not possible right now",
  cult_ended: "Your cult has ended",
  day_over: "The Day is over",
  need_evidence: "You need more evidence",
  defected: "You have left the group",
  world_unavailable: "The world is busy, try again",
};

function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scene = new CompoundScene();
    if (ref.current) scene.mount(ref.current);
    return () => scene.destroy();
  }, []);
  return <div className="canvas" ref={ref} aria-label="The compound. Tap to walk, tap a mat to kneel." />;
}

export function Compound() {
  const st = useStore();
  const { world, player, packs, engine, shared, clockSkew, cooldowns, pending, lastResult, convergence } = st;
  const now = useNow(500);
  const [err, setErr] = useState<string | null>(null);
  if (!world || !player || !engine) return null;
  const pack = packs[player.cult];
  const cult = cultView(world, player.cult);
  if (!pack || !cult) return null;
  const energy = energyNow(st.energy, st.energyAt, engine.maxEnergy, engine.refillSec, clockSkew);
  const serverNow = (now + clockSkew) / 1000;
  const live = world.phase === "live" && cult.status === "standing";
  const defected = player.defected;

  const button = (id: string, isDefector: boolean) => {
    const def = isDefector ? { energy: 1, cooldownSec: 20 } : actionDef(pack, id, shared);
    const cd = Math.max(0, Math.ceil((cooldowns[id] ?? 0) - serverNow));
    const waiting = pending.some((p) => p.action === id);
    const can = isDefector ? (id !== "talk_to_journalist" || player.evidence >= engine.evidenceForJournalist) : cult.can?.[id] !== false;
    const disabled = !live || waiting || cd > 0 || energy < def.energy || !can;
    const conv = convergence && Date.now() - convergence.at < 2500 && convergence.key === "act:" + id;
    return (
      <button key={id} className={`action ${conv ? "converge" : ""}`} disabled={disabled} onClick={() => act(id, isDefector)} title={t(pack, `action.${id}.desc`)}>
        <span className="action-name">{t(pack, `action.${id}`)}</span>
        <span className="action-meta">
          {waiting ? <span className="spinner" aria-label="pending" /> : cd > 0 ? `${cd}s` : `${def.energy} ⚡`}
        </span>
        <span className="action-desc">{t(pack, `action.${id}.desc`)}</span>
      </button>
    );
  };

  async function run(f: () => Promise<void>) {
    setErr(null);
    try {
      await f();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const standing = world.cults.filter((c) => c.status === "standing" && c.id !== player.cult);
  const signature = pack.actions.filter((a) => pack.manifest.actions.some((x) => x.id === a));
  const sharedIds = pack.actions.filter((a) => !signature.includes(a));

  return (
    <main className="compound" style={{ ["--accent" as any]: pack.manifest.theme?.accent, ["--primary" as any]: pack.manifest.theme?.primary }}>
      <section className="stage">
        <Canvas />
        <div className="rituals">
          {["bow", "chant", "beads", "candle"].map((r) => (
            <button key={r} className="ritual" onClick={() => ritual(r)} aria-label={r}>{({ bow: "🙇", chant: "〰", beads: "📿", candle: "🕯" } as any)[r]}</button>
          ))}
          <button className="ritual" onClick={() => rise()} aria-label="stand up">⬆</button>
        </div>
      </section>
      <aside className="hud">
        <header className="hud-head">
          <button className="link" onClick={() => backToLobby()}>← Lobby</button>
          <span className="muted small">Reset in <Countdown endsAt={world.endsAt} skew={clockSkew} /></span>
        </header>
        <h2>{t(pack, "name")}</h2>
        <p className="muted small">{t(pack, pack.manifest.goal.label)}</p>
        <ProgressBar value={cult.progress ?? 0} color={pack.manifest.theme?.accent} label="Progress" />
        <p className="mono small">{Math.round((cult.progress ?? 0) * 1000) / 10}% · {cult.players ?? 0} playing · {cult.defectors ?? 0} defected</p>
        <StatList pack={pack} cult={cult} />
        <div className="energy" aria-label={`Energy ${energy} of ${engine.maxEnergy}`}>
          {Array.from({ length: engine.maxEnergy }, (_, i) => <span key={i} className={i < energy ? "on" : ""} />)}
          <span className="mono small">{energy}/{engine.maxEnergy}</span>
        </div>
        {lastResult && Date.now() - lastResult.at < 4000 && (
          <p className={`result ${lastResult.ok ? "ok" : "bad"}`}>
            {lastResult.ok
              ? Object.entries(lastResult.deltas ?? {}).filter(([, v]) => Math.abs(v) >= 0.01).map(([k, v]) => `${v > 0 ? "+" : ""}${Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ${t(pack, pack.manifest.stats?.[k]?.label ?? `stat.${k}`)}`).join(", ") || "Done"
              : REASONS[lastResult.reason ?? ""] ?? lastResult.reason}
          </p>
        )}
        {!defected && (
          <>
            <h3>Signature</h3>
            <div className="actions">{signature.map((id) => button(id, false))}</div>
            <h3>Shared</h3>
            <div className="actions">{sharedIds.map((id) => button(id, false))}</div>
            {live && (
              <p className="small muted">
                {player.actions >= engine.defectMinActions
                  ? <button className="link danger" onClick={() => { if (confirm("Leave the group? You stop adding to it and work to expose it instead.")) run(defect); }}>Defect</button>
                  : `You can defect after ${engine.defectMinActions} actions (${player.actions} so far).`}
              </p>
            )}
          </>
        )}
        {defected && (
          <section className="defector">
            <h3>You left the group</h3>
            <p className="small">Evidence: <strong className="mono">{player.evidence}</strong>. Exposure: <span className="mono">{Math.round(cult.stats.exposure ?? 0)}</span>/100. You win if the group is exposed or investigated.</p>
            <div className="actions">{DEFECTOR_ACTIONS.map((id) => button(id, true))}</div>
          </section>
        )}
        {cult.status !== "standing" && world.phase === "live" && !player.switchedFrom && !defected && standing.length > 0 && (
          <section className="switch">
            <h3>Your cult has ended</h3>
            <p className="small">You can switch once, keeping half your energy.</p>
            {standing.map((c) => <button key={c.id} onClick={() => run(() => switchCult(c.id))}>Join {t(packs[c.id], "name")}</button>)}
          </section>
        )}
        {err && <p className="error">{err}</p>}
        <h3>Rivals</h3>
        {world.cults.filter((c) => c.id !== player.cult).map((c) => (
          <div key={c.id} className="rival">
            <span>{t(packs[c.id], "name")}</span>
            <ProgressBar value={c.progress ?? 0} color={packs[c.id]?.manifest.theme?.accent} />
          </div>
        ))}
        <Ticker />
      </aside>
    </main>
  );
}
