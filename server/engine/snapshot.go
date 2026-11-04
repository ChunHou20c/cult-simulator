package engine

import (
	"sort"

	"github.com/cult-simulator/server/content"
)

// AddPlayer changes a cult's player count (join, switch, defect).
func (e *Engine) AddPlayer(d *WorldDay, cult string, delta int) {
	if cs := d.Cults[cult]; cs != nil {
		cs.Players += delta
		if cs.Players < 0 {
			cs.Players = 0
		}
	}
}

// Defect records a defection from a cult: it loses a player and gains a defector.
func (e *Engine) Defect(d *WorldDay, cult string) {
	if cs := d.Cults[cult]; cs != nil {
		cs.Defectors++
		if cs.Players > 0 {
			cs.Players--
		}
	}
}

// CultView is one cult in the world snapshot sent to clients.
type CultView struct {
	ID         string             `json:"id" msgpack:"id"`
	Status     string             `json:"status" msgpack:"status"`
	FallReason string             `json:"fallReason,omitempty" msgpack:"fallReason,omitempty"`
	FallText   string             `json:"fallText,omitempty" msgpack:"fallText,omitempty"`
	Players    int                `json:"players" msgpack:"players"`
	Defectors  int                `json:"defectors" msgpack:"defectors"`
	Progress   float64            `json:"progress" msgpack:"progress"`
	Phase      string             `json:"phase,omitempty" msgpack:"phase,omitempty"`
	Stats      map[string]float64 `json:"stats" msgpack:"stats"`
	Buffs      []Buff             `json:"buffs" msgpack:"buffs"`
	Can        map[string]bool    `json:"can" msgpack:"can"` // per action: requires holds now
	Rite       *RiteView          `json:"rite,omitempty" msgpack:"rite,omitempty"`
}

// RiteView is a standing forbidden rite demand: when it falls due and how
// much resolve the cult has built against it.
type RiteView struct {
	Deadline int64   `json:"deadline" msgpack:"deadline"`
	Resolve  float64 `json:"resolve" msgpack:"resolve"`
	Need     float64 `json:"need" msgpack:"need"`
}

// Snapshot is the world as clients see it, about 1 KB per few cults.
type Snapshot struct {
	DayID       string     `json:"dayId" msgpack:"dayId"`
	ContentHash string     `json:"contentHash" msgpack:"contentHash"`
	Seq         int64      `json:"seq" msgpack:"seq"`
	Phase       string     `json:"phase" msgpack:"phase"`
	StartedAt   int64      `json:"startedAt" msgpack:"startedAt"`
	EndsAt      int64      `json:"endsAt" msgpack:"endsAt"`
	EndedAt     int64      `json:"endedAt,omitempty" msgpack:"endedAt,omitempty"`
	EndReason   string     `json:"endReason,omitempty" msgpack:"endReason,omitempty"`
	Winner      string     `json:"winner,omitempty" msgpack:"winner,omitempty"`
	ServerTime  int64      `json:"serverTime" msgpack:"serverTime"`
	Cults       []CultView `json:"cults" msgpack:"cults"`
	Events      []Event    `json:"events" msgpack:"events"`
}

// Snapshot builds the client view of the world. Stats are rounded to keep
// it small; the newest 12 events ride along for the ticker.
func (e *Engine) Snapshot(d *WorldDay, now int64) *Snapshot {
	s := &Snapshot{DayID: d.DayID, ContentHash: d.ContentHash, Seq: d.Seq, Phase: d.Phase,
		StartedAt: d.StartedAt, EndsAt: d.EndsAt, EndedAt: d.EndedAt, EndReason: d.EndReason,
		Winner: d.Winner, ServerTime: now}
	for _, id := range d.Roster {
		cs := d.Cults[id]
		v := CultView{ID: id, Status: cs.Status, FallReason: cs.FallReason, FallText: cs.FallText,
			Players: cs.Players, Defectors: cs.Defectors, Progress: round(cs.Progress, 4), Phase: cs.Phase,
			Stats: map[string]float64{}, Buffs: []Buff{}, Can: map[string]bool{}}
		for k, val := range cs.Stats {
			v.Stats[k] = round(val, 2)
		}
		for _, b := range cs.Buffs {
			if b.Until > now {
				v.Buffs = append(v.Buffs, b)
			}
		}
		if cs.Rite != nil && cs.Rite.Active && cs.Status == StatusStanding {
			v.Rite = &RiteView{Deadline: cs.Rite.Deadline, Resolve: round(cs.Rite.Resolve, 2), Need: content.RiteResolveNeed}
		}
		if p := e.C.Packs[id]; p != nil {
			for _, a := range p.Order {
				v.Can[a] = e.Available(d, id, a, now)
			}
		}
		s.Cults = append(s.Cults, v)
	}
	n := len(d.Events)
	start := n - 12
	if start < 0 {
		start = 0
	}
	s.Events = append([]Event{}, d.Events[start:]...)
	return s
}

func round(v float64, places int) float64 {
	p := 1.0
	for i := 0; i < places; i++ {
		p *= 10
	}
	if v < 0 {
		return -float64(int64(-v*p+0.5)) / p
	}
	if v > 1e15 {
		return v
	}
	return float64(int64(v*p+0.5)) / p
}

// TopContributors returns the top n contributors of a cult.
func TopContributors(cs *CultState, n int) []Contributor {
	all := make([]Contributor, 0, len(cs.Contrib))
	for _, c := range cs.Contrib {
		all = append(all, *c)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Value != all[j].Value {
			return all[i].Value > all[j].Value
		}
		return all[i].Name < all[j].Name
	})
	if len(all) > n {
		all = all[:n]
	}
	return all
}
