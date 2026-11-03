import { useEffect, useRef, useState } from "react";
import { CompoundScene } from "../CompoundScene";
import { act, actStart, backToLobby, defect, ritual, rise, switchCult } from "../game";
import { actionDef, DEFECTOR_ACTIONS, slotted, t, type ActionDef, type Pack, type Slot } from "../packs";
import { MiniGame } from "./MiniGame";
import { gradeMark, SlotIcon } from "./SlotIcon";
import { cultView, energyNow, useStore } from "../store";
import { Countdown, Emblem, MusicButton, ProgressBar, StatList, useNow } from "./widgets";
import { Ticker } from "./Ticker";
import { canUse3D, setView, useView, type View } from "../view";

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

function Canvas({ view }: { view: View }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let scene: { destroy(): void } | undefined;
    let gone = false;
    if (view === "3d") {
      // Loaded on demand so the 2D game doesn't download Three.js.
      import("../CompoundScene3D").then(({ CompoundScene3D }) => {
        if (gone || !ref.current) return;
        const s = new CompoundScene3D();
        s.mount(ref.current);
        scene = s;
      }).catch(() => setView("2d"));
    } else {
      const s = new CompoundScene();
      if (ref.current) s.mount(ref.current);
      scene = s;
    }
    return () => {
      gone = true;
      scene?.destroy();
    };
  }, [view]);
  return <div className="canvas" ref={ref} aria-label="The compound. Tap to walk, tap a mat to kneel." />;
}

