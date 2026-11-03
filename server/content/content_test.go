package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchRosterLoads(t *testing.T) {
	c, err := LoadRoster("../../content")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Dropped) > 0 {
		t.Fatalf("dropped: %v", c.Dropped)
	}
	if len(c.Roster) < 1 || c.Hash == "" {
		t.Fatalf("roster %v hash %q", c.Roster, c.Hash)
	}
}

func TestFloatLiterals(t *testing.T) {
	cases := map[string]string{
		"cult.followers / 140":      "cult.followers / 140.0",
		"0.5 * cult.x":              "0.5 * cult.x",
		"cult.a2 >= 100":            "cult.a2 >= 100.0",
		`phase == "p1" && 3 > 1e2`:  `phase == "p1" && 3.0 > 1e2`,
	}
	for in, want := range cases {
		if got := floatLiterals(in); got != want {
			t.Errorf("%q -> %q, want %q", in, got, want)
		}
	}
}

// writePack copies a launch pack into a temp dir and applies a change to its manifest.
func writePack(t *testing.T, change func(string) string) (*Loader, string) {
	t.Helper()
	root := t.TempDir()
	src := "../../content/cults/synanon"
	dst := filepath.Join(root, "synanon")
	filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		rel, _ := filepath.Rel(src, p)
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, _ := os.ReadFile(p)
		if rel == "manifest.json" {
			b = []byte(change(string(b)))
		}
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	l, err := NewLoader("../../content")
	if err != nil {
		t.Fatal(err)
	}
	return l, dst
}

func expectIssue(t *testing.T, change func(string) string, want string) {
	t.Helper()
	l, dir := writePack(t, change)
	_, err := l.LoadPack(dir)
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want issue containing %q, got %v", want, err)
	}
}

func TestValidatorCatches(t *testing.T) {
	expectIssue(t, func(s string) string { return strings.Replace(s, `"cult.assets / 30000000"`, `"cult.nonexistent / 3"`, 1) }, "does every stat")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"open_rehab_house"`, `"poison_the_well"`, 1) }, "care")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"schema": "1.2"`, `"schema": "1.9"`, 1) }, "engine supports")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"energy": 2`, `"energy": 9`, 1) }, "schema")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"cult.scrutiny < 70"`, `"cult.scrutiny + 1"`, 1) }, "must return bool")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"play_the_game": "sit_talk"`, `"play_cards": "sit_talk"`, 1) }, "not an action of this pack")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"play_the_game": "sit_talk"`, `"play_the_game": "backflip"`, 1) }, "schema")
	// Outfits (schema 1.2).
	expectIssue(t, func(s string) string { return strings.Replace(s, `"garment": "overalls"`, `"garment": "spacesuit"`, 1) }, "schema")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"beard": 0.15`, `"beard": 2`, 1) }, "schema")
	// The three-button layout.
	expectIssue(t, func(s string) string { return strings.Replace(s, `"slot": "devote"`, `"slot": "work"`, 1) }, "both use slot")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"game": "beat"`, `"game": "chess"`, 1) }, "schema")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"sharedActions": [],`, ``, 1) }, "sharedActions")
}

func TestSlotOrder(t *testing.T) {
	c, err := LoadRoster("../../content")
	if err != nil {
		t.Fatal(err)
	}
	for id, p := range c.Packs {
		if len(p.Order) != 3 {
			t.Fatalf("%s: %d actions, want 3", id, len(p.Order))
		}
		for i, a := range p.Order {
			if p.Actions[a].Slot != Slots[i] || p.Actions[a].Game == "" {
				t.Fatalf("%s: action %d is %s (slot %q game %q)", id, i, a, p.Actions[a].Slot, p.Actions[a].Game)
			}
		}
	}
}

func TestEmblems(t *testing.T) {
	for _, id := range []string{"source_family", "synanon", "rajneeshpuram"} {
		b, err := os.ReadFile(filepath.Join("../../content/cults", id, "emblem.svg"))
		if err != nil {
			t.Fatal(err)
		}
		if msg := checkEmblem(b); msg != "" {
			t.Errorf("%s: %s", id, msg)
		}
	}
	bad := map[string]string{
		`<svg viewBox="0 0 1 1"><script>x()</script></svg>`:                 "outside",
		`<svg viewBox="0 0 1 1" onload="x()"></svg>`:                        "outside",
		`<svg viewBox="0 0 1 1"><image href="https://e.com/a.png"/></svg>`:  "outside",
		`<svg viewBox="0 0 1 1"><rect fill="url(http://e.com/#a)"/></svg>`: "outside",
		`<svg width="1"></svg>`:  "viewBox",
		`<html></html>`:          "single",
	}
	for in, want := range bad {
		if msg := checkEmblem([]byte(in)); !strings.Contains(msg, want) {
			t.Errorf("%s: got %q, want %q", in, msg, want)
		}
	}
	if msg := checkEmblem([]byte(`<svg viewBox="0 0 1 1"><rect fill="url(#g)"/></svg>`)); msg != "" {
		t.Errorf("local url() refused: %s", msg)
	}
}
