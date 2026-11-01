package engine

import (
	"testing"

	"github.com/cult-simulator/server/content"
)

// A synthetic pack exercises phases and scheduled events, which no launch
// cult uses yet but update-2 packs will.
func TestPhasesAndScheduledEvent(t *testing.T) {
	c, err := content.LoadRoster("testdata/content")
	if err != nil {
		t.Fatal(err)
	}
	e := New(c)
	d := e.NewDay("d", t0, t0+86400, nil)
	cs := d.Cults["test_phases"]
	if cs.Phase != "build" {
		t.Fatalf("phase %q", cs.Phase)
	}
	if r := e.Apply(d, ActionReq{Cult: "test_phases", Action: "prepare", At: t0}); r.OK {
		t.Fatal("action outside its phase accepted")
	}
	e.Apply(d, ActionReq{Cult: "test_phases", Action: "lobby", At: t0 + 1})
	e.Apply(d, ActionReq{Cult: "test_phases", Action: "lobby", At: t0 + 2})
	if cs.Phase != "visit" || cs.Progress != 0.5 {
		t.Fatalf("phase %q progress %v", cs.Phase, cs.Progress)
	}
	e.Tick(d, t0+60)  // timer set
	e.Tick(d, t0+240) // fires: loyalty 60 >= 50 passes, visit = 1, win
	if cs.Status != StatusWon || d.EndReason != EndTarget {
		t.Fatalf("status %s reason %s", cs.Status, d.EndReason)
	}
}
