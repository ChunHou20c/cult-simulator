package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNoCultIDsInCode fails on any literal cult id in server code outside
// tests. Cults are data; no core file may name one.
func TestNoCultIDsInCode(t *testing.T) {
	var ids []string
	for _, sub := range []string{"cults", "fixtures"} {
		entries, _ := os.ReadDir(filepath.Join("..", "content", sub))
		for _, e := range entries {
			if e.IsDir() {
				ids = append(ids, regexp.QuoteMeta(e.Name()))
			}
		}
	}
	var r struct{ Cults []string }
	b, _ := os.ReadFile("../content/roster.json")
	_ = json.Unmarshal(b, &r)
	for _, c := range r.Cults {
		ids = append(ids, regexp.QuoteMeta(c))
	}
	if len(ids) == 0 {
		t.Skip("no packs")
	}
	re := regexp.MustCompile(`\b(` + strings.Join(ids, "|") + `)\b`)
	filepath.WalkDir(".", func(p string, d os.DirEntry, err error) error {
		if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		src, _ := os.ReadFile(p)
		if m := re.Find(src); m != nil {
			t.Errorf("%s names cult %q; read it from the pack instead", p, m)
		}
		return nil
	})
}
