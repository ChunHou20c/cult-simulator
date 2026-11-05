package engine

import (
	"testing"

	"github.com/cult-simulator/server/content"
)

func riteDay(t *testing.T) (*Engine, *WorldDay, *CultState) {
	t.Helper()
	c, err := content.LoadRoster("testdata/content")
	if err != nil {
		t.Fatal(err)
	}
	e := New(c)
	d := e.NewDay("d", t0, t0+86400, nil)
	return e, d, d.Cults["test_rite"]
}

func TestRiteDemandAndRefusal(t *testing.T) {
	e, d, cs := riteDay(t)
	if e.Available(d, "test_rite", content.RiteActionID, t0) {
		t.Fatal("refuse_rite available with no demand")
	}
	if r := e.Apply(d, ActionReq{Cult: "test_rite", Action: content.RiteActionID, At: t0}); r.OK {
		t.Fatal("refuse_rite accepted with no demand")
	}
	for i := 0; i < 3; i++ { // paranoia 60 -> 75
		e.Apply(d, ActionReq{Cult: "test_rite", Action: "chant", At: t0 + int64(i)})
	}
	e.Tick(d, t0+60)
	if cs.Rite == nil || !cs.Rite.Active || !e.Available(d, "test_rite", content.RiteActionID, t0+60) {
		t.Fatalf("no demand at paranoia %v: %+v", cs.Stats["paranoia"], cs.Rite)
	}
	if v := e.Snapshot(d, t0+60).Cults[1]; v.Rite == nil || v.Rite.Need != content.RiteResolveNeed {
		t.Fatalf("snapshot rite view: %+v", v.Rite)
	}
	p0 := cs.Stats["paranoia"]
	for i := 0; i < content.RiteResolveNeed; i++ { // q 0.5 adds 1 each
		if r := e.Apply(d, ActionReq{Cult: "test_rite", Action: content.RiteActionID, At: t0 + 61 + int64(i), Played: true, Quality: 0.5}); !r.OK {
			t.Fatalf("refuse %d: %+v", i, r)
		}
	}
	if cs.Rite.Active || cs.Rite.Refused != 1 {
		t.Fatalf("demand not broken: %+v", cs.Rite)
	}
	if cs.Stats["paranoia"] > p0-content.RiteBreakParanoia {
		t.Fatalf("paranoia %v did not drop from %v", cs.Stats["paranoia"], p0)
	}
	// Calm: even at high paranoia no new demand for RiteCalmSec.
	cs.Stats["paranoia"] = 90
	e.Tick(d, t0+60+content.RiteCalmSec-60)
	if cs.Rite.Active {
		t.Fatal("new demand during the calm")
	}
	if cs.Status != StatusStanding {
		t.Fatalf("status %s", cs.Status)
	}
}

func TestUnrefusedRiteIsAFall(t *testing.T) {
	e, d, cs := riteDay(t)
	cs.Stats["paranoia"] = 80
	e.Tick(d, t0+60)
	if !cs.Rite.Active {
		t.Fatal("no demand")
	}
	e.Apply(d, ActionReq{Cult: "test_rite", Action: content.RiteActionID, At: t0 + 70, Played: true, Quality: 1})
	e.Tick(d, t0+60+content.RiteWindowSec)
	if cs.Status != StatusFallen || cs.FallReason != content.RiteFallReason || cs.Historical {
		t.Fatalf("status %s reason %s historical %v", cs.Status, cs.FallReason, cs.Historical)
	}
	if e.Available(d, "test_rite", content.RiteActionID, t0+60+content.RiteWindowSec) {
		t.Fatal("refuse_rite still offered after the fall")
	}
	// Nobody is rewarded: no progress, and members fall with the cult.
	if cs.Progress > 0.05 {
		t.Fatalf("progress %v", cs.Progress)
	}
	e.checkDayEnd(d, t0+86400)
	if o := Outcome(d, &PlayerDay{Cult: "test_rite"}); o != OutcomeFell {
		t.Fatalf("outcome %s", o)
	}
}

// Real-world packs never get the rite; only fictional ones may.
func TestOnlyFictionalPacksHaveTheRite(t *testing.T) {
	e := load(t)
	n := 0
	for id, p := range e.C.Packs {
		has := p.Actions[content.RiteActionID] != nil
		if has && !p.Manifest.Fictional {
			t.Fatalf("%s is a real group and has the forbidden rite", id)
		}
		if has {
			n++
		}
	}
	if n == 0 {
		t.Fatal("no roster pack uses the forbidden rite")
	}
}
