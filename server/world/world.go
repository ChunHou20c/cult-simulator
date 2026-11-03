// Package world is the singleton world match: the only writer of the Day's
// scores. Compounds send it action batches through MatchSignal; Nakama runs
// a match's signal handler inside that match's loop, one call at a time, so
// actions are applied in a strict order.
package world

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/engine"
	"github.com/cult-simulator/server/summary"
)

const (
	ModuleName = "world"
	Label      = `{"kind":"world"}`

	CollSystem    = "system"
	CollDays      = "world_days"
	CollActionLog = "action_log"
	CollSummaries = "day_summaries"
	CollPlayers   = "player_days"

	snapshotEveryTicks = 30 // seconds
	logEveryTicks      = 5
)

// Published is what the world shares with compounds and RPCs in-process.
// It is replaced atomically once per world tick and after every batch.
type Published struct {
	Snap *engine.Snapshot
	// Prev is the final snapshot of the Day before this one, so rooms of the
	// finished Day can still show its result after the next Day has opened.
	Prev    *engine.Snapshot
	Packed  []byte // Snap encoded as MessagePack for the WORLD opcode
	Content *content.Content
	Engine  *engine.Engine
}

var (
	current atomic.Pointer[Published]
	matchID atomic.Value // string
	ensure  sync.Mutex
)

// Current returns the latest published world, or nil before the world starts.
func Current() *Published { return current.Load() }

// MatchID returns the world match id once it is running.
func MatchID() string {
	if v, ok := matchID.Load().(string); ok {
		return v
	}
	return ""
}

// Encode encodes a message as MessagePack using the json field names, so
// the client sees the same keys over RPC and match messages.
func Encode(v any) []byte {
	var b bytes.Buffer
	enc := msgpack.NewEncoder(&b)
	enc.SetCustomStructTag("json")
	_ = enc.Encode(v)
	return b.Bytes()
}

// Decode decodes a client MessagePack payload using json field names.
func Decode(data []byte, v any) error {
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	return dec.Decode(v)
}

// Settings come from the Nakama runtime env (config.yml runtime.env).
type Settings struct {
	ContentDir string
	ResetHour  int   // UTC hour of the daily reset
	DaySeconds int64 // 86400 in production; shorter for local testing
}

func SettingsFrom(env map[string]string) Settings {
	s := Settings{ContentDir: "/nakama/data/content", DaySeconds: 86400}
	if v := env["CONTENT_DIR"]; v != "" {
		s.ContentDir = v
	}
	if v, err := strconv.Atoi(env["RESET_HOUR_UTC"]); err == nil && v >= 0 && v < 24 {
		s.ResetHour = v
	}
	if v, err := strconv.ParseInt(env["DAY_SECONDS"], 10, 64); err == nil && v >= 120 {
		s.DaySeconds = v
	}
	return s
}

// DayBounds returns the start, end and id of the Day containing now.
func (s Settings) DayBounds(now int64) (int64, int64, string) {
	off := int64(s.ResetHour) * 3600
	start := (now-off)/s.DaySeconds*s.DaySeconds + off
	if now < start {
		start -= s.DaySeconds
	}
	id := time.Unix(start+12*3600, 0).UTC().Format("2006-01-02")
	if s.DaySeconds != 86400 {
		id = time.Unix(start, 0).UTC().Format("2006-01-02T1504")
	}
	return start, start + s.DaySeconds, id
}

type logEntry struct {
	Seq int64            `json:"s"`
	Req engine.ActionReq `json:"r"`
}

type state struct {
	set        Settings
	content    *content.Content
	eng        *engine.Engine
	day        *engine.WorldDay
	prev       *engine.Snapshot
	log        []logEntry
	chunk      int
	summarized bool
}

type Match struct{}

func New(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
	return &Match{}, nil
}

// Ensure returns the world match id, creating the match if none runs.
// Safe to call from any RPC; only one world is ever created.
func Ensure(ctx context.Context, nk runtime.NakamaModule) (string, error) {
	if id := MatchID(); id != "" {
		return id, nil
	}
	ensure.Lock()
	defer ensure.Unlock()
	if id := MatchID(); id != "" {
		return id, nil
	}
	ms, err := nk.MatchList(ctx, 1, true, "", nil, nil, "+label.kind:world")
	if err == nil && len(ms) > 0 {
		matchID.Store(ms[0].MatchId)
		return ms[0].MatchId, nil
	}
	id, err := nk.MatchCreate(ctx, ModuleName, nil)
	if err != nil {
		return "", err
	}
	matchID.Store(id)
	return id, nil
}

func (m *Match) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	s := &state{set: SettingsFrom(env)}
	if id, ok := ctx.Value(runtime.RUNTIME_CTX_MATCH_ID).(string); ok {
		matchID.Store(id)
	}
	now := time.Now().Unix()
	if !s.resume(ctx, logger, nk, now) {
		if err := s.openDay(ctx, logger, nk, now); err != nil {
			logger.Error("world: cannot open a Day: %v", err)
		}
	}
	s.publish(now)
	return s, 1, Label
}

