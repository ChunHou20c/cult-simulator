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
	expectIssue(t, func(s string) string { return strings.Replace(s, `"schema": "1.0"`, `"schema": "1.9"`, 1) }, "engine supports")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"energy": 2`, `"energy": 9`, 1) }, "schema")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"cult.scrutiny < 70"`, `"cult.scrutiny + 1"`, 1) }, "must return bool")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"play_the_game": "sit_talk"`, `"play_cards": "sit_talk"`, 1) }, "not an action of this pack")
	expectIssue(t, func(s string) string { return strings.Replace(s, `"play_the_game": "sit_talk"`, `"play_the_game": "backflip"`, 1) }, "schema")
}
