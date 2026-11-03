package engine

import (
	"math"
	"sort"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/minigame"
)

// Engine applies the generic rules to whatever packs a Day was opened with.
// No code here names a cult.
type Engine struct {
	C *content.Content
}

func New(c *content.Content) *Engine { return &Engine{C: c} }

// NewDay opens a Day with fresh stats for every cult in the roster.
func (e *Engine) NewDay(dayID string, start, end int64, yields map[string]float64) *WorldDay {
	d := &WorldDay{
		DayID: dayID, ContentHash: e.C.Hash, Phase: PhaseLive,
		StartedAt: start, EndsAt: end, LastTick: start,
		Roster: append([]string(nil), e.C.Roster...), Cults: map[string]*CultState{},
		Events: []Event{},
	}
	for _, id := range e.C.Roster {
		p := e.C.Packs[id]
		cs := &CultState{ID: id, Status: StatusStanding, Stats: map[string]float64{}, Yield: 1,
			Buffs: []Buff{}, Timers: []Timer{}, Contrib: map[string]*Contributor{}}
		if y, ok := yields[id]; ok && y > 0 {
			cs.Yield = y
		}
		for k, r := range p.Stats {
			cs.Stats[k] = r.Initial
		}
		if len(p.Phases) > 0 {
			cs.Phase = p.Phases[0].ID
		}
		cs.Progress = e.progress(p, cs, start, d.EndsAt)
		d.Cults[id] = cs
	}
	return d
}

