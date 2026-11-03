// Package minigame is the catalog of short mini games that go with actions,
// and the server's scoring for them. The client never sends a score: it sends
// raw inputs (times in ms since the round started, plus a direction for a
// flick), and Score turns them into a quality q in [0, 1] using a layout
// that only the seed decides. apps/web/src/minigame/core.ts mirrors this file
// so the client can show Perfect or Miss at once; this one is the judge.
//
// Games are not tied to a slot or a cult: a pack picks any catalog game for
// each of its slots and supplies its own skin (art, sounds, words).
package minigame

import (
	"math"
	"sort"
)

// Game ids. New games are appended; ids never change meaning.
const (
	Flick  = "flick"  // flick a flyer at people walking past
	Timing = "timing" // tap when the needle is in the zone
	Beat   = "beat"   // tap on the beat
)

// Catalog lists every game the engine knows.
var Catalog = []string{Flick, Timing, Beat}

// Known reports whether id is a catalog game.
func Known(id string) bool {
	for _, g := range Catalog {
		if g == id {
			return true
		}
	}
	return false
}

// SkipQuality is what a skipped, expired or rejected round scores. It gives
// exactly the old, no-game numbers (gain x1, heat x1).
const SkipQuality = 0.5

// Gain multiplies an action's yield-scaled gains; Heat multiplies its
// scrutiny and paranoia increases. q = 0.5 gives 1 and 1.
func Gain(q float64) float64 { return 0.6 + 0.8*clamp01(q) }
func Heat(q float64) float64 { return 1.3 - 0.6*clamp01(q) }

// Input is one player input. T is ms since the round started. X and Y are a
// flick's direction (screen space, Y grows downward); taps leave them zero.
type Input struct {
	T float64 `json:"t"`
	X float64 `json:"x,omitempty"`
	Y float64 `json:"y,omitempty"`
}

// MaxInputs caps how many inputs a round may carry.
const MaxInputs = 60

// ---- deterministic random numbers (mulberry32, mirrored in TypeScript) ----

type rng struct{ a uint32 }

func (r *rng) next() float64 {
	r.a += 0x6D2B79F5
	t := r.a
	t = (t ^ t>>15) * (t | 1)
	t ^= t + (t^t>>7)*(t|61)
	return float64(t^t>>14) / 4294967296
}

// ---- layouts ----

// Stranger walks across lane Y from X0 starting at Start ms.
type Stranger struct {
	Y     float64 `json:"y"`
	X0    float64 `json:"x0"`
	Dir   float64 `json:"dir"`
	Speed float64 `json:"speed"` // field units per second
	Start float64 `json:"start"` // ms
}

// Zone is a sweet spot on the timing bar.
type Zone struct {
	C float64 `json:"c"`
	W float64 `json:"w"` // half width
}

// Layout is everything a round shows, decided by the seed.
type Layout struct {
	Game      string     `json:"game"`
	LengthMs  float64    `json:"lengthMs"`
	Strangers []Stranger `json:"strangers,omitempty"`
	Zones     []Zone     `json:"zones,omitempty"`
	PeriodMs  float64    `json:"periodMs,omitempty"`
	Beats     []float64  `json:"beats,omitempty"`
}

// Flick tuning: the flyer leaves from (FlickX, FlickY) at FlickSpeed.
const (
	FlickX     = 0.5
	FlickY     = 0.92
	FlickSpeed = 1.8
	flickGap   = 250.0
	timingGap  = 200.0
	beatGap    = 80.0
)

// NewLayout builds the round for a game and seed.
func NewLayout(game string, seed uint32) Layout {
	r := &rng{a: seed}
	switch game {
	case Flick:
		l := Layout{Game: game}
		for k := 0; k < 3; k++ {
			dir := 1.0
			if r.next() < 0.5 {
				dir = -1
			}
			x0 := -0.1
			if dir < 0 {
				x0 = 1.1
			}
			l.Strangers = append(l.Strangers, Stranger{
				Y: 0.22 + 0.16*float64(k), X0: x0, Dir: dir,
				Speed: 0.45 + 0.2*r.next(), Start: 300 + 1300*float64(k),
			})
		}
		l.LengthMs = l.Strangers[2].Start + 2600
		return l
	case Timing:
		l := Layout{Game: game, PeriodMs: 1600, LengthMs: 5500}
		for k, w := range []float64{0.13, 0.11, 0.09} {
			_ = k
			l.Zones = append(l.Zones, Zone{C: 0.2 + 0.6*r.next(), W: w})
		}
		return l
	case Beat:
		l := Layout{Game: game}
		interval := 500 + math.Floor(r.next()*5)*40
		for j := 0; j < 6; j++ {
			l.Beats = append(l.Beats, 1200+float64(j)*interval)
		}
		l.LengthMs = l.Beats[5] + 700
		return l
	}
	return Layout{Game: game}
}