// resume loads the current Day's latest snapshot and replays the action log
// after it. Returns false if there is nothing to resume.
func (s *state) resume(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, now int64) bool {
	// The current Day is the one the system record names. (Days open right
	// after the last one ends, so they don't line up with the clock.)
	_, _, dayID := s.set.DayBounds(now)
	if cur, err := nk.StorageRead(ctx, []*runtime.StorageRead{{Collection: CollSystem, Key: "current"}}); err == nil && len(cur) > 0 {
		var c struct {
			DayID string `json:"dayId"`
		}
		if json.Unmarshal([]byte(cur[0].Value), &c) == nil && c.DayID != "" {
			dayID = c.DayID
		}
	}
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{Collection: CollDays, Key: dayID}})
	if err != nil || len(objs) == 0 {
		return false
	}
	var saved struct {
		Day   engine.WorldDay `json:"day"`
		Chunk int             `json:"chunk"`
		Done  bool            `json:"summarized"`
	}
	// A changed DAY_SECONDS discards the saved Day and opens a fresh one.
	if err := json.Unmarshal([]byte(objs[0].Value), &saved); err != nil || saved.Day.EndsAt-saved.Day.StartedAt != s.set.DaySeconds {
		return false
	}
	c, err := content.LoadRoster(s.set.ContentDir)
	if err != nil {
		logger.Error("world: content: %v", err)
		return false
	}
	if c.Hash != saved.Day.ContentHash {
		// Content changed on disk mid-Day; the Day stays on the content it
		// opened with only if that is still loadable. Otherwise keep going
		// on what we have and log it loudly.
		logger.Warn("world: content hash changed mid-Day (%s -> %s); content takes effect at next reset only for new Days", saved.Day.ContentHash, c.Hash)
	}
	s.content, s.eng, s.day, s.chunk, s.summarized = c, engine.New(c), &saved.Day, saved.Chunk, saved.Done
	// Replay logged actions after the snapshot.
	replayed := 0
	cursor := ""
	for {
		list, next, err := nk.StorageList(ctx, "", "", CollActionLog, 100, cursor)
		if err != nil {
			break
		}
		for _, o := range list {
			if !strings.HasPrefix(o.Key, dayID+":") {
				continue
			}
			var chunk struct {
				Entries []logEntry `json:"entries"`
			}
			if json.Unmarshal([]byte(o.Value), &chunk) != nil {
				continue
			}
			for _, le := range chunk.Entries {
				if le.Seq <= s.day.Seq {
					continue
				}
				s.eng.Tick(s.day, le.Req.At)
				s.eng.Apply(s.day, le.Req)
				replayed++
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}
	logger.Info("world: resumed Day %s at seq %d (%d actions replayed)", dayID, s.day.Seq, replayed)
	return true
}

func (s *state) openDay(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, now int64) error {
	c, err := content.LoadRoster(s.set.ContentDir)
	if c != nil {
		for id, e := range c.Dropped {
			logger.Error("world: ALERT pack %s dropped from today's roster: %v", id, e)
		}
	}
	if err != nil {
		return err
	}
	start, end, dayID := s.set.DayBounds(now)
	if s.day != nil {
		// The next Day starts now and runs a full DaySeconds.
		start, end, dayID = now, now+s.set.DaySeconds, nextDayID(now, s.day.DayID)
	}
	s.content, s.eng = c, engine.New(c)
	s.day = s.eng.NewDay(dayID, start, end, nil)
	s.log, s.chunk, s.summarized = nil, 0, false
	logger.Info("world: opened Day %s with %v (content %s)", dayID, c.Roster, c.Hash)
	s.save(ctx, logger, nk)
	return nil
}

// nextDayID names a Day that opens at now: its UTC start to the minute,
// with seconds added if that would repeat the Day before.
func nextDayID(now int64, prev string) string {
	id := time.Unix(now, 0).UTC().Format("2006-01-02T1504")
	if id == prev {
		id = time.Unix(now, 0).UTC().Format("2006-01-02T150405")
	}
	return id
}

func (s *state) publish(now int64) {
	if s.eng == nil || s.day == nil {
		return
	}
	snap := s.eng.Snapshot(s.day, now)
	current.Store(&Published{Snap: snap, Prev: s.prev, Packed: Encode(snap), Content: s.content, Engine: s.eng})
}

func (s *state) save(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule) {
	v, _ := json.Marshal(map[string]any{"day": s.day, "chunk": s.chunk, "summarized": s.summarized})
	_, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{
		{Collection: CollDays, Key: s.day.DayID, Value: string(v), PermissionRead: 0, PermissionWrite: 0},
		{Collection: CollSystem, Key: "current", Value: fmt.Sprintf(`{"dayId":%q}`, s.day.DayID), PermissionRead: 0, PermissionWrite: 0},
	})
	if err != nil {
		logger.Error("world: save: %v", err)
	}
}