func env(cs *CultState, now, endsAt int64) content.Env {
	return content.Env{Cult: cs.Stats, Phase: cs.Phase, MinutesToReset: float64(endsAt-now) / 60}
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

func (e *Engine) progress(p *content.Pack, cs *CultState, now, endsAt int64) float64 {
	ev := env(cs, now, endsAt)
	if n := len(p.Phases); n > 0 {
		i := cs.PhaseIndex
		if i >= n {
			return 1
		}
		return (float64(i) + clamp01(p.Phases[i].Progress.Num(ev))) / float64(n)
	}
	v := p.Progress.Num(ev)
	if math.IsNaN(v) {
		return 0
	}
	return clamp01(v)
}

// fairness = min(1, sqrt(average players per cult / players in this cult)).
func (d *WorldDay) fairness(cs *CultState) float64 {
	total := 0
	for _, c := range d.Cults {
		total += c.Players
	}
	if cs.Players <= 0 || total == 0 {
		return 1
	}
	avg := float64(total) / float64(len(d.Cults))
	return math.Min(1, math.Sqrt(avg/float64(cs.Players)))
}

func buffMul(cs *CultState, action string, now int64) float64 {
	m := 1.0
	for _, b := range cs.Buffs {
		if b.Target == action && b.Until > now {
			m *= b.Mul
		}
	}
	return m
}

// applyEffects runs effects in order; each sees the stats left by the one
// before. scaledMul multiplies add values of effects marked scale: yield;
// heatMul multiplies positive adds to scrutiny and paranoia.
func (e *Engine) applyEffects(p *content.Pack, cs *CultState, effs []content.Effect, scaledMul, heatMul float64, now, endsAt int64, deltas map[string]float64) {
	for _, ef := range effs {
		r, ok := p.Stats[ef.Stat]
		if !ok {
			continue
		}
		before := cs.Stats[ef.Stat]
		v := ef.Value.Num(env(cs, now, endsAt))
		var after float64
		switch ef.Op {
		case content.OpAdd:
			if ef.Scaled {
				v *= scaledMul
			}
			if v > 0 && (ef.Stat == "scrutiny" || ef.Stat == "paranoia") {
				v *= heatMul
			}
			after = before + v
		case content.OpMul:
			after = before * v
		case content.OpSet:
			after = v
		}
		if math.IsNaN(after) || math.IsInf(after, 0) {
			continue
		}
		after = math.Max(r.Min, math.Min(r.Max, after))
		cs.Stats[ef.Stat] = after
		if deltas != nil {
			deltas[ef.Stat] += after - before
		}
	}
}

func (e *Engine) addEvent(d *WorldDay, ev Event) {
	d.Events = append(d.Events, ev)
}

// Available reports whether an action can be taken now, for the snapshot's
// per-action flags. The client never evaluates expressions itself.
func (e *Engine) Available(d *WorldDay, cultID, actionID string, now int64) bool {
	p, cs := e.C.Packs[cultID], d.Cults[cultID]
	if p == nil || cs == nil || cs.Status != StatusStanding || d.Phase != PhaseLive {
		return false
	}
	a := p.Actions[actionID]
	if a == nil || (a.Phases != nil && !a.Phases[cs.Phase]) {
		return false
	}
	return a.Requires.Bool(env(cs, now, d.EndsAt))
}

// Apply applies one action. Actions are applied strictly one at a time by
// the single writer, so only one cult can cross its target first.
func (e *Engine) Apply(d *WorldDay, r ActionReq) ActionResult {
	if d.Phase != PhaseLive {
		return ActionResult{Reason: "day_over"}
	}
	p, cs := e.C.Packs[r.Cult], d.Cults[r.Cult]
	if p == nil || cs == nil {
		return ActionResult{Reason: "unknown_cult"}
	}
	if cs.Status != StatusStanding {
		return ActionResult{Reason: "cult_ended"}
	}
	now := r.At
	deltas := map[string]float64{}
	before := cs.Progress
	res := ActionResult{OK: true, Deltas: deltas}

	if r.Defector {
		if !e.applyDefector(p, cs, r, &res, now, d.EndsAt) {
			return res
		}
	} else {
		a := p.Actions[r.Action]
		if a == nil {
			return ActionResult{Reason: "unknown_action"}
		}
		if a.Phases != nil && !a.Phases[cs.Phase] {
			return ActionResult{Reason: "wrong_phase"}
		}
		if !a.Requires.Bool(env(cs, now, d.EndsAt)) {
			return ActionResult{Reason: "requirement"}
		}
		mul := cs.Yield * d.fairness(cs) * buffMul(cs, a.ID, now)
		if r.Converged {
			mul *= ConvergenceMul
		}
		heat := 1.0
		if r.Played {
			// The action's mini game: playing well pays more and draws less heat.
			mul *= minigame.Gain(r.Quality)
			heat = minigame.Heat(r.Quality)
		}
		e.applyEffects(p, cs, a.Effects, mul, heat, now, d.EndsAt, deltas)
		if a.Buff != nil {
			b := Buff{ID: a.Buff.ID, Target: a.Buff.Target, Mul: a.Buff.Mul, Until: now + int64(a.Buff.DurationMin*60)}
			replaced := false
			for i := range cs.Buffs {
				if cs.Buffs[i].ID == b.ID {
					cs.Buffs[i], replaced = b, true
				}
			}
			if !replaced {
				cs.Buffs = append(cs.Buffs, b)
			}
		}
		cs.Actions++
	}
	d.Seq++
	cs.Progress = e.progress(p, cs, now, d.EndsAt)
	if gain := cs.Progress - before; gain > 0 && !r.Defector {
		res.Contribution = gain
		c := cs.Contrib[r.UserID]
		if c == nil {
			c = &Contributor{Name: r.Name}
			cs.Contrib[r.UserID] = c
		}
		c.Value += gain
	}
	e.milestones(d, cs, now)
	e.checkCult(d, p, cs, now)
	e.checkDayEnd(d, now)
	return res
}

func (e *Engine) applyDefector(p *content.Pack, cs *CultState, r ActionReq, res *ActionResult, now, endsAt int64) bool {
	// Each extra defector adds less than the last. A played mini game
	// scales the effect like a cult action's gain.
	dim := 1 / math.Sqrt(math.Max(1, float64(cs.Defectors)))
	if r.Played {
		dim *= minigame.Gain(r.Quality)
	}
	var effs []content.Effect
	switch r.Action {
	case "gather_evidence":
		effs = []content.Effect{{Stat: "exposure", Op: content.OpAdd, Value: content.ConstExpr(2 * dim)}}
		res.EvidenceGain = 1
	case "call_family":
		effs = []content.Effect{{Stat: "loyalty", Op: content.OpAdd, Value: content.ConstExpr(-1 * dim)}}
	case "talk_to_journalist":
		if r.Evidence < content.EvidenceForJournalist {
			*res = ActionResult{Reason: "need_evidence"}
			return false
		}
		effs = []content.Effect{
			{Stat: "exposure", Op: content.OpAdd, Value: content.ConstExpr(10 * dim)},
			{Stat: "scrutiny", Op: content.OpAdd, Value: content.ConstExpr(3 * dim)},
		}
		res.EvidenceUsed = content.EvidenceForJournalist
	default:
		*res = ActionResult{Reason: "unknown_action"}
		return false
	}
	e.applyEffects(p, cs, effs, 1, 1, now, endsAt, res.Deltas)
	return true
}

func (e *Engine) milestones(d *WorldDay, cs *CultState, now int64) {
	step := int(cs.Progress * 4) // 25% steps
	if step > 3 {
		step = 3
	}
	for cs.Milestone < step {
		cs.Milestone++
		e.addEvent(d, Event{At: now, Kind: "milestone", Cult: cs.ID, Key: "event.milestone",
			Data: map[string]any{"pct": cs.Milestone * 25}})
	}
}

func (e *Engine) checkCult(d *WorldDay, p *content.Pack, cs *CultState, now int64) {
	if cs.Status != StatusStanding || d.Phase != PhaseLive {
		return
	}
	ev := env(cs, now, d.EndsAt)
	for _, f := range p.Falls {
		if f.When.Bool(ev) {
			cs.Status, cs.FallReason, cs.FallText, cs.Historical, cs.EndedAt = StatusFallen, f.Reason, f.Text, f.Historical, now
			e.addEvent(d, Event{At: now, Kind: "fall", Cult: cs.ID, Key: f.Text, Data: map[string]any{"reason": f.Reason}})
			return
		}
	}
	if cs.Stats["exposure"] >= 100 {
		cs.Status, cs.FallReason, cs.FallText, cs.EndedAt = StatusExposed, "exposed", "core.fall.exposed", now
		e.addEvent(d, Event{At: now, Kind: "exposed", Cult: cs.ID, Key: "core.fall.exposed"})
		return
	}
	// Phases: completing a phase moves to the next; the last one wins.
	if n := len(p.Phases); n > 0 {
		for cs.PhaseIndex < n {
			ph := p.Phases[cs.PhaseIndex]
			if ph.Progress.Num(ev) < 1 || !ph.Guard.Bool(ev) {
				break
			}
			if ph.Next == "" || cs.PhaseIndex == n-1 {
				e.win(d, cs, now)
				return
			}
			cs.PhaseIndex++
			cs.Phase = p.Phases[cs.PhaseIndex].ID
			e.addEvent(d, Event{At: now, Kind: "phase", Cult: cs.ID, Key: "phase." + cs.Phase})
			ev = env(cs, now, d.EndsAt)
		}
		cs.Progress = e.progress(p, cs, now, d.EndsAt)
		return
	}
	if cs.Progress >= 1 && p.Guard.Bool(ev) {
		e.win(d, cs, now)
	}
}

func (e *Engine) win(d *WorldDay, cs *CultState, now int64) {
	cs.Status, cs.EndedAt, cs.Progress = StatusWon, now, 1
	e.addEvent(d, Event{At: now, Kind: "win", Cult: cs.ID, Key: "event.win"})
	e.end(d, EndTarget, cs.ID, now)
}

func (e *Engine) end(d *WorldDay, reason, winner string, now int64) {
	if d.Phase != PhaseLive {
		return
	}
	d.Phase, d.EndReason, d.Winner, d.EndedAt = PhaseConcluded, reason, winner, now
	e.addEvent(d, Event{At: now, Kind: "day_end", Cult: winner, Key: "event.day_end." + reason})
}

func (e *Engine) checkDayEnd(d *WorldDay, now int64) {
	if d.Phase != PhaseLive {
		return
	}
	standing := 0
	for _, c := range d.Cults {
		if c.Status == StatusStanding {
			standing++
		}
	}
	if standing == 0 {
		e.end(d, EndAllFallen, "", now)
		return
	}
	if now >= d.EndsAt {
		// Time ran out: the highest Progress among standing cults leads, unfinished.
		ids := append([]string(nil), d.Roster...)
		sort.SliceStable(ids, func(i, j int) bool { return d.Cults[ids[i]].Progress > d.Cults[ids[j]].Progress })
		leader := ""
		for _, id := range ids {
			if d.Cults[id].Status == StatusStanding {
				leader = id
				break
			}
		}
		e.end(d, EndTimeUp, leader, now)
	}
}

// Tick runs the per-minute rules for every whole minute since the last tick:
// upkeep and drift, buff expiry, scheduled events, then win and fall checks.
func (e *Engine) Tick(d *WorldDay, now int64) {
	for d.Phase == PhaseLive && d.LastTick+TickSec <= now {
		d.LastTick += TickSec
		t := d.LastTick
		for _, id := range d.Roster {
			cs, p := d.Cults[id], e.C.Packs[id]
			if cs.Status != StatusStanding {
				continue
			}
			e.applyEffects(p, cs, content.CoreTick(), 1, 1, t, d.EndsAt, nil)
			if cs.Stats["loyalty"] < LowLoyalty {
				cs.Stats["followers"] = math.Floor(cs.Stats["followers"] * LowLoyaltyLeak)
			}
			e.applyEffects(p, cs, p.Tick, 1, 1, t, d.EndsAt, nil)
			live := cs.Buffs[:0]
			for _, b := range cs.Buffs {
				if b.Until > t {
					live = append(live, b)
				}
			}
			cs.Buffs = live
			e.events(d, p, cs, t)
			cs.Progress = e.progress(p, cs, t, d.EndsAt)
			e.milestones(d, cs, t)
			e.checkCult(d, p, cs, t)
		}
		e.checkDayEnd(d, t)
	}
	if d.Phase == PhaseLive && now >= d.EndsAt {
		e.checkDayEnd(d, now)
	}
}

func (e *Engine) events(d *WorldDay, p *content.Pack, cs *CultState, now int64) {
	if len(p.Events) == 0 {
		return
	}
	if cs.Fired == nil {
		cs.Fired = map[string]bool{}
	}
	ev := env(cs, now, d.EndsAt)
	for _, sc := range p.Events {
		if cs.Fired[sc.ID] {
			continue
		}
		var timer *Timer
		for i := range cs.Timers {
			if cs.Timers[i].ID == sc.ID {
				timer = &cs.Timers[i]
			}
		}
		if timer == nil {
			if sc.After.Bool(ev) {
				cs.Timers = append(cs.Timers, Timer{ID: sc.ID, At: now + int64(sc.DelayMin*60)})
			}
			continue
		}
		if now < timer.At {
			continue
		}
		cs.Fired[sc.ID] = true
		pass := sc.Check.Bool(ev)
		if pass {
			e.applyEffects(p, cs, sc.Pass, 1, 1, now, d.EndsAt, nil)
		} else {
			e.applyEffects(p, cs, sc.Fail, 1, 1, now, d.EndsAt, nil)
		}
		e.addEvent(d, Event{At: now, Kind: "event", Cult: cs.ID, Key: sc.Text, Data: map[string]any{"id": sc.ID, "pass": pass}})
	}
}

// Energy returns a player's energy at now, refilling 1 per EnergyRefillSec.
func Energy(pd *PlayerDay, now int64) (float64, int64) {
	if pd.Energy >= MaxEnergy {
		return pd.Energy, now
	}
	gained := (now - pd.EnergyAt) / EnergyRefillSec
	if gained <= 0 {
		return pd.Energy, pd.EnergyAt
	}
	en := pd.Energy + float64(gained)
	at := pd.EnergyAt + gained*EnergyRefillSec
	if en >= MaxEnergy {
		return MaxEnergy, now
	}
	return en, at
}

// Outcome is a player's personal result once the Day has ended.
func Outcome(d *WorldDay, pd *PlayerDay) string {
	if d.Phase != PhaseConcluded {
		return ""
	}
	cs := d.Cults[pd.Cult]
	if cs == nil {
		return OutcomeLost
	}
	if pd.Defected {
		if cs.Status == StatusExposed || (cs.Status == StatusFallen && cs.FallReason != "" && cs.Stats["scrutiny"] >= 100) {
			return OutcomeDefector
		}
		return OutcomeLost
	}
	switch cs.Status {
	case StatusWon:
		return OutcomeWinner
	case StatusFallen, StatusExposed:
		return OutcomeFell
	}
	if d.EndReason == EndTimeUp {
		return OutcomeUnfinished
	}
	return OutcomeLost
}
