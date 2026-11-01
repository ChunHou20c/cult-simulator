package content

import "encoding/json"

// sharedActionsJSON are the engine's own actions, written in the same format
// as pack actions so they go through the same compiler. Tuning numbers here
// are engine settings, not content.
const sharedActionsJSON = `[
  { "id": "recruit", "energy": 1, "effects": [
      { "stat": "followers", "add": 4, "scale": "yield" },
      { "stat": "scrutiny", "add": 0.6 } ] },
  { "id": "fundraise", "energy": 1, "effects": [
      { "stat": "funds", "add": "300 + cult.followers * 4", "scale": "yield" },
      { "stat": "scrutiny", "add": 0.5 } ] },
  { "id": "ritual", "energy": 1, "effects": [
      { "stat": "loyalty", "add": 2.5 },
      { "stat": "paranoia", "add": 0.4 } ] },
  { "id": "lie_low", "energy": 1, "cooldownSec": 120, "effects": [
      { "stat": "scrutiny", "add": -5 } ],
    "buff": { "id": "lying_low", "target": "recruit", "mul": 0.5, "durationMin": 10 } },
  { "id": "open_doors", "energy": 1, "cooldownSec": 120, "effects": [
      { "stat": "paranoia", "add": -6 },
      { "stat": "loyalty", "add": -1.5 },
      { "stat": "followers", "mul": 0.98 } ] }
]`

// coreTickJSON runs on every cult every world tick (1 minute), before the
// pack's own tick rules: loyalty drifts down, scrutiny cools slowly.
const coreTickJSON = `[
  { "stat": "loyalty", "add": -0.1 },
  { "stat": "scrutiny", "add": -0.03 }
]`

// Core falls, checked after the pack's own falls. A pack fall with the same
// condition replaces the reason and text, because pack falls are checked first.
var coreFalls = []FallDef{
	{When: "cult.scrutiny >= 100", Reason: "investigated", Text: "core.fall.investigated"},
	{When: "cult.paranoia >= 100", Reason: "paranoia", Text: "core.fall.paranoia"},
	{When: "cult.loyalty <= 0", Reason: "dissolved", Text: "core.fall.dissolved"},
}

// Defector tuning (engine settings).
const (
	DefectMinActions      = 10
	EvidenceForJournalist = 5
)

var (
	sharedActions []*Action
	coreTick      []Effect
	compiledFalls []Fall
)

func init() {
	var defs []ActionDef
	if err := json.Unmarshal([]byte(sharedActionsJSON), &defs); err != nil {
		panic(err)
	}
	for _, d := range defs {
		a, err := compileAction(d)
		if err != nil {
			panic(err)
		}
		a.Shared = true
		sharedActions = append(sharedActions, a)
	}
	var tick []EffectDef
	if err := json.Unmarshal([]byte(coreTickJSON), &tick); err != nil {
		panic(err)
	}
	var err error
	if coreTick, err = compileEffects(tick); err != nil {
		panic(err)
	}
	for _, f := range coreFalls {
		cf, err := compileFall(f)
		if err != nil {
			panic(err)
		}
		compiledFalls = append(compiledFalls, cf)
	}
}

// CoreTick returns the engine's per-tick rules applied to every cult.
func CoreTick() []Effect { return coreTick }

// SharedActionInfo is what the client needs to draw shared action buttons.
type SharedActionInfo struct {
	ID          string `json:"id"`
	Energy      int    `json:"energy"`
	CooldownSec int    `json:"cooldownSec"`
}

// SharedActions lists the engine's shared actions with cost and cooldown.
func SharedActions() []SharedActionInfo {
	out := make([]SharedActionInfo, 0, len(sharedActions))
	for _, a := range sharedActions {
		out = append(out, SharedActionInfo{ID: a.ID, Energy: a.Energy, CooldownSec: a.CooldownSec})
	}
	return out
}
