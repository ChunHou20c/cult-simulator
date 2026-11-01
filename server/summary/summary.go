// Package summary builds the templated end-of-Day summary from the final
// world state and its event log. It uses templates, not generated text, so
// it is fast and safe. No Nakama dependency.
package summary

import (
	"fmt"
	"sort"
	"time"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/engine"
)

type Standing struct {
	Cult       string  `json:"cult"`
	Name       string  `json:"name"`
	Status     string  `json:"status"`
	Progress   float64 `json:"progress"`
	FallReason string  `json:"fallReason,omitempty"`
	Players    int     `json:"players"`
	Defectors  int     `json:"defectors"`
}

type Moment struct {
	At   int64  `json:"at"`
	Cult string `json:"cult,omitempty"`
	Text string `json:"text"`
}

type Fallen struct {
	Cult       string `json:"cult"`
	Name       string `json:"name"`
	Historical bool   `json:"historical"`
	Text       string `json:"text"`
}

type DaySummary struct {
	DayID     string                          `json:"dayId"`
	Headline  string                          `json:"headline"`
	EndReason string                          `json:"endReason"`
	Winner    string                          `json:"winner,omitempty"`
	EndedAt   int64                           `json:"endedAt"`
	Standings []Standing                      `json:"standings"`
	Timeline  []Moment                        `json:"timeline"`
	Top       map[string][]engine.Contributor `json:"top"`
	Fallen    []Fallen                        `json:"fallen"`
	HelpURL   string                          `json:"helpUrl"`
}

// HelpURL is shown on every historical end card and in the summary.
const HelpURL = "https://www.icsahome.com/"

var coreFallText = map[string]string{
	"core.fall.investigated": "Investigators closed in and the group was shut down.",
	"core.fall.paranoia":     "Paranoia took over and the group turned on the outside world.",
	"core.fall.dissolved":    "Loyalty ran out and the members walked away.",
	"core.fall.exposed":      "Former members told their story and the group was exposed.",
}

func name(p *content.Pack, id string) string {
	if p != nil && p.Strings["name"] != "" {
		return p.Strings["name"]
	}
	return id
}

func text(p *content.Pack, key string) string {
	if t, ok := coreFallText[key]; ok {
		return t
	}
	if p != nil {
		if t, ok := p.Strings[key]; ok {
			return t
		}
	}
	return key
}

func clock(at int64) string { return time.Unix(at, 0).UTC().Format("15:04 UTC") }

// Build makes the DaySummary for a concluded Day.
func Build(d *engine.WorldDay, c *content.Content) *DaySummary {
	s := &DaySummary{DayID: d.DayID, EndReason: d.EndReason, Winner: d.Winner, EndedAt: d.EndedAt,
		Top: map[string][]engine.Contributor{}, Timeline: []Moment{}, Fallen: []Fallen{}, HelpURL: HelpURL}

	winP := c.Packs[d.Winner]
	switch d.EndReason {
	case engine.EndTarget:
		s.Headline = fmt.Sprintf("%s reached %s at %s", name(winP, d.Winner), goalLabel(winP), clock(d.EndedAt))
	case engine.EndAllFallen:
		s.Headline = fmt.Sprintf("Every cult fell. The last one ended at %s", clock(d.EndedAt))
	default:
		if d.Winner != "" {
			s.Headline = fmt.Sprintf("Time ran out. %s led at %.0f%%, unfinished", name(winP, d.Winner), d.Cults[d.Winner].Progress*100)
		} else {
			s.Headline = "Time ran out with no cult standing"
		}
	}

	for _, id := range d.Roster {
		cs, p := d.Cults[id], c.Packs[id]
		s.Standings = append(s.Standings, Standing{Cult: id, Name: name(p, id), Status: cs.Status,
			Progress: cs.Progress, FallReason: cs.FallReason, Players: cs.Players, Defectors: cs.Defectors})
		s.Top[id] = engine.TopContributors(cs, 3)
		if cs.Status == engine.StatusFallen || cs.Status == engine.StatusExposed {
			s.Fallen = append(s.Fallen, Fallen{Cult: id, Name: name(p, id), Historical: cs.Historical, Text: text(p, cs.FallText)})
		}
	}
	sort.SliceStable(s.Standings, func(i, j int) bool { return s.Standings[i].Progress > s.Standings[j].Progress })

	// Timeline: the first cult to each milestone, every fall and the win;
	// at most 8 moments.
	seen := map[int]bool{}
	for _, ev := range d.Events {
		p := c.Packs[ev.Cult]
		var m *Moment
		switch ev.Kind {
		case "milestone":
			pct := toInt(ev.Data["pct"])
			if pct >= 50 && !seen[pct] {
				seen[pct] = true
				m = &Moment{Text: fmt.Sprintf("%s was first to %d%%", name(p, ev.Cult), pct)}
			}
		case "fall":
			m = &Moment{Text: fmt.Sprintf("%s fell", name(p, ev.Cult))}
		case "exposed":
			m = &Moment{Text: fmt.Sprintf("%s was exposed by its defectors", name(p, ev.Cult))}
		case "win":
			m = &Moment{Text: fmt.Sprintf("%s reached its goal", name(p, ev.Cult))}
		}
		if m != nil {
			m.At, m.Cult = ev.At, ev.Cult
			s.Timeline = append(s.Timeline, *m)
		}
	}
	if len(s.Timeline) > 8 {
		s.Timeline = s.Timeline[len(s.Timeline)-8:]
	}
	return s
}

func goalLabel(p *content.Pack) string {
	if p == nil {
		return "its goal"
	}
	return text(p, p.Manifest.Goal.Label)
}

func toInt(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case int64:
		return int(n)
	}
	return 0
}
