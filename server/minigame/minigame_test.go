package minigame

import (
	"math"
	"testing"
)

// perfectInputs plays a round perfectly, from its layout.
func perfectInputs(t *testing.T, game string, seed uint32) []Input {
	l := NewLayout(game, seed)
	var in []Input
	switch game {
	case Timing:
		start := 0.0
		for _, z := range l.Zones {
			// Find the first time after start where the needle is at the zone centre.
			tm := start
			for ; tm < l.LengthMs; tm += 0.5 {
				if math.Abs(Needle(l.PeriodMs, tm)-z.C) < 0.002 {
					break
				}
			}
			in = append(in, Input{T: tm})
			start = tm + timingGap + 1
		}
	case Beat:
		for _, b := range l.Beats {
			in = append(in, Input{T: b})
		}
	case Snuff:
		for _, c := range l.Candles {
			in = append(in, Input{T: c.Start + 100, X: c.X, Y: c.Y})
		}
	case Flick:
		for _, s := range l.Strangers {
			// Aim straight up at a moment the stranger will be at x = 0.5.
			tt := (FlickY - s.Y) / FlickSpeed * 1000
			arrive := s.Start + (FlickX-s.X0)/(s.Dir*s.Speed)*1000
			in = append(in, Input{T: arrive - tt, X: 0, Y: -1})
		}
	}
	return in
}

func TestPerfectPlayScoresOne(t *testing.T) {
	for _, g := range Catalog {
		for seed := uint32(1); seed < 200; seed += 7 {
			in := perfectInputs(t, g, seed)
			q, grades, ok := Score(g, seed, in, 1e9)
			if !ok || q != 1 {
				t.Fatalf("%s seed %d: q=%v grades=%v ok=%v", g, seed, q, grades, ok)
			}
		}
	}
}

func TestNoInputScoresZero(t *testing.T) {
	for _, g := range Catalog {
		if q, _, ok := Score(g, 42, nil, 1e9); !ok || q != 0 {
			t.Fatalf("%s: q=%v ok=%v", g, q, ok)
		}
	}
}

func TestMashingDoesNotPay(t *testing.T) {
	for _, g := range Catalog {
		var in []Input
		for tm := 0.0; tm < 8000; tm += 85 {
			in = append(in, Input{T: tm, X: 0, Y: -1})
		}
		if len(in) > MaxInputs {
			in = in[:MaxInputs]
		}
		q, _, _ := Score(g, 42, in, 1e9)
		if q > 0.5 {
			t.Fatalf("%s: mashing scored %v", g, q)
		}
	}
}

func TestForgedClockIsRejected(t *testing.T) {
	in := perfectInputs(t, Beat, 9)
	// The server saw only 1 second pass, but the inputs claim 4.
	q, _, ok := Score(Beat, 9, in, 1000)
	if ok || q != SkipQuality {
		t.Fatalf("q=%v ok=%v", q, ok)
	}
}

func TestBadInputsAreRejected(t *testing.T) {
	if _, _, ok := Score(Beat, 1, []Input{{T: math.NaN()}}, 1e9); ok {
		t.Fatal("NaN accepted")
	}
	if _, _, ok := Score("nope", 1, nil, 1e9); ok {
		t.Fatal("unknown game accepted")
	}
	many := make([]Input, MaxInputs+1)
	if _, _, ok := Score(Beat, 1, many, 1e9); ok {
		t.Fatal("too many inputs accepted")
	}
}

func TestSkipIsTodaysNumbers(t *testing.T) {
	if Gain(SkipQuality) != 1 || Heat(SkipQuality) != 1 {
		t.Fatalf("gain %v heat %v", Gain(SkipQuality), Heat(SkipQuality))
	}
	if math.Abs(Gain(1)-1.4) > 1e-9 || math.Abs(Gain(0)-0.6) > 1e-9 || math.Abs(Heat(1)-0.7) > 1e-9 || math.Abs(Heat(0)-1.3) > 1e-9 {
		t.Fatal("range changed")
	}
}

func TestWatchClampsImplausibleRuns(t *testing.T) {
	var w Watch
	for i := 0; i < 19; i++ {
		if w.Note(1) != 1 {
			t.Fatal("clamped too early")
		}
	}
	if w.Note(1) != SkipQuality || !w.Clamped {
		t.Fatal("not clamped after 20 perfect rounds")
	}
	var h Watch
	for i := 0; i < 100; i++ {
		q := 0.9
		if i%5 == 0 {
			q = 0.6
		}
		if h.Note(q) != q {
			t.Fatal("a strong human player got clamped")
		}
	}
}

// The TypeScript mirror must produce these exact numbers (scripts/check-minigame.mjs).
func TestLayoutGolden(t *testing.T) {
	r := &rng{a: 12345}
	want := []float64{0.97972826776094735, 0.30675226449966431, 0.484205421525985}
	for i, w := range want {
		if got := r.next(); got != w {
			t.Fatalf("mulberry32(12345)[%d] = %.17g, want %.17g", i, got, w)
		}
	}
	if l := NewLayout(Beat, 12345); l.Beats[1] != 1860 || l.LengthMs != 5200 {
		t.Fatalf("beat layout changed: %v", l)
	}
	if l := NewLayout(Flick, 777); l.Strangers[1].Speed != 0.47460059002041816 {
		t.Fatalf("flick layout changed: %v", l)
	}
	if l := NewLayout(Timing, 777); l.Zones[2].C != 0.3154323977883905 {
		t.Fatalf("timing layout changed: %v", l)
	}
}

func TestSnuffLateAndWrongTaps(t *testing.T) {
	l := NewLayout(Snuff, 99)
	var in []Input
	for _, c := range l.Candles {
		in = append(in, Input{T: c.Start + c.BurnMs*0.8, X: c.X, Y: c.Y}) // late: Good
	}
	q, grades, _ := Score(Snuff, 99, in, 1e9)
	if q != Good {
		t.Fatalf("late taps: q=%v grades=%v", q, grades)
	}
	// A tap on an unlit spot (the centre) costs a little.
	in = append(in, Input{T: l.Candles[0].Start + 400, X: 0.5, Y: 0.5})
	if q2, _, _ := Score(Snuff, 99, in, 1e9); q2 >= q {
		t.Fatalf("a wrong tap should cost: %v >= %v", q2, q)
	}
	// Too late: the candle burned down.
	c := l.Candles[0]
	if q3, _, _ := Score(Snuff, 99, []Input{{T: c.Start + c.BurnMs + 50, X: c.X, Y: c.Y}}, 1e9); q3 != 0 {
		t.Fatalf("a burned-down candle scored %v", q3)
	}
}

func TestSnuffGolden(t *testing.T) {
	l := NewLayout(Snuff, 777)
	// Mirrored in scripts/check-minigame.mjs.
	if l.Candles[2].Start != 1580.9381357906386 || l.Candles[2].X != 0.2228718707889797 {
		t.Fatalf("snuff layout changed: %+v", l.Candles[2])
	}
	for k := 1; k < len(l.Candles); k++ {
		if l.Candles[k].X == l.Candles[k-1].X && l.Candles[k].Y == l.Candles[k-1].Y {
			t.Fatalf("candles %d and %d share a spot", k-1, k)
		}
	}
}
