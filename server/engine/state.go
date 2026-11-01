// Package engine holds the pure game rules: applying actions to cult state,
// tick rules, win and fall checks. It has no Nakama dependency and no
// randomness, so the same inputs always give the same Day; the world match,
// the headless simulator and crash replay all run on it.
package engine

const (
	PhaseLive      = "live"
	PhaseConcluded = "concluded"

	StatusStanding = "standing"
	StatusWon      = "won"
	StatusFallen   = "fallen"
	StatusExposed  = "exposed"

	EndTarget    = "target_reached"
	EndAllFallen = "all_fallen"
	EndTimeUp    = "time_up"

	OutcomeWinner     = "winner"
	OutcomeDefector   = "defector_win"
	OutcomeFell       = "fell_with_cult"
	OutcomeUnfinished = "unfinished"
	OutcomeLost       = "lost"
)

// Engine settings (not pack content).
const (
	MaxEnergy        = 12
	EnergyRefillSec  = 600
	ConvergenceMul   = 1.5
	ConvergenceCount = 3
	ConvergenceSec   = 8
	TickSec          = 60
	LowLoyalty       = 30
	LowLoyaltyLeak   = 0.99
)

type Buff struct {
	ID     string  `json:"id"`
	Target string  `json:"target"`
	Mul    float64 `json:"mul"`
	Until  int64   `json:"until"`
}

type Timer struct {
	ID string `json:"id"`
	At int64  `json:"at"`
}

type Contributor struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

type CultState struct {
	ID         string             `json:"id"`
	Status     string             `json:"status"`
	FallReason string             `json:"fallReason,omitempty"`
	FallText   string             `json:"fallText,omitempty"`
	Historical bool               `json:"historical,omitempty"`
	EndedAt    int64              `json:"endedAt,omitempty"`
	Phase      string             `json:"phase,omitempty"`
	PhaseIndex int                `json:"phaseIndex,omitempty"`
	Players    int                `json:"players"`
	Defectors  int                `json:"defectors"`
	Stats      map[string]float64 `json:"stats"`
	Progress   float64            `json:"progress"`
	Yield      float64            `json:"yield"`
	Buffs      []Buff             `json:"buffs"`
	Timers     []Timer            `json:"timers"`
	Fired      map[string]bool    `json:"fired,omitempty"`
	Actions    int                `json:"actions"`
	Milestone  int                `json:"milestone"`
	Contrib    map[string]*Contributor `json:"contrib"`
}

type Event struct {
	At   int64          `json:"at"`
	Kind string         `json:"kind"` // milestone, fall, exposed, win, phase, event, day_end
	Cult string         `json:"cult,omitempty"`
	Key  string         `json:"key"`
	Data map[string]any `json:"data,omitempty"`
}

type WorldDay struct {
	DayID       string                `json:"dayId"`
	ContentHash string                `json:"contentHash"`
	Roster      []string              `json:"roster"`
	Phase       string                `json:"phase"`
	StartedAt   int64                 `json:"startedAt"`
	EndsAt      int64                 `json:"endsAt"`
	EndedAt     int64                 `json:"endedAt,omitempty"`
	EndReason   string                `json:"endReason,omitempty"`
	Winner      string                `json:"winner,omitempty"`
	Seq         int64                 `json:"seq"`
	LastTick    int64                 `json:"lastTick"`
	Cults       map[string]*CultState `json:"cults"`
	Events      []Event               `json:"events"`
}

// PlayerDay is one player's record for one Day.
type PlayerDay struct {
	DayID        string  `json:"dayId"`
	UserID       string  `json:"userId"`
	Name         string  `json:"name"`
	Cult         string  `json:"cult"`
	SwitchedFrom string  `json:"switchedFrom,omitempty"`
	Defected     bool    `json:"defected"`
	Energy       float64 `json:"energy"`
	EnergyAt     int64   `json:"energyAt"`
	Actions      int     `json:"actions"`
	Contribution float64 `json:"contribution"`
	Evidence     int     `json:"evidence"`
	Outcome      string  `json:"outcome,omitempty"`
}

// ActionReq is one player action as the compound forwards it to the world.
type ActionReq struct {
	UserID    string `json:"u"`
	Name      string `json:"n"`
	Cult      string `json:"c"`
	Action    string `json:"a"`
	Defector  bool   `json:"d,omitempty"`
	Evidence  int    `json:"e,omitempty"`
	Converged bool   `json:"v,omitempty"`
	At        int64  `json:"t"`
}

type ActionResult struct {
	OK           bool               `json:"ok"`
	Reason       string             `json:"reason,omitempty"`
	Deltas       map[string]float64 `json:"deltas,omitempty"`
	Contribution float64            `json:"contribution,omitempty"`
	EvidenceUsed int                `json:"evidenceUsed,omitempty"`
	EvidenceGain int                `json:"evidenceGain,omitempty"`
}
