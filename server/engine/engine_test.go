package engine

import (
	"testing"

	"github.com/cult-simulator/server/content"
)

func load(t *testing.T) *Engine {
	t.Helper()
	c, err := content.LoadRoster("../../content")
	if err != nil {
		t.Fatal(err)
	}
	return New(c)
}

const t0 = int64(1_800_000_000)

func firstCult(e *Engine) string { return e.C.Roster[0] }

func TestApplyAndRefuse(t *testing.T) {
	e := load(t)
	d := e.NewDay("d", t0, t0+86400, nil)
	id := firstCult(e)
	before := d.Cults[id].Stats["followers"]
	r := e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "recruit", At: t0 + 1})
	if !r.OK || d.Cults[id].Stats["followers"] <= before {
		t.Fatalf("recruit did not apply: %+v", r)
	}
	if r := e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "nope", At: t0 + 2}); r.OK {
		t.Fatal("unknown action accepted")
	}
	if d.Seq != 1 {
		t.Fatalf("seq = %d", d.Seq)
	}
}

func TestFallStopsActions(t *testing.T) {
	e := load(t)
	d := e.NewDay("d", t0, t0+86400, nil)
	id := firstCult(e)
	d.Cults[id].Stats["scrutiny"] = 99.9
	e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "recruit", At: t0 + 1})
	if d.Cults[id].Status != StatusFallen {
		t.Fatalf("status %s, want fallen", d.Cults[id].Status)
	}
	if r := e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "recruit", At: t0 + 2}); r.OK {
		t.Fatal("fallen cult accepted an action")
	}
}

func TestOnlyOneWinner(t *testing.T) {
	e := load(t)
	d := e.NewDay("d", t0, t0+86400, nil)
	for _, id := range d.Roster {
		cs := d.Cults[id]
		for k := range cs.Stats {
			if k != "scrutiny" && k != "paranoia" && k != "exposure" && k != "loyalty" {
				cs.Stats[k] = 1e12
			}
		}
		if _, ok := cs.Stats["months"]; ok {
			cs.Stats["months"] = 60
		}
		cs.Stats["loyalty"] = 90
	}
	for i, id := range d.Roster {
		e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "ritual", At: t0 + int64(i) + 1})
	}
	won := 0
	for _, cs := range d.Cults {
		if cs.Status == StatusWon {
			won++
		}
	}
	if won != 1 || d.EndReason != EndTarget || d.Winner != d.Roster[0] {
		t.Fatalf("won=%d reason=%s winner=%s", won, d.EndReason, d.Winner)
	}
}

func TestTimeUpAndTick(t *testing.T) {
	e := load(t)
	d := e.NewDay("d", t0, t0+3600, nil)
	id := firstCult(e)
	e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: "recruit", At: t0 + 1})
	loyal := d.Cults[id].Stats["loyalty"]
	e.Tick(d, t0+600)
	if d.Cults[id].Stats["loyalty"] >= loyal {
		t.Fatal("loyalty did not drift on tick")
	}
	e.Tick(d, t0+3600)
	if d.Phase != PhaseConcluded || d.EndReason != EndTimeUp || d.Winner == "" {
		t.Fatalf("phase=%s reason=%s winner=%q", d.Phase, d.EndReason, d.Winner)
	}
}

func TestDefectorExposure(t *testing.T) {
	e := load(t)
	d := e.NewDay("d", t0, t0+86400, nil)
	id := firstCult(e)
	e.Defect(d, id)
	if r := e.Apply(d, ActionReq{Cult: id, Action: "talk_to_journalist", Defector: true, Evidence: 0, At: t0}); r.OK {
		t.Fatal("journalist without evidence accepted")
	}
	for i := 0; i < 60 && d.Cults[id].Status == StatusStanding; i++ {
		e.Apply(d, ActionReq{Cult: id, Action: "gather_evidence", Defector: true, At: t0 + int64(i)})
	}
	if d.Cults[id].Status != StatusExposed {
		t.Fatalf("status %s, want exposed", d.Cults[id].Status)
	}
	pd := &PlayerDay{Cult: id, Defected: true}
	e.Tick(d, t0+86400)
	if got := Outcome(d, pd); got != OutcomeDefector {
		t.Fatalf("outcome %s", got)
	}
}

func TestEnergyRefill(t *testing.T) {
	pd := &PlayerDay{Energy: 2, EnergyAt: 0}
	if en, at := Energy(pd, 1250); en != 4 || at != 1200 {
		t.Fatalf("energy %v at %v", en, at)
	}
	if en, _ := Energy(pd, 1e6); en != MaxEnergy {
		t.Fatalf("energy %v", en)
	}
}

func TestDeterministicReplay(t *testing.T) {
	e := load(t)
	run := func() *WorldDay {
		d := e.NewDay("d", t0, t0+86400, nil)
		for i := 0; i < 300; i++ {
			id := d.Roster[i%len(d.Roster)]
			p := e.C.Packs[id]
			e.Apply(d, ActionReq{UserID: "u", Cult: id, Action: p.Order[i%len(p.Order)], At: t0 + int64(i*30)})
			e.Tick(d, t0+int64(i*30))
		}
		return d
	}
	a, b := run(), run()
	for id := range a.Cults {
		for k, v := range a.Cults[id].Stats {
			if b.Cults[id].Stats[k] != v {
				t.Fatalf("%s.%s differs: %v vs %v", id, k, v, b.Cults[id].Stats[k])
			}
		}
	}
}
