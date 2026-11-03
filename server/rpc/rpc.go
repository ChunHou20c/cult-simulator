// Package rpc holds the lobby calls: hello, get_day, join_cult,
// switch_cult, defect, join_room, get_summary, list_archive, get_pack.
// Payloads are JSON. No call names a cult.
package rpc

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"

	"github.com/cult-simulator/server/compound"
	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/engine"
	"github.com/cult-simulator/server/protocol"
	"github.com/cult-simulator/server/summary"
	"github.com/cult-simulator/server/world"
)

type fn = func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error)

// Register adds every RPC.
func Register(init runtime.Initializer) error {
	for id, f := range map[string]fn{
		"hello": hello, "get_day": getDay, "join_cult": joinCult, "switch_cult": switchCult,
		"defect": defect, "join_room": joinRoom, "get_summary": getSummary, "list_archive": listArchive,
		"get_pack": getPack,
	} {
		if err := init.RegisterRpc(id, f); err != nil {
			return err
		}
	}
	return nil
}

var (
	errAuth    = runtime.NewError("login required", 16)
	errBadArgs = runtime.NewError("bad arguments", 3)
	errNoWorld = runtime.NewError("the world is starting, try again in a moment", 14)
)

func failed(msg string) error { return runtime.NewError(msg, 9) } // FAILED_PRECONDITION

func userID(ctx context.Context) (string, error) {
	uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if uid == "" {
		return "", errAuth
	}
	return uid, nil
}

