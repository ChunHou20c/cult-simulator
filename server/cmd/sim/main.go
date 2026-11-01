// Command sim runs the headless balance check: every pack plays N solo Days
// with bots, and the race mode plays the whole roster together.
//
//	go run ./cmd/sim -content ../content -days 50
package main

import (
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/sim"
)

func main() {
	dir := flag.String("content", "../content", "content directory")
	days := flag.Int("days", 50, "Days per pack")
	players := flag.Int("players", 25, "bot players per cult")
	fixtures := flag.Bool("fixtures", false, "also balance content/fixtures packs")
	race := flag.Int("race", 10, "race Days with the whole roster")
	flag.Parse()

	c, err := content.LoadRoster(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *fixtures {
		l, _ := content.NewLoader(*dir)
		entries, _ := os.ReadDir(filepath.Join(*dir, "fixtures"))
		for _, e := range entries {
			if p, err := l.LoadPack(filepath.Join(*dir, "fixtures", e.Name())); err == nil {
				c.Packs[p.Manifest.ID] = p
			}
		}
	}
	cfg := sim.DefaultConfig()
	cfg.PlayersPerCult = *players
	failed := false
	fmt.Printf("%-16s %5s %5s %8s %6s %6s  %s\n", "pack", "runs", "wins", "median_h", "fall%", "prog", "fall reasons")
	for id := range c.Packs {
		b := sim.BalancePack(c, id, *days, cfg)
		med := fmt.Sprintf("%.1f", b.MedianFinish)
		if math.IsInf(b.MedianFinish, 1) {
			med = "never"
		}
		status := "ok"
		if !b.Pass() {
			status, failed = "FAIL", true
		}
		fmt.Printf("%-16s %5d %5d %8s %5.0f%% %5.0f%%  %v %s\n", id, b.Runs, b.Wins, med, b.FallRate*100, b.MeanProgress*100, b.FallReasons, status)
	}
	if *race > 0 {
		wins := map[string]int{}
		for i := 0; i < *race; i++ {
			cfg.Seed = int64(1000 + i)
			r := sim.RunDay(c, cfg)
			wins[r.Winner+" ("+r.EndReason+")"]++
		}
		fmt.Println("race winners:", wins)
	}
	if failed {
		os.Exit(1)
	}
}