export function Compound() {
  const st = useStore();
  const { world, player, packs, engine, shared, clockSkew, cooldowns, pending, lastResult, convergence } = st;
  const now = useNow(500);
  const [err, setErr] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const view = useView();
  const [newPlayer, noteAction] = useFirstActions();
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
          {waiting ? <span className="spinner" aria-label="pending" /> : cd > 0 ? `${cd}s` : `${def.energy}⚡`}
        </span>
      </button>
    );
  };

  // The three icon buttons (packs with slots). A ring shows the cooldown,
  // dots the energy cost; a long press shows the name and what it does.
  const slotButton = (a: ActionDef) => {
    const id = a.id, slot = a.slot as Slot;
    const def = actionDef(pack, id, shared);
    const cdLeft = Math.max(0, (cooldowns[id] ?? 0) - serverNow);
    const cdFrac = def.cooldownSec > 0 ? Math.min(1, cdLeft / def.cooldownSec) : 0;
    const waiting = pending.some((p) => p.action === id);
    const disabled = !live || waiting || cdLeft > 0 || energy < def.energy || cult.can?.[id] === false || !!st.round;
    const conv = convergence && Date.now() - convergence.at < 2500 && convergence.key === "act:" + id;
    return (
      <SlotButton key={id} pack={pack} id={id} slot={slot} cost={def.energy} cdFrac={cdFrac} waiting={waiting} disabled={disabled} conv={!!conv}
        showLabel={newPlayer} onPress={() => { actStart(id); noteAction(); }} />
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
  // Signature actions first, then the shared ones.
  const signature = pack.manifest.actions.map((a) => a.id).filter((id) => pack.actions.includes(id));
  const actionIds = defected ? DEFECTOR_ACTIONS : [...signature, ...pack.actions.filter((a) => !signature.includes(a))];
  const slots = defected ? null : slotted(pack);
  const roundDef = st.round && pack.manifest.actions.find((a) => a.id === st.round!.action);
  const showResult = lastResult && Date.now() - lastResult.at < 4000;
  const canSwitch = cult.status !== "standing" && world.phase === "live" && !player.switchedFrom && !defected && standing.length > 0;

  return (
    <main className="compound" style={{ ["--accent" as any]: pack.manifest.theme?.accent, ["--primary" as any]: pack.manifest.theme?.primary }}>
      <Canvas key={view} view={view} />

      <header className="hud-top">
        <button className="round" onClick={() => backToLobby()} aria-label="Back to the lobby">←</button>
        <div className="chip" aria-label={`${t(pack, "name")}, ${Math.round((cult.progress ?? 0) * 100)}% of the goal`}>
          <span className="chip-name"><Emblem pack={pack} size={18} />{t(pack, "name")}</span>
          <ProgressBar value={cult.progress ?? 0} color={pack.manifest.theme?.accent} label="Progress" />
        </div>
        <div className="energy" aria-label={`Energy ${energy} of ${engine.maxEnergy}`}>
          {Array.from({ length: engine.maxEnergy }, (_, i) => <span key={i} className={`pip ${i < energy ? "on" : ""}`} />)}
          <span className="energy-num mono" aria-hidden="true">{energy}⚡</span>
        </div>
        <MusicButton />
        {canUse3D() && (
          <button className="round view-toggle" onClick={() => setView(view === "3d" ? "2d" : "3d")} aria-label={view === "3d" ? "Switch to the 2D view" : "Switch to the 3D view"} title={view === "3d" ? "2D view" : "3D view"}>
            {view === "3d" ? "2D" : "3D"}
          </button>
        )}
        <button className={`round ${help ? "on" : ""}`} onClick={() => setHelp(!help)} aria-label={help ? "Hide help" : "Show help"} aria-expanded={help}>?</button>
      </header>

      {help && (
        <aside className="help" aria-label="Help">
          <p className="muted small">{defected ? "You left the group." : t(pack, pack.manifest.goal.label)}</p>
          <p className="mono small">
            {Math.round((cult.progress ?? 0) * 1000) / 10}% · {cult.players ?? 0} playing · {cult.defectors ?? 0} defected · reset in <Countdown endsAt={world.endsAt} skew={clockSkew} />
          </p>
          <StatList pack={pack} cult={cult} />
          <h3>Actions</h3>
          {slots ? (
            <p className="small muted">Each costs energy (dots), which refills over time. Each opens a few-second mini game: play it well for a bigger effect and less attention, or skip it (⏭) for the plain result. Tap the floor to walk, a mat to kneel.</p>
          ) : (
            <p className="small muted">Each costs energy (⚡), which refills over time. Tap the floor to walk, a mat to kneel, and the round buttons to pray.</p>
          )}
          <dl className="glossary">
            {(slots ? slots.map((a) => a.id) : actionIds).map((id) => {
              const slot = slots?.find((a) => a.id === id)?.slot as Slot | undefined;
              return <div key={id}><dt>{slot && <SlotIcon slot={slot} size={16} />} {t(pack, `action.${id}`)}</dt><dd>{t(pack, `action.${id}.desc`)}</dd></div>;
            })}
          </dl>
          {defected && (
            <p className="small">Evidence: <strong className="mono">{player.evidence}</strong>. Exposure: <span className="mono">{Math.round(cult.stats.exposure ?? 0)}</span>/100. You win if the group is exposed or investigated.</p>
          )}
          {!defected && live && (
            <p className="small muted">
              {player.actions >= engine.defectMinActions
                ? <button className="link danger" onClick={() => { if (confirm("Leave the group? You stop adding to it and work to expose it instead.")) run(defect); }}>Defect</button>
                : `You can defect after ${engine.defectMinActions} actions (${player.actions} so far).`}
            </p>
          )}
          <h3>Rivals</h3>
          {world.cults.filter((c) => c.id !== player.cult).map((c) => (
            <div key={c.id} className="rival">
              <span className="rival-name"><Emblem pack={packs[c.id]} size={16} />{t(packs[c.id], "name")}</span>
              <ProgressBar value={c.progress ?? 0} color={packs[c.id]?.manifest.theme?.accent} />
            </div>
          ))}
          <Ticker />
        </aside>
      )}

      <footer className="hud-bottom">
        {(showResult || err) && (
          <p className={`toast ${err || !lastResult?.ok ? "bad" : "ok"}`} role="status">
            {err ?? (lastResult!.ok
              ? (lastResult!.grades?.length ? lastResult!.grades.map(gradeMark).join("") + "  " : "") + Object.entries(lastResult!.deltas ?? {}).filter(([, v]) => Math.abs(v) >= 0.01).map(([k, v]) => `${v > 0 ? "+" : ""}${Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ${t(pack, pack.manifest.stats?.[k]?.label ?? `stat.${k}`)}`).join(", ") || "Done"
              : REASONS[lastResult!.reason ?? ""] ?? lastResult!.reason)}
          </p>
        )}
        {canSwitch && (
          <div className="switch">
            <span className="small">Your cult has ended. Switch once:</span>
            {standing.map((c) => <button key={c.id} onClick={() => run(() => switchCult(c.id))}>{t(packs[c.id], "name")}</button>)}
          </div>
        )}
        {slots ? (
          <div className="slots">{slots.map(slotButton)}</div>
        ) : (
          <>
            <div className="actions">{actionIds.map((id) => button(id, defected))}</div>
            {!defected && (
              <div className="rituals">
                {["bow", "chant", "beads", "candle"].map((r) => (
                  <button key={r} className="ritual" onClick={() => ritual(r)} aria-label={r} title={r}>{({ bow: "🙇", chant: "〰", beads: "📿", candle: "🕯" } as any)[r]}</button>
                ))}
                <button className="ritual" onClick={() => rise()} aria-label="stand up" title="stand up">⬆</button>
              </div>
            )}
          </>
        )}
      </footer>
      {st.round && roundDef && <MiniGame key={st.round.nonce} round={st.round} def={roundDef} />}
    </main>
  );
}

// New players see a one-word label under each icon for their first few
// actions; after that the icons stand alone.
const LABEL_ACTIONS = 6;
function useFirstActions(): [boolean, () => void] {
  const read = () => {
    try { return Number(localStorage.getItem("cs.slotActions") || 0); } catch { return LABEL_ACTIONS; }
  };
  const [n, setN] = useState(read);
  return [n < LABEL_ACTIONS, () => {
    const v = read() + 1;
    try { localStorage.setItem("cs.slotActions", String(v)); } catch { /* private mode */ }
    setN(v);
  }];
}

const SHORT: Record<Slot, string> = { recruit: "Recruit", work: "Work", devote: "Devote" };

function SlotButton(p: { pack: Pack; id: string; slot: Slot; cost: number; cdFrac: number; waiting: boolean; disabled: boolean; conv: boolean; showLabel: boolean; onPress: () => void }) {
  const [tip, setTip] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const long = useRef(false);
  const name = t(p.pack, `action.${p.id}`);
  const C = 2 * Math.PI * 34;
  return (
    <div className="slot-wrap">
      <button
        className={`slot slot-${p.slot} ${p.conv ? "converge" : ""}`}
        disabled={p.disabled}
        aria-label={`${name}. ${t(p.pack, `action.${p.id}.desc`)}`}
        onPointerDown={() => { long.current = false; timer.current = window.setTimeout(() => { long.current = true; setTip(true); }, 450); }}
        onPointerUp={() => { window.clearTimeout(timer.current); window.setTimeout(() => setTip(false), 1600); }}
        onPointerLeave={() => { window.clearTimeout(timer.current); setTip(false); }}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (!long.current) p.onPress(); }}
      >
        <SlotIcon slot={p.slot} size={32} />
        <svg className="slot-ring" viewBox="0 0 72 72" aria-hidden="true">
          {p.cdFrac > 0 && <circle cx="36" cy="36" r="34" strokeDasharray={`${C * p.cdFrac} ${C}`} transform="rotate(-90 36 36)" />}
        </svg>
        {p.waiting && <span className="spinner slot-spin" aria-hidden="true" />}
      </button>
      <span className="slot-cost" aria-hidden="true">{"•".repeat(p.cost)}</span>
      {p.showLabel && <span className="slot-label">{SHORT[p.slot]}</span>}
      {tip && <span className="slot-tip" role="tooltip"><strong>{name}</strong><br />{t(p.pack, `action.${p.id}.desc`)}</span>}
    </div>
  );
}
