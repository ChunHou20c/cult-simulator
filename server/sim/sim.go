// Package sim plays whole Days with scripted bots against the engine, with
// no server. CI uses it for the per-pack balance run.
package sim

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/engine"
	"github.com/cult-simulator/server/minigame"
)

// Debug, when set, is called with the final state of every simulated Day.
var Debug func(*engine.WorldDay)

// Counts, when set, counts accepted actions by id.
var Counts map[string]int

type Config struct {
	PlayersPerCult int
	VisitsMin      int
	VisitsMax      int
	Smart          float64 // share of choices made by the greedy policy
	Seed           int64
	// Skill is the bots' average mini game quality (0..1); each bot varies
	// around it, and SkipRate of rounds are skipped (quality 0.5).
	Skill    float64
	SkipRate float64
}

func DefaultConfig() Config {
	return Config{PlayersPerCult: 25, VisitsMin: 3, VisitsMax: 7, Smart: 0.8, Skill: 0.65, SkipRate: 0.2}
}

type bot struct {
	id, cult string
	pd       engine.PlayerDay
	visits   []int64
	cooldown map[string]int64
	skill    float64
	// progressValue remembers how much Progress each action gave last time.
	progressValue map[string]float64
}

// Result of one simulated Day.
type Result struct {
	EndReason string
	Winner    string
	EndHour   float64
	Cults     map[string]CultResult
}

type CultResult struct {
	Status     string
	FallReason string
	Progress   float64
	EndHour    float64
	Actions    int
}

// RunDay plays one Day of 24 hours for the given content.
func RunDay(c *content.Content, cfg Config) Result {
	rng := rand.New(rand.NewSource(cfg.Seed))
	e := engine.New(c)
	const start = int64(1_800_000_000)
	end := start + 86400
	d := e.NewDay("sim", start, end, nil)

	var bots []*bot
	for _, id := range c.Roster {
		for i := 0; i < cfg.PlayersPerCult; i++ {
			b := &bot{id: fmt.Sprintf("%s-%d", id, i), cult: id, cooldown: map[string]int64{}, progressValue: map[string]float64{}}
			b.skill = math.Max(0, math.Min(1, cfg.Skill+rng.NormFloat64()*0.15))
			b.pd = engine.PlayerDay{UserID: b.id, Name: b.id, Cult: id, Energy: engine.MaxEnergy, EnergyAt: start}
			n := cfg.VisitsMin + rng.Intn(cfg.VisitsMax-cfg.VisitsMin+1)
			for v := 0; v < n; v++ {
				b.visits = append(b.visits, start+int64(rng.Intn(86400)))
			}
			sort.Slice(b.visits, func(i, j int) bool { return b.visits[i] < b.visits[j] })
			bots = append(bots, b)
			e.AddPlayer(d, id, 1)
		}
	}

	// Build the action timeline: each visit spends all energy, one action every 15 s.
	type act struct {
		at  int64
		bot *bot
	}
	var queue []act
	for _, b := range bots {
		for _, v := range b.visits {
			for k := 0; k < 40; k++ {
				queue = append(queue, act{at: v + int64(k*15), bot: b})
			}
		}
	}
	sort.SliceStable(queue, func(i, j int) bool { return queue[i].at < queue[j].at })

	for _, q := range queue {
		if d.Phase != engine.PhaseLive {
			break
		}
		if q.at >= end {
			break
		}
		e.Tick(d, q.at)
		if d.Phase != engine.PhaseLive {
			break
		}
		b := q.bot
		en, at := engine.Energy(&b.pd, q.at)
		b.pd.Energy, b.pd.EnergyAt = en, at
		a := choose(e, d, b, q.at, rng, cfg.Smart)
		if a == nil {
			continue
		}
		if b.pd.Energy < float64(a.Energy) {
			continue
		}
		req := engine.ActionReq{UserID: b.id, Name: b.id, Cult: b.cult, Action: a.ID, At: q.at}
		if a.Game != "" {
			req.Played, req.Quality = true, roundQuality(b, cfg, rng)
		}
		r := e.Apply(d, req)
		if r.OK {
			if Counts != nil {
				Counts[a.ID]++
			}
			b.pd.Energy -= float64(a.Energy)
			b.cooldown[a.ID] = q.at + int64(a.CooldownSec)
		}
	}
	e.Tick(d, end)
	if Debug != nil {
		Debug(d)
	}

	res := Result{EndReason: d.EndReason, Winner: d.Winner, Cults: map[string]CultResult{}}
	if d.EndedAt > 0 {
		res.EndHour = float64(d.EndedAt-start) / 3600
	}
	for id, cs := range d.Cults {
		cr := CultResult{Status: cs.Status, FallReason: cs.FallReason, Progress: cs.Progress, Actions: cs.Actions}
		if cs.EndedAt > 0 {
			cr.EndHour = float64(cs.EndedAt-start) / 3600
		}
		res.Cults[id] = cr
	}
	return res
}

