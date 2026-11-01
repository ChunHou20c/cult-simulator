package compound

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/heroiclabs/nakama-common/runtime"

	"github.com/cult-simulator/server/engine"
	"github.com/cult-simulator/server/world"
)

var ErrNoRecord = errors.New("no player record for this Day")

// LoadPlayer reads a player's record for a Day, with its storage version.
func LoadPlayer(ctx context.Context, nk runtime.NakamaModule, userID, dayID string) (*engine.PlayerDay, string, error) {
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{Collection: world.CollPlayers, Key: dayID, UserID: userID}})
	if err != nil {
		return nil, "", err
	}
	if len(objs) == 0 {
		return nil, "", ErrNoRecord
	}
	var pd engine.PlayerDay
	if err := json.Unmarshal([]byte(objs[0].Value), &pd); err != nil {
		return nil, "", err
	}
	return &pd, objs[0].Version, nil
}

// SavePlayer writes a player record. version "" overwrites, "*" only
// creates, anything else must match the stored version.
func SavePlayer(ctx context.Context, nk runtime.NakamaModule, pd *engine.PlayerDay, version string) (string, error) {
	v, _ := json.Marshal(pd)
	acks, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection: world.CollPlayers, Key: pd.DayID, UserID: pd.UserID, Value: string(v),
		Version: version, PermissionRead: 1, PermissionWrite: 0,
	}})
	if err != nil {
		return "", err
	}
	return acks[0].Version, nil
}

// Registry maps a user to the compound match they are in, so RPCs such as
// defect and switch can hand the change to the match that owns the record.
var registry sync.Map // userID -> matchID

func RoomOf(userID string) string {
	if v, ok := registry.Load(userID); ok {
		return v.(string)
	}
	return ""
}

// Rooms is the in-process list of open rooms per cult and Day. Nakama's
// match listing indexes labels in batches, so a burst of joins could miss
// a room created a moment ago; this registry is exact on a single node.
var (
	roomsMu sync.Mutex
	rooms   = map[string]map[string]int{} // cult|day -> matchID -> players
)

func roomKey(cult, day string) string { return cult + "|" + day }

func setRoom(cult, day, matchID string, n int, open bool) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	k := roomKey(cult, day)
	if !open {
		delete(rooms[k], matchID)
		return
	}
	if rooms[k] == nil {
		rooms[k] = map[string]int{}
	}
	rooms[k][matchID] = n
}

// FindOrCreate returns the fullest room with space, or creates a new one.
// It reserves the seat so a burst of joins spreads correctly.
func FindOrCreate(cult, day string, create func() (string, error)) (string, error) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	k := roomKey(cult, day)
	best, bestN := "", -1
	for id, n := range rooms[k] {
		if n < roomLimit && n > bestN {
			best, bestN = id, n
		}
	}
	if best != "" {
		rooms[k][best]++
		return best, nil
	}
	id, err := create()
	if err != nil {
		return "", err
	}
	if rooms[k] == nil {
		rooms[k] = map[string]int{}
	}
	rooms[k][id] = 1
	return id, nil
}