func out(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

func live(ctx context.Context, nk runtime.NakamaModule) (*world.Published, error) {
	if _, err := world.Ensure(ctx, nk); err != nil {
		return nil, errNoWorld
	}
	for i := 0; i < 20; i++ {
		if pub := world.Current(); pub != nil {
			return pub, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return nil, errNoWorld
}

// ---- names ----

var adjectives = []string{"Quiet", "Amber", "Gentle", "Silver", "Patient", "Bright", "Humble", "Distant", "Golden", "Still", "Velvet", "Hollow", "Kind", "Morning", "Saffron", "Wandering"}
var nouns = []string{"Heron", "Lantern", "River", "Sparrow", "Cedar", "Moth", "Willow", "Pebble", "Comet", "Fern", "Otter", "Bell", "Ember", "Lotus", "Juniper", "Finch"}

func generateName(r *rand.Rand) string {
	return fmt.Sprintf("%s %s %02d", adjectives[r.Intn(len(adjectives))], nouns[r.Intn(len(nouns))], r.Intn(100))
}

// ---- hello ----

type helloIn struct {
	Protocol int    `json:"protocol"`
	Client   string `json:"client"`
	UI       int    `json:"ui"`
}

type packInfo struct {
	ID         string `json:"id"`
	Version    string `json:"version"`
	Schema     string `json:"schema"`
	Hash       string `json:"hash"`
	URL        string `json:"url"`
	Difficulty string `json:"difficulty"`
}

func semverLess(a, b string) bool {
	var x, y [3]int
	fmt.Sscanf(a, "%d.%d.%d", &x[0], &x[1], &x[2])
	fmt.Sscanf(b, "%d.%d.%d", &y[0], &y[1], &y[2])
	for i := 0; i < 3; i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return false
}

func hello(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	var in helloIn
	_ = json.Unmarshal([]byte(payload), &in)
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	// Generated display name, set once.
	name := ""
	if acc, err := nk.AccountGetId(ctx, uid); err == nil {
		name = acc.User.DisplayName
	}
	if name == "" {
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		name = generateName(r)
		if err := nk.AccountUpdateId(ctx, uid, "", nil, name, "", "", "", ""); err != nil {
			logger.Warn("hello: set name: %v", err)
		}
	}
	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	base := strings.TrimRight(env["ASSET_BASE"], "/")
	var packs []packInfo
	for _, id := range pub.Content.Roster {
		p := pub.Content.Packs[id]
		url := ""
		if base != "" {
			url = fmt.Sprintf("%s/%s/%s/", base, id, p.Hash)
		}
		packs = append(packs, packInfo{ID: id, Version: p.Manifest.Version, Schema: p.Manifest.Schema, Hash: p.Hash, URL: url, Difficulty: p.Manifest.Difficulty})
	}
	return out(map[string]any{
		"protocol":    map[string]int{"min": protocol.Version, "max": protocol.Version},
		"minClient":   protocol.MinClient,
		"updateNeeded": (in.Protocol != 0 && in.Protocol < protocol.Version) || (in.Client != "" && semverLess(in.Client, protocol.MinClient)),
		"contentHash": pub.Snap.ContentHash,
		"packs":       packs,
		"phase":       pub.Snap.Phase,
		"dayId":       pub.Snap.DayID,
		"name":        name,
		"userId":      uid,
		"sharedActions": content.SharedActions(),
		"defectorActions": content.DefectorActionIDs,
		"engine": map[string]any{"maxEnergy": engine.MaxEnergy, "refillSec": engine.EnergyRefillSec,
			"defectMinActions": content.DefectMinActions, "evidenceForJournalist": content.EvidenceForJournalist,
			"roomSize": protocol.RoomSize},
	})
}

// ---- get_day ----

func getDay(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	res := map[string]any{"world": pub.Snap}
	if pd, _, err := compound.LoadPlayer(ctx, nk, uid, pub.Snap.DayID); err == nil {
		pd.Energy, pd.EnergyAt = engine.Energy(pd, time.Now().Unix())
		res["player"] = pd
	}
	return out(res)
}

// ---- join_cult / join_room ----

type cultIn struct {
	CultID string `json:"cultId"`
}

func joinCult(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	var in cultIn
	if json.Unmarshal([]byte(payload), &in) != nil || in.CultID == "" {
		return "", errBadArgs
	}
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	if pub.Snap.Phase != engine.PhaseLive {
		return "", failed("day_over")
	}
	var cv *engine.CultView
	for i := range pub.Snap.Cults {
		if pub.Snap.Cults[i].ID == in.CultID {
			cv = &pub.Snap.Cults[i]
		}
	}
	if cv == nil {
		return "", failed("unknown_cult")
	}
	pd, _, err := compound.LoadPlayer(ctx, nk, uid, pub.Snap.DayID)
	switch {
	case err == nil:
		if pd.Cult != in.CultID {
			return "", failed("pick_locked")
		}
	case errors.Is(err, compound.ErrNoRecord):
		if cv.Status != engine.StatusStanding {
			return "", failed("cult_ended")
		}
		name := ""
		if acc, err := nk.AccountGetId(ctx, uid); err == nil {
			name = acc.User.DisplayName
		}
		now := time.Now().Unix()
		pd = &engine.PlayerDay{DayID: pub.Snap.DayID, UserID: uid, Name: name, Cult: in.CultID, Energy: engine.MaxEnergy, EnergyAt: now}
		// "*" only creates: two quick picks cannot both lock in.
		if _, err := compound.SavePlayer(ctx, nk, pd, "*"); err != nil {
			return "", failed("pick_locked")
		}
		if _, err := world.Send(ctx, nk, world.Signal{Type: "players", Day: pd.DayID, Cult: pd.Cult, Delta: 1}); err != nil {
			logger.Error("join_cult: world: %v", err)
		}
	default:
		return "", err
	}
	room, err := findRoom(ctx, nk, pd.Cult, pd.DayID)
	if err != nil {
		return "", err
	}
	return out(map[string]any{"matchId": room, "player": pd})
}

func joinRoom(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	pd, _, err := compound.LoadPlayer(ctx, nk, uid, pub.Snap.DayID)
	if err != nil {
		return "", failed("pick_a_cult_first")
	}
	room, err := findRoom(ctx, nk, pd.Cult, pd.DayID)
	if err != nil {
		return "", err
	}
	return out(map[string]any{"matchId": room, "player": pd})
}

// findRoom returns the fullest open room of a cult, so rooms feel alive,
// or creates one when every room is full.
func findRoom(ctx context.Context, nk runtime.NakamaModule, cult, day string) (string, error) {
	return compound.FindOrCreate(cult, day, func() (string, error) {
		return nk.MatchCreate(ctx, compound.ModuleName, map[string]interface{}{"cult": cult, "day": day})
	})
}

// ---- defect / switch ----

func change(ctx context.Context, nk runtime.NakamaModule, c compound.Change) (string, error) {
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	// If the player is in a room, the room owns the record: hand it over.
	if room := compound.RoomOf(c.UserID); room != "" {
		b, _ := json.Marshal(c)
		res, err := nk.MatchSignal(ctx, room, string(b))
		if err == nil {
			var r struct {
				Error string `json:"error"`
			}
			_ = json.Unmarshal([]byte(res), &r)
			if r.Error == "" {
				return res, nil
			}
			if r.Error != "not_here" {
				return "", failed(r.Error)
			}
		}
	}
	pd, ver, err := compound.LoadPlayer(ctx, nk, c.UserID, pub.Snap.DayID)
	if err != nil {
		return "", failed("pick_a_cult_first")
	}
	pd, err = compound.ApplyChange(ctx, nk, pd, c, time.Now().Unix())
	if err != nil {
		return "", failed(err.Error())
	}
	if _, err := compound.SavePlayer(ctx, nk, pd, ver); err != nil {
		return "", failed("try_again")
	}
	return out(pd)
}

func defect(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	return change(ctx, nk, compound.Change{Type: "defect", UserID: uid})
}

func switchCult(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	uid, err := userID(ctx)
	if err != nil {
		return "", err
	}
	var in cultIn
	if json.Unmarshal([]byte(payload), &in) != nil || in.CultID == "" {
		return "", errBadArgs
	}
	return change(ctx, nk, compound.Change{Type: "switch", UserID: uid, Cult: in.CultID})
}

// ---- summary / archive ----

type dayIn struct {
	DayID string `json:"dayId"`
}

func getSummary(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var in dayIn
	if json.Unmarshal([]byte(payload), &in) != nil || in.DayID == "" {
		return "", errBadArgs
	}
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{Collection: world.CollSummaries, Key: in.DayID}})
	if err != nil {
		return "", err
	}
	if len(objs) == 0 {
		return "", runtime.NewError("no summary for that Day yet", 5)
	}
	var s summary.DaySummary
	_ = json.Unmarshal([]byte(objs[0].Value), &s)
	res := map[string]any{"summary": s}
	// The caller's own result, derived from the final world and their record.
	if uid, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string); uid != "" {
		if pd, _, err := compound.LoadPlayer(ctx, nk, uid, in.DayID); err == nil {
			if days, err := nk.StorageRead(ctx, []*runtime.StorageRead{{Collection: world.CollDays, Key: in.DayID}}); err == nil && len(days) > 0 {
				var saved struct {
					Day engine.WorldDay `json:"day"`
				}
				if json.Unmarshal([]byte(days[0].Value), &saved) == nil {
					pd.Outcome = engine.Outcome(&saved.Day, pd)
				}
			}
			res["you"] = map[string]any{"outcome": pd.Outcome, "cult": pd.Cult, "actions": pd.Actions,
				"contribution": pd.Contribution, "defected": pd.Defected, "name": pd.Name}
		}
	}
	return out(res)
}