// choose is a generic policy: try every ready action on a copy of the world,
// and also every follow-up action after it (so it learns that raising funds
// enables a costly signature action). Score is progress per energy minus a
// danger term that grows sharply near the fall lines. It never looks at
// cult ids.
func choose(e *engine.Engine, d *engine.WorldDay, b *bot, now int64, rng *rand.Rand, smart float64) *content.Action {
	p := e.C.Packs[b.cult]
	cs := d.Cults[b.cult]
	ready := readyActions(e, d, b, now, b.pd.Energy)
	if len(ready) == 0 {
		return nil
	}
	if rng.Float64() > smart {
		return ready[rng.Intn(len(ready))]
	}
	danger := func(s *engine.CultState) float64 {
		sc, pa, lo := s.Stats["scrutiny"], s.Stats["paranoia"], s.Stats["loyalty"]
		return math.Pow(sc/100, 6)*60 + math.Pow(pa/100, 6)*60 + math.Pow(math.Max(0, 50-lo)/50, 4)*60
	}
	res := resources(p)
	value := func(before, after *engine.CultState, energy float64) float64 {
		v := (after.Progress - before.Progress) * 1000
		for stat, actions := range res {
			// A resource is worth the progress it can buy through the
			// actions that spend it, learned from earlier trials.
			best := 0.0
			for _, ac := range actions {
				if before.Stats[stat] >= ac.cost*2 {
					continue // already enough for this one
				}
				if pv := b.progressValue[ac.id]; pv/ac.cost > best {
					best = pv / ac.cost
				}
			}
			v += (after.Stats[stat] - before.Stats[stat]) * best * 1000 * 0.8
		}
		return (v + (danger(before)-danger(after))*10) / energy
	}
	best, bestScore := ready[0], math.Inf(-1)
	for _, a := range ready {
		trial := cloneDay(d, b.cult)
		r := e.Apply(trial, engine.ActionReq{UserID: b.id, Cult: b.cult, Action: a.ID, At: now})
		if !r.OK {
			continue
		}
		ts := trial.Cults[b.cult]
		if g := ts.Progress - cs.Progress; g > 0 {
			b.progressValue[a.ID] = g
		}
		if ts.Status == engine.StatusWon {
			return a
		}
		if ts.Status != engine.StatusStanding {
			continue
		}
		score := value(cs, ts, float64(a.Energy))
		// One step of lookahead, discounted: only for actions this one
		// makes possible (for example raising the funds a signature needs).
		for _, id := range p.Order {
			n := p.Actions[id]
			if b.cooldown[id] > now+15 || e.Available(d, b.cult, id, now) || !e.Available(trial, b.cult, id, now) {
				continue
			}
			t2 := cloneDay(trial, b.cult)
			if r2 := e.Apply(t2, engine.ActionReq{UserID: b.id, Cult: b.cult, Action: id, At: now}); !r2.OK {
				continue
			}
			if s2 := value(cs, t2.Cults[b.cult], float64(a.Energy+n.Energy)) * 0.9; s2 > score && t2.Cults[b.cult].Status != engine.StatusFallen {
				score = s2
			}
		}
		if score > bestScore {
			best, bestScore = a, score
		}
	}
	return best
}

