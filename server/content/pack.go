// Package content loads, validates and compiles cult packs and the roster.
// It has no Nakama dependency so the simulator and CI can use it directly.
package content

import (
	"encoding/json"
	"fmt"
)

// SchemaMajor and SchemaMinor are the newest manifest schema this engine
// understands. Within major 1 changes are additive only.
const (
	SchemaMajor = 1
	SchemaMinor = 1
)

// Core stats every cult has. Packs may add their own.
var CoreStats = []string{"followers", "funds", "loyalty", "scrutiny", "paranoia", "exposure"}

// SharedActionIDs are the engine's own actions, available to every cult
// unless its pack leaves them out of sharedActions.
var SharedActionIDs = []string{"recruit", "fundraise", "ritual", "lie_low", "open_doors"}

// DefectorActionIDs belong to the engine and act on a defector's former cult.
var DefectorActionIDs = []string{"gather_evidence", "call_family", "talk_to_journalist"}

type Manifest struct {
	Schema        string              `json:"schema"`
	ID            string              `json:"id"`
	Version       string              `json:"version"`
	Difficulty    string              `json:"difficulty"`
	Names         string              `json:"names,omitempty"`
	Theme         map[string]string   `json:"theme,omitempty"`
	Stats         map[string]StatDef  `json:"stats,omitempty"`
	Initial       map[string]float64  `json:"initial,omitempty"`
	Goal          GoalDef             `json:"goal"`
	Guard         string              `json:"guard,omitempty"`
	SharedActions []string            `json:"sharedActions,omitempty"`
	Actions       []ActionDef         `json:"actions"`
	Tick          []EffectDef         `json:"tick,omitempty"`
	Falls         []FallDef           `json:"falls,omitempty"`
	Phases        []PhaseDef          `json:"phases,omitempty"`
	Events        []EventDef          `json:"events,omitempty"`
	// Animations picks the 3D figure's movement per action id (or
	// "ritual.<id>"). Display only: the server never reads it.
	Animations map[string]string `json:"animations,omitempty"`
}

type StatDef struct {
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Initial float64  `json:"initial,omitempty"`
	Widget  string   `json:"widget"`
	Label   string   `json:"label"`
}

type GoalDef struct {
	Progress string `json:"progress"`
	Label    string `json:"label"`
}

type ActionDef struct {
	ID          string      `json:"id"`
	Energy      int         `json:"energy,omitempty"`
	CooldownSec int         `json:"cooldownSec,omitempty"`
	Requires    string      `json:"requires,omitempty"`
	Effects     []EffectDef `json:"effects"`
	Buff        *BuffDef    `json:"buff,omitempty"`
	Phases      []string    `json:"phases,omitempty"`
	// Since schema 1.1: which of the three buttons this is, and its mini game.
	Slot string            `json:"slot,omitempty"`
	Game string            `json:"game,omitempty"`
	Skin map[string]string `json:"skin,omitempty"`
}

// Slots are the three action buttons, in display order.
var Slots = []string{"recruit", "work", "devote"}

type BuffDef struct {
	ID          string  `json:"id"`
	Target      string  `json:"target"`
	Mul         float64 `json:"mul"`
	DurationMin float64 `json:"durationMin"`
}

// EffectDef values are a JSON number or an expression string.
type EffectDef struct {
	Stat  string          `json:"stat"`
	Add   json.RawMessage `json:"add,omitempty"`
	Mul   json.RawMessage `json:"mul,omitempty"`
	Set   json.RawMessage `json:"set,omitempty"`
	Scale string          `json:"scale,omitempty"`
}

type FallDef struct {
	When       string `json:"when"`
	Reason     string `json:"reason"`
	Text       string `json:"text"`
	Historical bool   `json:"historical,omitempty"`
}

type PhaseDef struct {
	ID    string  `json:"id"`
	Goal  GoalDef `json:"goal"`
	Guard string  `json:"guard,omitempty"`
	Next  string  `json:"next,omitempty"`
}

type EventDef struct {
	ID       string      `json:"id"`
	After    string      `json:"after"`
	DelayMin float64     `json:"delayMin"`
	Check    string      `json:"check"`
	Pass     []EffectDef `json:"pass"`
	Fail     []EffectDef `json:"fail"`
	Text     string      `json:"text,omitempty"`
}

// ---- compiled form, used by the engine ----

type Op int

const (
	OpAdd Op = iota
	OpMul
	OpSet
)

type Effect struct {
	Stat   string
	Op     Op
	Value  *Expr
	Scaled bool
}

type Action struct {
	ID          string
	Shared      bool
	Energy      int
	CooldownSec int
	Requires    *Expr
	Effects     []Effect
	Buff        *BuffDef
	Phases      map[string]bool
	Slot        string // "" for unslotted actions
	Game        string // mini game id, "" for none
}

type Fall struct {
	When       *Expr
	Reason     string
	Text       string
	Historical bool
}

type Phase struct {
	ID       string
	Progress *Expr
	Guard    *Expr
	Next     string
}

type Event struct {
	ID       string
	After    *Expr
	DelayMin float64
	Check    *Expr
	Pass     []Effect
	Fail     []Effect
	Text     string
}

type StatRange struct {
	Min, Max float64
	Initial  float64
}

// Pack is a compiled, validated cult pack.
type Pack struct {
	Manifest Manifest
	Hash     string // content hash of every file in the pack folder
	Dir      string

	Stats    map[string]StatRange // core + extra, with ranges and initial values
	Progress *Expr
	Guard    *Expr
	Actions  map[string]*Action // shared (enabled) + signature
	Order    []string           // action ids in display order
	Tick     []Effect
	Falls    []Fall
	Phases   []Phase
	Events   []Event
	Compound Compound
	Strings  map[string]string
}

// Compound is the walkable room layout for a cult.
type Compound struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Mats   []Mat   `json:"mats"`
	Spawn  [][2]float64 `json:"spawn"`
}

type Mat struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

func DefaultCompound() Compound {
	c := Compound{Width: 960, Height: 640}
	n := 0
	for row := 0; row < 3; row++ {
		for col := 0; col < 6; col++ {
			n++
			c.Mats = append(c.Mats, Mat{ID: fmt.Sprintf("m%d", n), X: 230 + float64(col)*100, Y: 200 + float64(row)*110})
		}
	}
	c.Spawn = [][2]float64{{480, 590}, {420, 590}, {540, 590}}
	return c
}

// IsCore reports whether a stat is one of the six core stats.
func IsCore(stat string) bool {
	for _, s := range CoreStats {
		if s == stat {
			return true
		}
	}
	return false
}
