// The mini game overlay. It draws the round the server seeded, records raw
// inputs (ms since the round started, plus a direction for a flick), and
// sends them. Grades shown here are a preview; the server scores the inputs.
import { useEffect, useRef, useState } from "react";
import { finishRound } from "../game";
import { FLICK_X, FLICK_Y, FLICK_SPEED, flickGrade, layout, needle, spaced, strangerX, timingGrade, type Input, type Layout } from "../minigame/core";
import { iconOf, type ActionDef } from "../packs";
import type { Round } from "../store";
import { gradeMark, SlotIcon } from "./SlotIcon";

interface Pop { x: number; y: number; g: number; at: number }

export function MiniGame({ round, def }: { round: Round; def: ActionDef }) {
  const l = useRef<Layout>(layout(round.game, round.seed)).current;
  const inputs = useRef<Input[]>([]);
  const [, frame] = useState(0);
  const [pops, setPops] = useState<Pop[]>([]);
  const box = useRef<SVGSVGElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  const done = useRef(false);
  const t = performance.now() - round.at;

  const finish = (skip = false) => {
    if (done.current) return;
    done.current = true;
    finishRound(inputs.current, skip);
  };

  // Redraw every frame; end the round when its time is up or every input is used.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const now = performance.now() - round.at;
      if (now >= l.lengthMs) return finish();
      const used = spaced(l.game, inputs.current).length;
      if (l.game === "timing" && used >= 3) return finish();
      if (l.game === "flick" && used >= 3 && now > inputs.current[inputs.current.length - 1].t + 700) return finish();
      if (l.game === "beat" && now > l.beats![5] + 260) return finish();
      frame((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toUnits = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const at = performance.now() - round.at;
    const p = toUnits(e);
    if (l.game === "flick") {
      down.current = p;
      return;
    }
    const kept = spaced(l.game, inputs.current);
    inputs.current.push({ t: at });
    if (spaced(l.game, inputs.current).length === kept.length) return; // too soon after the last tap
    if (l.game === "timing" && kept.length < 3) {
      setPops((ps) => [...ps, { x: 0.1 + 0.8 * needle(l.periodMs!, at), y: 0.4, g: timingGrade(l, kept.length, at), at: performance.now() }]);
    }
    if (l.game === "beat") {
      const near = l.beats!.reduce((b, x) => (Math.abs(x - at) < Math.abs(b - at) ? x : b));
      const err = Math.abs(near - at);
      setPops((ps) => [...ps, { x: 0.5, y: 0.22, g: err <= 60 ? 1 : err <= 140 ? 0.6 : 0, at: performance.now() }]);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (l.game !== "flick" || !down.current) return;
    const at = performance.now() - round.at;
    const p = toUnits(e);
    const s = down.current;
    down.current = null;
    // A drag throws along the drag; a plain tap throws toward the tapped point.
    let dx = p.x - s.x, dy = p.y - s.y;
    if (Math.hypot(dx, dy) < 0.04) { dx = p.x - FLICK_X; dy = p.y - FLICK_Y; }
    if (dy >= 0) return;
    const kept = spaced("flick", inputs.current);
    if (kept.length >= 3) return;
    inputs.current.push({ t: at, x: dx, y: dy });
    if (spaced("flick", inputs.current).length === kept.length) return;
    const k = kept.length, st = l.strangers![k];
    const n = Math.hypot(dx, dy);
    const tt = (FLICK_Y - st.y) / ((-dy / n) * FLICK_SPEED);
    const g = flickGrade(st, { t: at, x: dx, y: dy });
    setPops((ps) => [...ps, { x: FLICK_X + (dx / n) * FLICK_SPEED * tt, y: st.y - 0.06, g, at: performance.now() + tt * 1000 }]);
  };

  const now = performance.now();
  const slot = iconOf(def);
  const skin = def.skin ?? {};
  return (
    <div className="minigame" role="dialog" aria-label="Mini game">
      <div className="mg-head">
        <span className={`mg-slot slot-${slot}`}><SlotIcon slot={slot} size={22} /></span>
        <span className="mg-bar"><span style={{ width: `${Math.min(100, (t / l.lengthMs) * 100)}%` }} /></span>
        <button className="round mg-skip" onClick={() => finish(true)} aria-label="Skip the mini game" title="Skip">⏭</button>
      </div>
      <svg ref={box} className="mg-field" viewBox="0 0 100 100" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (down.current = null)}>
        {l.game === "flick" && <Flick l={l} t={t} inputs={spaced("flick", inputs.current)} skin={skin} />}
        {l.game === "timing" && <Timing l={l} t={t} next={spaced("timing", inputs.current).length} skin={skin} />}
        {l.game === "beat" && <Beat l={l} t={t} skin={skin} />}
        {pops.filter((p) => now >= p.at && now - p.at < 700).map((p, i) => (
          <text key={i} x={p.x * 100} y={p.y * 100 - (now - p.at) / 60} className={`mg-pop g${Math.round(p.g * 10)}`} textAnchor="middle">{gradeMark(p.g)}</text>
        ))}
      </svg>
    </div>
  );
}

function Flick({ l, t, inputs, skin }: { l: Layout; t: number; inputs: Input[]; skin: ActionDef["skin"] & {} }) {
  const next = inputs.length;
  return (
    <g>
      {l.strangers!.map((s, k) => {
        if (t < s.start) return null;
        const x = strangerX(s, t);
        if (x < -0.15 || x > 1.15) return null;
        return (
          <g key={k} opacity={k === next ? 1 : 0.45}>
            {k === next && <circle cx={x * 100} cy={s.y * 100} r={7} className="mg-target" />}
            <text x={x * 100} y={s.y * 100 + 3.5} textAnchor="middle" className="mg-emoji">{skin.target ?? "🧑"}</text>
          </g>
        );
      })}
      {inputs.map((i, k) => {
        const n = Math.hypot(i.x!, i.y!);
        const d = (FLICK_SPEED * (t - i.t)) / 1000;
        const y = FLICK_Y + (i.y! / n) * d;
        if (y < l.strangers![k].y) return null;
        return <text key={k} x={(FLICK_X + (i.x! / n) * d) * 100} y={y * 100 + 2.5} textAnchor="middle" className="mg-emoji small">{skin.item ?? "📄"}</text>;
      })}
      {next < 3 && <text x={FLICK_X * 100} y={FLICK_Y * 100 + 2.5} textAnchor="middle" className="mg-emoji small">{skin.item ?? "📄"}</text>}
      <text x={92} y={96} textAnchor="end" className="mg-count">{"●".repeat(3 - Math.min(3, next))}</text>
    </g>
  );
}

function Timing({ l, t, next, skin }: { l: Layout; t: number; next: number; skin: ActionDef["skin"] & {} }) {
  const z = l.zones![Math.min(next, 2)];
  const x = (v: number) => 10 + 80 * v;
  return (
    <g>
      <rect x={10} y={46} width={80} height={8} rx={4} className="mg-track" />
      {next < 3 && (
        <>
          <rect x={x(z.c - z.w)} y={44} width={160 * z.w} height={12} rx={3} className="mg-zone" />
          <rect x={x(z.c - z.w * 0.4)} y={44} width={64 * z.w} height={12} rx={3} className="mg-zone-perfect" />
          <text x={x(z.c)} y={38} textAnchor="middle" className="mg-emoji">{skin.zone ?? "◆"}</text>
        </>
      )}
      <rect x={x(needle(l.periodMs!, t)) - 1} y={40} width={2} height={20} rx={1} className="mg-needle" />
      <text x={50} y={80} textAnchor="middle" className="mg-count">{"●".repeat(Math.max(0, 3 - next))}</text>
    </g>
  );
}

function Beat({ l, t, skin }: { l: Layout; t: number; skin: ActionDef["skin"] & {} }) {
  const next = l.beats!.find((b) => b > t - 140);
  const lead = next !== undefined ? next - t : Infinity;
  const pulse = l.beats!.some((b) => Math.abs(b - t) < 90);
  return (
    <g>
      {lead > -140 && lead < 800 && <circle cx={50} cy={50} r={14 + Math.max(0, lead) / 22} className="mg-approach" />}
      <circle cx={50} cy={50} r={pulse ? 15.5 : 14} className="mg-drum" />
      <text x={50} y={54} textAnchor="middle" className="mg-emoji">{skin.zone ?? "●"}</text>
    </g>
  );
}
