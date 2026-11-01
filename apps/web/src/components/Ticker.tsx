import { t } from "../packs";
import { useStore } from "../store";

/** The world ticker: the newest events, worded from each cult's pack. */
export function Ticker() {
  const { world, packs } = useStore();
  const evs = [...(world?.events ?? [])].reverse().slice(0, 6);
  if (!evs.length) return null;
  return (
    <ul className="ticker" aria-live="polite">
      {evs.map((e, i) => {
        const pack = e.cult ? packs[e.cult] : undefined;
        const name = t(pack, "name");
        let text: string;
        if (e.kind === "fall" || e.kind === "exposed") text = `${name} fell`;
        else if (e.kind === "milestone") text = t(pack, "event.milestone", { cult: name, pct: e.data?.pct ?? "" });
        else if (e.kind === "win") text = t(pack, "event.win", { cult: name });
        else text = t(pack, e.key, { cult: name });
        const time = new Date(e.at * 1000).toUTCString().slice(17, 22);
        return <li key={`${e.at}-${i}`}><span className="mono muted">{time}</span> {text}</li>;
      })}
    </ul>
  );
}