type spend struct {
	id   string
	cost float64
}

// resources finds stats that actions spend with a constant negative add,
// for example funds paid to open a building.
func resources(p *content.Pack) map[string][]spend {
	out := map[string][]spend{}
	for _, id := range p.Order {
		for _, ef := range p.Actions[id].Effects {
			if ef.Op != content.OpAdd || ef.Value == nil {
				continue
			}
			if v := ef.Value.Num(content.Env{}); v < 0 && ef.Value.Src != "" && !strings.Contains(ef.Value.Src, "cult.") && ef.Stat != "scrutiny" && ef.Stat != "paranoia" && ef.Stat != "exposure" && ef.Stat != "loyalty" {
				out[ef.Stat] = append(out[ef.Stat], spend{id: id, cost: -v})
			}
		}
	}
	return out
}

func readyActions(e *engine.Engine, d *engine.WorldDay, b *bot, now int64, energy float64) []*content.Action {
	p := e.C.Packs[b.cult]
	var ready []*content.Action
	for _, id := range p.Order {
		a := p.Actions[id]
		if b.cooldown[id] > now || float64(a.Energy) > energy || !e.Available(d, b.cult, id, now) {
			continue
		}
		ready = append(ready, a)
	}
	return ready
}

// cloneDay copies the parts of the world an action on one cult can touch.
func cloneDay(d *engine.WorldDay, cult string) *engine.WorldDay {
	c := *d
	c.Events = nil
	c.Cults = make(map[string]*engine.CultState, len(d.Cults))
	for id, cs := range d.Cults {
		if id != cult {
			c.Cults[id] = cs
			continue
		}
		n := *cs
		n.Stats = make(map[string]float64, len(cs.Stats))
		for k, v := range cs.Stats {
			n.Stats[k] = v
		}
		n.Buffs = append([]engine.Buff(nil), cs.Buffs...)
		n.Contrib = map[string]*engine.Contributor{}
		c.Cults[id] = &n
	}
	return &c
}

// Balance summarises many solo Days of one pack.
type Balance struct {
	Pack         string
	Runs         int
	Wins         int
	Falls        int
	MedianFinish float64 // hours; a run that did not win counts as never finishing
	FallRate     float64
	FallReasons  map[string]int
	MeanProgress float64
}

// BalancePack runs one pack alone for n Days.
func BalancePack(c *content.Content, id string, n int, cfg Config) Balance {
	solo := &content.Content{Roster: []string{id}, Packs: map[string]*content.Pack{id: c.Packs[id]}, Hash: c.Hash}
	bal := Balance{Pack: id, Runs: n, FallReasons: map[string]int{}}
	var finishes []float64
	for i := 0; i < n; i++ {
		cfg.Seed = int64(i + 1)
		r := RunDay(solo, cfg)
		cr := r.Cults[id]
		bal.MeanProgress += cr.Progress / float64(n)
		switch cr.Status {
		case engine.StatusWon:
			bal.Wins++
			finishes = append(finishes, cr.EndHour)
		case engine.StatusFallen, engine.StatusExposed:
			finishes = append(finishes, math.Inf(1))
			bal.Falls++
			bal.FallReasons[cr.FallReason]++
		default:
			finishes = append(finishes, math.Inf(1))
		}
	}
	sort.Float64s(finishes)
	if len(finishes) > 0 {
		bal.MedianFinish = finishes[len(finishes)/2]
	}
	bal.FallRate = float64(bal.Falls) / float64(n)
	return bal
}

// Pass applies the CI gate: median finish within 14 to 22 hours and at most
// 60% of runs fall.
func (b Balance) Pass() bool {
	return b.Wins > 0 && b.MedianFinish >= 14 && b.MedianFinish <= 22 && b.FallRate <= 0.6
}

// roundQuality is one bot's mini game result.
func roundQuality(b *bot, cfg Config, rng *rand.Rand) float64 {
	if rng.Float64() < cfg.SkipRate {
		return minigame.SkipQuality
	}
	return math.Max(0, math.Min(1, b.skill+rng.NormFloat64()*0.15))
}
