// Command packcheck runs the schema check, semantic lint and care lint on
// every pack in content/cults and content/fixtures, and checks the roster.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/cult-simulator/server/content"
)

func main() {
	dir := flag.String("content", "../content", "content directory")
	flag.Parse()
	l, err := content.NewLoader(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "schema:", err)
		os.Exit(1)
	}
	failed := 0
	for _, sub := range []string{"cults", "fixtures"} {
		entries, _ := os.ReadDir(filepath.Join(*dir, sub))
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			p, err := l.LoadPack(filepath.Join(*dir, sub, e.Name()))
			if err != nil {
				failed++
				fmt.Println("FAIL", sub+"/"+e.Name())
				fmt.Println(err)
				continue
			}
			fmt.Printf("ok   %s/%s v%s (%s) %d actions\n", sub, e.Name(), p.Manifest.Version, p.Hash, len(p.Order))
		}
	}
	c, err := content.LoadRoster(*dir)
	if err != nil {
		fmt.Println("FAIL roster:", err)
		failed++
	} else {
		for id, e := range c.Dropped {
			fmt.Println("FAIL roster pack", id, e)
			failed++
		}
		fmt.Printf("roster: %v content hash %s\n", c.Roster, c.Hash)
	}
	if failed > 0 {
		os.Exit(1)
	}
}