// Needle is the timing bar's needle position (0..1) at t ms.
func Needle(periodMs, t float64) float64 {
	ph := math.Mod(t, periodMs) / periodMs
	if ph < 0.5 {
		return ph * 2
	}
	return 2 - ph*2
}

// StrangerX is where a stranger is at t ms.
func StrangerX(s Stranger, t float64) float64 {
	return s.X0 + s.Dir*s.Speed*(t-s.Start)/1000
}

// Grades for one input.
const (
	Miss    = 0.0
	Good    = 0.6
	Perfect = 1.0
)

// Score returns q in [0, 1] and the grade of each scored input. elapsedMs is
// the server's own measure of the round's length; inputs that claim a later
// time than that (plus slack) mean a forged clock, and the round scores as
// a skip with ok false.
func Score(game string, seed uint32, inputs []Input, elapsedMs float64) (q float64, grades []float64, ok bool) {
	l := NewLayout(game, seed)
	if l.LengthMs == 0 || len(inputs) > MaxInputs {
		return SkipQuality, nil, false
	}
	in := make([]Input, 0, len(inputs))
	for _, i := range inputs {
		if math.IsNaN(i.T) || math.IsInf(i.T, 0) || math.IsNaN(i.X) || math.IsNaN(i.Y) || math.IsInf(i.X, 0) || math.IsInf(i.Y, 0) {
			return SkipQuality, nil, false
		}
		if i.T > elapsedMs+300 {
			return SkipQuality, nil, false
		}
		if i.T < 0 || i.T > l.LengthMs {
			continue
		}
		in = append(in, i)
	}
	sort.SliceStable(in, func(a, b int) bool { return in[a].T < in[b].T })
	switch game {
	case Flick:
		in = spaced(in, flickGap)
		for k, s := range l.Strangers {
			g := Miss
			if k < len(in) {
				g = flickGrade(s, in[k])
			}
			grades = append(grades, g)
		}
		return mean(grades), grades, true
	case Timing:
		in = spaced(in, timingGap)
		for k, z := range l.Zones {
			g := Miss
			if k < len(in) {
				g = band(math.Abs(Needle(l.PeriodMs, in[k].T)-z.C), z.W*0.4, z.W)
			}
			grades = append(grades, g)
		}
		return mean(grades), grades, true
	case Beat:
		in = spaced(in, beatGap)
		grades = make([]float64, len(l.Beats))
		used := make([]bool, len(l.Beats))
		extra := 0
		for _, i := range in {
			best, bestErr := -1, 200.0
			for j, b := range l.Beats {
				if e := math.Abs(i.T - b); !used[j] && e <= bestErr {
					best, bestErr = j, e
				}
			}
			if best < 0 {
				extra++
				continue
			}
			used[best] = true
			grades[best] = band(bestErr, 60, 140)
		}
		sum := 0.0
		for _, g := range grades {
			sum += g
		}
		return clamp01((sum - 0.5*float64(extra)) / float64(len(l.Beats))), grades, true
	}
	return SkipQuality, nil, false
}

// flickGrade: where is the flyer when it reaches the stranger's lane, and
// how far is the stranger from it then?
func flickGrade(s Stranger, i Input) float64 {
	n := math.Hypot(i.X, i.Y)
	if n == 0 || i.Y >= 0 {
		return Miss
	}
	dx, dy := i.X/n, i.Y/n
	tt := (FlickY - s.Y) / (-dy * FlickSpeed) // seconds
	fx := FlickX + dx*FlickSpeed*tt
	at := i.T + tt*1000
	if at < s.Start {
		return Miss
	}
	return band(math.Abs(fx-StrangerX(s, at)), 0.05, 0.11)
}

func band(err, perfect, good float64) float64 {
	switch {
	case err <= perfect:
		return Perfect
	case err <= good:
		return Good
	}
	return Miss
}

// spaced drops inputs closer than gap ms to the last kept one, so mashing
// doesn't sample every position.
func spaced(in []Input, gap float64) []Input {
	out := in[:0:0]
	for _, i := range in {
		if len(out) > 0 && i.T-out[len(out)-1].T < gap {
			continue
		}
		out = append(out, i)
	}
	return out
}

func mean(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range v {
		s += x
	}
	return s / float64(len(v))
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }

// Watch tracks one player's recent rounds. A long run of near-perfect play is
// not humanly plausible; after it the player's rounds score as skips for the
// rest of the Day.
type Watch struct {
	Recent  []float64
	Clamped bool
}

const (
	watchWindow = 20
	watchMax    = 0.97
)

// Note records a round's q and returns the q to apply.
func (w *Watch) Note(q float64) float64 {
	if w.Clamped {
		return math.Min(q, SkipQuality)
	}
	w.Recent = append(w.Recent, q)
	if len(w.Recent) > watchWindow {
		w.Recent = w.Recent[len(w.Recent)-watchWindow:]
	}
	if len(w.Recent) == watchWindow && mean(w.Recent) > watchMax {
		w.Clamped = true
		return math.Min(q, SkipQuality)
	}
	return q
}