func (s *state) flushLog(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule) {
	if len(s.log) == 0 {
		return
	}
	v, _ := json.Marshal(map[string]any{"entries": s.log})
	key := fmt.Sprintf("%s:%06d", s.day.DayID, s.chunk)
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{Collection: CollActionLog, Key: key, Value: string(v)}}); err != nil {
		logger.Error("world: action log: %v", err)
		return
	}
	s.chunk++
	s.log = s.log[:0]
}

// conclude writes the final snapshot and the summary once per Day. Keyed by
// dayId, so running it twice does nothing the second time.
func (s *state) conclude(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule) {
	if s.summarized {
		return
	}
	s.flushLog(ctx, logger, nk)
	sum := summary.Build(s.day, s.content)
	v, _ := json.Marshal(sum)
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{Collection: CollSummaries, Key: s.day.DayID, Value: string(v), PermissionRead: 2, PermissionWrite: 0}}); err != nil {
		logger.Error("world: summary: %v", err)
		return
	}
	s.summarized = true
	s.save(ctx, logger, nk)
	logger.Info("world: Day %s ended (%s, winner %q)", s.day.DayID, s.day.EndReason, s.day.Winner)
}

func (m *Match) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	return st, false, "the world match takes no players"
}

func (m *Match) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presences []runtime.Presence) interface{} {
	return st
}

func (m *Match) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presences []runtime.Presence) interface{} {
	return st
}

func (m *Match) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, messages []runtime.MatchData) interface{} {
	s := st.(*state)
	now := time.Now().Unix()
	if s.day == nil {
		// No Day yet (content failed to load): retry every 30 s.
		if tick%30 == 0 {
			_ = s.openDay(ctx, logger, nk, now)
			s.publish(now)
		}
		return s
	}
	s.eng.Tick(s.day, now)
	if s.day.Phase == engine.PhaseConcluded || now >= s.day.EndsAt {
		// The Day is over (a win, every cult fallen, or time up): write its
		// summary and open the next Day on fresh content straight away.
		s.conclude(ctx, logger, nk)
		ended := s.eng.Snapshot(s.day, now)
		if err := s.openDay(ctx, logger, nk, now); err != nil {
			logger.Error("world: next Day failed, keeping the old Day: %v", err)
		} else {
			s.prev = ended
		}
	}
	if tick%logEveryTicks == 0 {
		s.flushLog(ctx, logger, nk)
	}
	if tick%snapshotEveryTicks == 0 {
		s.flushLog(ctx, logger, nk)
		s.save(ctx, logger, nk)
	}
	s.publish(now)
	return s
}

func (m *Match) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, graceSeconds int) interface{} {
	s := st.(*state)
	if s.day != nil {
		s.flushLog(ctx, logger, nk)
		s.save(ctx, logger, nk)
	}
	matchID.Store("")
	return s
}

// ---- signals ----

// Signal is what compounds and RPCs send to the world.
type Signal struct {
	Type    string             `json:"type"` // batch, players, defect
	Day     string             `json:"day"`
	Actions []engine.ActionReq `json:"actions,omitempty"`
	Cult    string             `json:"cult,omitempty"`
	Delta   int                `json:"delta,omitempty"`
}

type SignalReply struct {
	Results []engine.ActionResult `json:"results,omitempty"`
	Seq     int64                 `json:"seq"`
	Error   string                `json:"error,omitempty"`
}

func (m *Match) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, data string) (interface{}, string) {
	s := st.(*state)
	reply := SignalReply{}
	var sig Signal
	if err := json.Unmarshal([]byte(data), &sig); err != nil {
		reply.Error = "bad_signal"
		b, _ := json.Marshal(reply)
		return s, string(b)
	}
	if s.day == nil || sig.Day != s.day.DayID {
		reply.Error = "wrong_day"
		for range sig.Actions {
			reply.Results = append(reply.Results, engine.ActionResult{Reason: "day_over"})
		}
		b, _ := json.Marshal(reply)
		return s, string(b)
	}
	now := time.Now().Unix()
	switch sig.Type {
	case "batch":
		s.eng.Tick(s.day, now)
		for _, a := range sig.Actions {
			a.At = now
			r := s.eng.Apply(s.day, a)
			if r.OK {
				s.log = append(s.log, logEntry{Seq: s.day.Seq, Req: a})
			}
			reply.Results = append(reply.Results, r)
		}
	case "players":
		s.eng.AddPlayer(s.day, sig.Cult, sig.Delta)
	case "defect":
		s.eng.Defect(s.day, sig.Cult)
	}
	reply.Seq = s.day.Seq
	s.publish(now)
	b, _ := json.Marshal(reply)
	return s, string(b)
}

// Send signals the world and decodes its reply.
func Send(ctx context.Context, nk runtime.NakamaModule, sig Signal) (*SignalReply, error) {
	id, err := Ensure(ctx, nk)
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(sig)
	out, err := nk.MatchSignal(ctx, id, string(b))
	if err != nil {
		matchID.Store("") // the world may have restarted; look it up again next time
		return nil, err
	}
	var r SignalReply
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ContentDirFromEnv is used by RPCs that read pack files.
func ContentDirFromEnv(ctx context.Context) string {
	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	return SettingsFrom(env).ContentDir
}