type archiveIn struct {
	Cursor string `json:"cursor"`
}

func listArchive(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var in archiveIn
	_ = json.Unmarshal([]byte(payload), &in)
	objs, next, err := nk.StorageList(ctx, "", "", world.CollSummaries, 30, in.Cursor)
	if err != nil {
		return "", err
	}
	type row struct {
		DayID     string `json:"dayId"`
		Headline  string `json:"headline"`
		Winner    string `json:"winner,omitempty"`
		EndReason string `json:"endReason"`
	}
	rows := []row{}
	for _, o := range objs {
		var s summary.DaySummary
		if json.Unmarshal([]byte(o.Value), &s) == nil {
			rows = append(rows, row{DayID: s.DayID, Headline: s.Headline, Winner: s.Winner, EndReason: s.EndReason})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].DayID > rows[j].DayID })
	return out(map[string]any{"days": rows, "cursor": next})
}

// ---- get_pack ----

type packIn struct {
	ID string `json:"id"`
}

// getPack serves a live pack's manifest, strings, compound, codex and emblem, for
// clients when no asset host is configured. Only packs in today's roster.
func getPack(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	var in packIn
	if json.Unmarshal([]byte(payload), &in) != nil {
		return "", errBadArgs
	}
	pub, err := live(ctx, nk)
	if err != nil {
		return "", err
	}
	p := pub.Content.Packs[in.ID]
	if p == nil {
		return "", runtime.NewError("unknown pack", 5)
	}
	read := func(rel string) json.RawMessage {
		b, err := os.ReadFile(filepath.Join(p.Dir, rel))
		if err != nil {
			return json.RawMessage("null")
		}
		return b
	}
	codex, _ := os.ReadFile(filepath.Join(p.Dir, "codex", "en.md"))
	emblem, _ := os.ReadFile(filepath.Join(p.Dir, "emblem.svg")) // optional; checked at load
	return out(map[string]any{
		"id": p.Manifest.ID, "hash": p.Hash, "manifest": read("manifest.json"),
		"strings": read("strings/en.json"), "compound": p.Compound, "codex": string(codex),
		"emblem": string(emblem),
		"actions": p.Order,
	})
}
