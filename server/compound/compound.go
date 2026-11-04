// Package compound is the room match: presence, mats, rituals, convergence,
// energy and cooldown checks, and batching accepted actions to the world.
// One match per cult room, up to 50 players.
package compound

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"

	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/engine"
	"github.com/cult-simulator/server/minigame"
	"github.com/cult-simulator/server/protocol"
	"github.com/cult-simulator/server/world"
)

const (
	ModuleName   = "compound"
	tickRate     = 10
	batchEvery   = 2     // ticks: 200 ms
	worldEvery   = 10    // ticks: 1 s
	saveEvery    = 300   // ticks: 30 s
	emptyTimeout = 600   // ticks with nobody inside before the room closes
	walkSpeed    = 140.0 // px per second
	kneelReach   = 48.0
	roomLimit    = protocol.RoomSize - 2 // leave seats for reconnects
)

type player struct {
	p        runtime.Presence
	pd       *engine.PlayerDay
	version  string
	dirty    bool
	x0, y0   float64
	x1, y1   float64
	t0       int64  // ms
	pose     string // stand, kneel
	mat      string
	cooldown map[string]int64 // action -> unix second it is ready
	round    *round           // open mini game, if any
	lastMsg  int64
	msgs     int
}

func (pl *player) pos(nowMs int64) (float64, float64) {
	d := math.Hypot(pl.x1-pl.x0, pl.y1-pl.y0)
	if d == 0 {
		return pl.x1, pl.y1
	}
	f := float64(nowMs-pl.t0) / 1000 * walkSpeed / d
	if f >= 1 {
		return pl.x1, pl.y1
	}
	return pl.x0 + (pl.x1-pl.x0)*f, pl.y0 + (pl.y1-pl.y0)*f
}

type pending struct {
	user     string
	seq      int64
	action   string
	energy   float64
	defector bool
	req      engine.ActionReq
	grades   []float64
}

// round is a player's open mini game: the server picked the seed, so only
// it knows the layout the inputs are scored against.
type round struct {
	nonce    string
	seed     uint32
	game     string
	action   string
	seq      int64
	issued   int64 // ms
	cost     float64
	conv     bool
	defector bool
}

// roundTTL: a round not finished by then is scored as a skip.
const roundTTL = 15000

type sighting struct {
	user string
	at   int64 // ms
}

type state struct {
	cult, day string
	n         int
	layout    content.Compound
	players   map[string]*player
	joining   map[string]*player
	mats      map[string]string // mat -> user
	queue     []pending
	recent    map[string][]sighting
	watch     map[string]*minigame.Watch // user -> recent round results
	empty     int
	ended     bool
	label     string
	id        string
}

type Match struct{}

func New(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
	return &Match{}, nil
}

type labelT struct {
	Kind string `json:"kind"`
	Cult string `json:"cult"`
	Day  string `json:"day"`
	N    int    `json:"n"`
	Open bool   `json:"open"`
}

func (s *state) makeLabel() string {
	b, _ := json.Marshal(labelT{Kind: "compound", Cult: s.cult, Day: s.day, N: len(s.players) + len(s.joining), Open: !s.ended && len(s.players)+len(s.joining) < protocol.RoomSize})
	return string(b)
}

func (m *Match) MatchInit(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, params map[string]interface{}) (interface{}, int, string) {
	s := &state{players: map[string]*player{}, joining: map[string]*player{}, mats: map[string]string{}, recent: map[string][]sighting{}, watch: map[string]*minigame.Watch{}}
	s.id, _ = ctx.Value(runtime.RUNTIME_CTX_MATCH_ID).(string)
	s.cult, _ = params["cult"].(string)
	s.day, _ = params["day"].(string)
	if pub := world.Current(); pub != nil {
		if p := pub.Content.Packs[s.cult]; p != nil {
			s.layout = p.Compound
		}
	}
	if s.layout.Width == 0 {
		s.layout = content.DefaultCompound()
	}
	s.label = s.makeLabel()
	return s, tickRate, s.label
}

func (m *Match) MatchJoinAttempt(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presence runtime.Presence, metadata map[string]string) (interface{}, bool, string) {
	s := st.(*state)
	if s.ended {
		return s, false, "day_over"
	}
	if len(s.players)+len(s.joining) >= protocol.RoomSize {
		return s, false, "room_full"
	}
	uid := presence.GetUserId()
	if old, ok := s.players[uid]; ok {
		// Same user reconnecting with a new session: take over the record.
		s.joining[uid] = old
		return s, true, ""
	}
	pd, ver, err := LoadPlayer(ctx, nk, uid, s.day)
	if err != nil {
		return s, false, "pick_a_cult_first"
	}
	if pd.Cult != s.cult {
		return s, false, "wrong_cult"
	}
	sp := s.layout.Spawn[len(s.players)%len(s.layout.Spawn)]
	s.joining[uid] = &player{pd: pd, version: ver, x0: sp[0], y0: sp[1], x1: sp[0], y1: sp[1], pose: "stand", cooldown: map[string]int64{}}
	return s, true, ""
}

func (s *state) view(pl *player, nowMs int64) map[string]any {
	x, y := pl.pos(nowMs)
	return map[string]any{"id": pl.pd.UserID, "name": pl.pd.Name, "x": x, "y": y, "tx": pl.x1, "ty": pl.y1,
		// x, y is where the player is at nowMs, so the walk restarts from there.
		"t0": nowMs, "pose": pl.pose, "mat": pl.mat, "defected": pl.pd.Defected}
}

func (s *state) energyOf(pl *player, now int64) float64 {
	en, at := engine.Energy(pl.pd, now)
	pl.pd.Energy, pl.pd.EnergyAt = en, at
	return en
}

func (m *Match) MatchJoin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presences []runtime.Presence) interface{} {
	s := st.(*state)
	nowMs := time.Now().UnixMilli()
	matchID, _ := ctx.Value(runtime.RUNTIME_CTX_MATCH_ID).(string)
	for _, p := range presences {
		uid := p.GetUserId()
		pl := s.joining[uid]
		if pl == nil {
			continue
		}
		delete(s.joining, uid)
		reconnect := s.players[uid] != nil
		pl.p = p
		s.players[uid] = pl
		registry.Store(uid, matchID)
		var others []map[string]any
		for id, o := range s.players {
			if id != uid {
				others = append(others, s.view(o, nowMs))
			}
		}
		cd := map[string]int64{}
		for k, v := range pl.cooldown {
			cd[k] = v
		}
		snap := map[string]any{
			"you": uid, "players": others, "self": s.view(pl, nowMs), "mats": s.layout.Mats, "taken": s.mats,
			"width": s.layout.Width, "height": s.layout.Height, "serverTime": nowMs,
			"energy": s.energyOf(pl, nowMs/1000), "energyAt": pl.pd.EnergyAt, "maxEnergy": engine.MaxEnergy,
			"refillSec": engine.EnergyRefillSec, "cooldowns": cd, "player": pl.pd,
		}
		_ = dispatcher.BroadcastMessage(protocol.OpSnapshot, world.Encode(snap), []runtime.Presence{p}, nil, true)
		if pub := world.Current(); pub != nil {
			_ = dispatcher.BroadcastMessage(protocol.OpWorld, pub.Packed, []runtime.Presence{p}, nil, true)
		}
		if !reconnect {
			_ = dispatcher.BroadcastMessage(protocol.OpJoined, world.Encode(s.view(pl, nowMs)), s.othersThan(uid), nil, true)
		}
	}
	s.updateLabel(dispatcher)
	return s
}

func (s *state) othersThan(uid string) []runtime.Presence {
	out := make([]runtime.Presence, 0, len(s.players))
	for id, pl := range s.players {
		if id != uid && pl.p != nil {
			out = append(out, pl.p)
		}
	}
	return out
}

func (s *state) updateLabel(d runtime.MatchDispatcher) {
	setRoom(s.cult, s.day, s.id, len(s.players)+len(s.joining), !s.ended)
	if l := s.makeLabel(); l != s.label {
		s.label = l
		_ = d.MatchLabelUpdate(l)
	}
}

func (m *Match) MatchLeave(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, presences []runtime.Presence) interface{} {
	s := st.(*state)
	for _, p := range presences {
		uid := p.GetUserId()
		pl := s.players[uid]
		if pl == nil || pl.p == nil || pl.p.GetSessionId() != p.GetSessionId() {
			continue // an older session of a reconnected player
		}
		if pl.round != nil {
			s.finishRound(pl, nil, true, time.Now().UnixMilli())
		}
		s.save(ctx, logger, nk, pl)
		if pl.mat != "" {
			delete(s.mats, pl.mat)
		}
		delete(s.players, uid)
		registry.Delete(uid)
		_ = dispatcher.BroadcastMessage(protocol.OpLeft, world.Encode(map[string]any{"id": uid}), nil, nil, true)
	}
	s.updateLabel(dispatcher)
	return s
}

// save writes a player's record. If an RPC changed it meanwhile, the
// stored cult and defection win and the room's own counters are kept.
func (s *state) save(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, pl *player) {
	if !pl.dirty {
		return
	}
	ver, err := SavePlayer(ctx, nk, pl.pd, pl.version)
	if err != nil {
		stored, sver, rerr := LoadPlayer(ctx, nk, pl.pd.UserID, s.day)
		if rerr != nil {
			logger.Error("compound: save %s: %v", pl.pd.UserID, err)
			return
		}
		stored.Energy, stored.EnergyAt, stored.Actions = pl.pd.Energy, pl.pd.EnergyAt, pl.pd.Actions
		stored.Contribution, stored.Evidence = pl.pd.Contribution, pl.pd.Evidence
		pl.pd = stored
		if ver, err = SavePlayer(ctx, nk, pl.pd, sver); err != nil {
			logger.Error("compound: save %s after merge: %v", pl.pd.UserID, err)
			return
		}
	}
	pl.version, pl.dirty = ver, false
}

type moveMsg struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type matMsg struct {
	Mat string `json:"mat"`
}
type ritualMsg struct {
	Ritual string `json:"ritual"`
}
type actMsg struct {
	Action string `json:"actionId"`
	Seq    int64  `json:"clientSeq"`
}
type finishMsg struct {
	Nonce  string           `json:"nonce"`
	Inputs []minigame.Input `json:"inputs"`
	Skip   bool             `json:"skip"`
}

func (m *Match) MatchLoop(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, messages []runtime.MatchData) interface{} {
	s := st.(*state)
	nowMs := time.Now().UnixMilli()
	now := nowMs / 1000
	pub := world.Current()

	for _, msg := range messages {
		pl := s.players[msg.GetUserId()]
		if pl == nil || pl.p == nil || pl.p.GetSessionId() != msg.GetSessionId() {
			continue
		}
		// Simple flood guard: 20 messages per second per player.
		if now != pl.lastMsg {
			pl.lastMsg, pl.msgs = now, 0
		}
		if pl.msgs++; pl.msgs > 20 {
			continue
		}
		switch msg.GetOpCode() {
		case protocol.OpMove:
			var mv moveMsg
			if world.Decode(msg.GetData(), &mv) != nil {
				continue
			}
			mv.X = math.Max(20, math.Min(s.layout.Width-20, mv.X))
			mv.Y = math.Max(20, math.Min(s.layout.Height-20, mv.Y))
			x, y := pl.pos(nowMs)
			if pl.mat != "" {
				delete(s.mats, pl.mat)
				pl.mat = ""
			}
			pl.x0, pl.y0, pl.x1, pl.y1, pl.t0, pl.pose = x, y, mv.X, mv.Y, nowMs, "stand"
			_ = dispatcher.BroadcastMessage(protocol.OpWalk, world.Encode(map[string]any{
				"id": pl.pd.UserID, "fx": x, "fy": y, "tx": mv.X, "ty": mv.Y, "t0": nowMs}), nil, nil, true)
		case protocol.OpKneel:
			var mm matMsg
			if world.Decode(msg.GetData(), &mm) != nil {
				continue
			}
			s.kneel(dispatcher, pl, mm.Mat, nowMs)
		case protocol.OpRise:
			if pl.mat != "" {
				delete(s.mats, pl.mat)
			}
			pl.mat, pl.pose = "", "stand"
			_ = dispatcher.BroadcastMessage(protocol.OpPose, world.Encode(map[string]any{"id": pl.pd.UserID, "pose": "stand"}), nil, nil, true)
		case protocol.OpRitual:
			var rm ritualMsg
			if world.Decode(msg.GetData(), &rm) != nil || !protocol.Rituals[rm.Ritual] {
				continue
			}
			_ = dispatcher.BroadcastMessage(protocol.OpRitualSeen, world.Encode(map[string]any{"id": pl.pd.UserID, "ritual": rm.Ritual}), nil, nil, true)
			s.converge(dispatcher, "ritual:"+rm.Ritual, pl.pd.UserID, nowMs)
		case protocol.OpAct, protocol.OpDefectAct:
			var am actMsg
			if world.Decode(msg.GetData(), &am) != nil {
				continue
			}
			s.act(dispatcher, pub, pl, am, msg.GetOpCode() == protocol.OpDefectAct, nowMs)
		case protocol.OpActStart:
			var am actMsg
			if world.Decode(msg.GetData(), &am) != nil {
				continue
			}
			s.startRound(dispatcher, pub, pl, am, nowMs)
		case protocol.OpActFinish:
			var fm finishMsg
			if world.Decode(msg.GetData(), &fm) != nil || pl.round == nil || fm.Nonce != pl.round.nonce {
				continue
			}
			if fm.Skip {
				fm.Inputs = nil
			}
			s.finishRound(pl, fm.Inputs, fm.Skip, nowMs)
		case protocol.OpHeartbeat:
			// keeps the socket warm through Cloudflare; nothing to do
		}
	}

	for _, pl := range s.players {
		if pl.round != nil && nowMs-pl.round.issued > roundTTL {
			s.finishRound(pl, nil, true, nowMs)
		}
	}
	if tick%batchEvery == 0 && len(s.queue) > 0 {
		s.flush(ctx, logger, nk, dispatcher, now)
	}
	if pub != nil && tick%worldEvery == 0 {
		s.worldTick(ctx, logger, nk, dispatcher, pub)
	}
	if tick%saveEvery == 0 {
		for _, pl := range s.players {
			s.save(ctx, logger, nk, pl)
		}
	}
	if len(s.players)+len(s.joining) == 0 {
		if s.empty++; s.empty > emptyTimeout {
			setRoom(s.cult, s.day, s.id, 0, false)
			return nil // close the room
		}
	} else {
		s.empty = 0
	}
	return s
}

func (s *state) kneel(d runtime.MatchDispatcher, pl *player, mat string, nowMs int64) {
	var target *content.Mat
	for i := range s.layout.Mats {
		if s.layout.Mats[i].ID == mat {
			target = &s.layout.Mats[i]
		}
	}
	if target == nil {
		return
	}
	if owner, taken := s.mats[mat]; taken && owner != pl.pd.UserID {
		return
	}
	x, y := pl.pos(nowMs)
	if math.Hypot(x-target.X, y-target.Y) > kneelReach {
		// Server correction: tell the client where it really is.
		_ = d.BroadcastMessage(protocol.OpCorrection, world.Encode(map[string]any{"x": x, "y": y, "pose": pl.pose, "mat": pl.mat}), []runtime.Presence{pl.p}, nil, true)
		return
	}
	if pl.mat != "" {
		delete(s.mats, pl.mat)
	}
	s.mats[mat] = pl.pd.UserID
	pl.mat, pl.pose = mat, "kneel"
	pl.x0, pl.y0, pl.x1, pl.y1, pl.t0 = target.X, target.Y, target.X, target.Y, nowMs
	_ = d.BroadcastMessage(protocol.OpPose, world.Encode(map[string]any{"id": pl.pd.UserID, "pose": "kneel", "mat": mat, "x": target.X, "y": target.Y}), nil, nil, true)
}

// converge reports whether, counting this one, ConvergenceCount different
// players did the same thing in the last ConvergenceSec seconds.
func (s *state) converge(d runtime.MatchDispatcher, key, user string, nowMs int64) bool {
	list := s.recent[key][:0]
	for _, sg := range s.recent[key] {
		if nowMs-sg.at <= engine.ConvergenceSec*1000 && sg.user != user {
			list = append(list, sg)
		}
	}
	list = append(list, sighting{user: user, at: nowMs})
	s.recent[key] = list
	if len(list) >= engine.ConvergenceCount {
		ids := make([]string, len(list))
		for i, sg := range list {
			ids[i] = sg.user
		}
		_ = d.BroadcastMessage(protocol.OpConvergence, world.Encode(map[string]any{"key": key, "players": ids}), nil, nil, true)
		return true
	}
	return false
}

func (s *state) result(d runtime.MatchDispatcher, pl *player, seq int64, ok bool, reason string, deltas map[string]float64, p ...pending) {
	m := map[string]any{
		"clientSeq": seq, "ok": ok, "reason": reason, "energy": pl.pd.Energy, "energyAt": pl.pd.EnergyAt,
		"deltas": deltas, "cooldowns": pl.cooldown, "evidence": pl.pd.Evidence, "actions": pl.pd.Actions,
		"contribution": pl.pd.Contribution}
	if len(p) > 0 && p[0].req.Played {
		m["quality"], m["grades"] = p[0].req.Quality, p[0].grades
	}
	_ = d.BroadcastMessage(protocol.OpActResult, world.Encode(m), []runtime.Presence{pl.p}, nil, true)
}

func defectorEnergy(string) int { return 1 }

func isDefectorAction(id string) bool {
	for _, a := range content.DefectorActionIDs {
		if a == id {
			return true
		}
	}
	return false
}

// act checks and takes an action with no mini game round (old clients,
// defector actions) and queues it for the next batch.
func (s *state) act(d runtime.MatchDispatcher, pub *world.Published, pl *player, am actMsg, defector bool, nowMs int64) {
	cost, ok := s.begin(d, pub, pl, am, defector, nowMs)
	if !ok {
		return
	}
	conv := !defector && s.converge(d, "act:"+am.Action, pl.pd.UserID, nowMs)
	s.queue = append(s.queue, pending{user: pl.pd.UserID, seq: am.Seq, action: am.Action, energy: float64(cost), defector: defector,
		req: engine.ActionReq{UserID: pl.pd.UserID, Name: pl.pd.Name, Cult: s.cult, Action: am.Action, Defector: defector,
			Evidence: pl.pd.Evidence, Converged: conv, At: nowMs / 1000}})
}

// startRound takes the action now (energy, cooldown, the room sees the
// movement) and hands the player a mini game round. The action is applied
// when the round is finished, skipped or expires.
func (s *state) startRound(d runtime.MatchDispatcher, pub *world.Published, pl *player, am actMsg, nowMs int64) {
	if pl.round != nil {
		s.finishRound(pl, nil, true, nowMs)
	}
	// A defector's round plays one of the defector actions; anyone else's
	// plays their cult's action.
	defector := pl.pd.Defected
	game := ""
	if defector {
		game = content.DefectorGames[am.Action]
	} else if pub != nil {
		if p := pub.Content.Packs[s.cult]; p != nil {
			if a := p.Actions[am.Action]; a != nil {
				game = a.Game
			}
		}
	}
	if game == "" {
		s.act(d, pub, pl, am, defector, nowMs)
		return
	}
	cost, ok := s.begin(d, pub, pl, am, defector, nowMs)
	if !ok {
		return
	}
	var b [12]byte
	_, _ = rand.Read(b[:])
	r := &round{nonce: hex.EncodeToString(b[4:]), seed: binary.LittleEndian.Uint32(b[:4]), game: game, action: am.Action,
		seq: am.Seq, issued: nowMs, cost: float64(cost)}
	r.defector = defector
	if !defector {
		r.conv = s.converge(d, "act:"+am.Action, pl.pd.UserID, nowMs)
	}
	pl.round = r
	_ = d.BroadcastMessage(protocol.OpActChallenge, world.Encode(map[string]any{
		"clientSeq": am.Seq, "nonce": r.nonce, "seed": r.seed, "game": r.game, "action": r.action}), []runtime.Presence{pl.p}, nil, true)
}

// finishRound scores the round's raw inputs (a skip or an expired round
// scores minigame.SkipQuality) and queues the action.
func (s *state) finishRound(pl *player, inputs []minigame.Input, skip bool, nowMs int64) {
	r := pl.round
	pl.round = nil
	q, grades := minigame.SkipQuality, []float64(nil)
	if !skip {
		var ok bool
		q, grades, ok = minigame.Score(r.game, r.seed, inputs, float64(nowMs-r.issued))
		if !ok {
			q, grades = minigame.SkipQuality, nil
		}
		w := s.watch[pl.pd.UserID]
		if w == nil {
			w = &minigame.Watch{}
			s.watch[pl.pd.UserID] = w
		}
		q = w.Note(q)
	}
	s.queue = append(s.queue, pending{user: pl.pd.UserID, seq: r.seq, action: r.action, energy: r.cost, grades: grades, defector: r.defector,
		req: engine.ActionReq{UserID: pl.pd.UserID, Name: pl.pd.Name, Cult: s.cult, Action: r.action, Defector: r.defector,
			Evidence: pl.pd.Evidence, Converged: r.conv, At: nowMs / 1000, Played: true, Quality: q}})
}

// begin checks energy, cooldown and the action's requires flag against the
// latest world snapshot, then takes the energy and starts the cooldown.
func (s *state) begin(d runtime.MatchDispatcher, pub *world.Published, pl *player, am actMsg, defector bool, nowMs int64) (int, bool) {
	now := nowMs / 1000
	if pub == nil || pub.Snap.DayID != s.day || pub.Snap.Phase != engine.PhaseLive {
		s.result(d, pl, am.Seq, false, "day_over", nil)
		return 0, false
	}
	var cost int
	var cooldownSec int
	if defector {
		if !pl.pd.Defected || !isDefectorAction(am.Action) {
			s.result(d, pl, am.Seq, false, "not_a_defector_action", nil)
			return 0, false
		}
		if am.Action == "talk_to_journalist" && pl.pd.Evidence < content.EvidenceForJournalist {
			s.result(d, pl, am.Seq, false, "need_evidence", nil)
			return 0, false
		}
		cost, cooldownSec = defectorEnergy(am.Action), 20
	} else {
		if pl.pd.Defected {
			s.result(d, pl, am.Seq, false, "defected", nil)
			return 0, false
		}
		p := pub.Content.Packs[s.cult]
		a := p.Actions[am.Action]
		if a == nil {
			s.result(d, pl, am.Seq, false, "unknown_action", nil)
			return 0, false
		}
		var can bool
		for _, cv := range pub.Snap.Cults {
			if cv.ID == s.cult {
				can = cv.Can[am.Action]
			}
		}
		if !can {
			s.result(d, pl, am.Seq, false, "requirement", nil)
			return 0, false
		}
		cost, cooldownSec = a.Energy, a.CooldownSec
	}
	if pl.cooldown[am.Action] > now {
		s.result(d, pl, am.Seq, false, "cooldown", nil)
		return 0, false
	}
	if s.energyOf(pl, now) < float64(cost) {
		s.result(d, pl, am.Seq, false, "no_energy", nil)
		return 0, false
	}
	if pl.pd.Energy >= engine.MaxEnergy {
		pl.pd.EnergyAt = now // refill clock starts when energy drops below max
	}
	pl.pd.Energy -= float64(cost)
	pl.dirty = true
	if cooldownSec > 0 {
		pl.cooldown[am.Action] = now + int64(cooldownSec)
	}
	// Everyone in the room sees the movement now, before the world settles it.
	_ = d.BroadcastMessage(protocol.OpActSeen, world.Encode(map[string]any{"id": pl.pd.UserID, "action": am.Action}), nil, nil, true)
	return cost, true
}

// flush sends the queued actions to the world in one signal and reports
// each result back to its player. Refused actions get their energy back.
func (s *state) flush(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, d runtime.MatchDispatcher, now int64) {
	q := s.queue
	s.queue = nil
	sig := world.Signal{Type: "batch", Day: s.day}
	for _, p := range q {
		sig.Actions = append(sig.Actions, p.req)
	}
	reply, err := world.Send(ctx, nk, sig)
	for i, p := range q {
		pl := s.players[p.user]
		if pl == nil {
			continue
		}
		var r engine.ActionResult
		if err != nil || i >= len(reply.Results) {
			r = engine.ActionResult{Reason: "world_unavailable"}
		} else {
			r = reply.Results[i]
		}
		if !r.OK {
			pl.pd.Energy = math.Min(engine.MaxEnergy, pl.pd.Energy+p.energy)
			delete(pl.cooldown, p.action)
			s.result(d, pl, p.seq, false, r.Reason, nil)
			continue
		}
		if !p.defector {
			pl.pd.Actions++
			pl.pd.Contribution += r.Contribution
		}
		pl.pd.Evidence += r.EvidenceGain - r.EvidenceUsed
		pl.dirty = true
		s.result(d, pl, p.seq, true, "", r.Deltas, p)
	}
	if err != nil {
		logger.Error("compound %s: world signal: %v", s.cult, err)
	}
}

// worldTick broadcasts the world snapshot once a second and handles the
// Day ending: every client switches to the end card at the same moment,
// and the room closes as soon as the next Day opens.
func (s *state) worldTick(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, d runtime.MatchDispatcher, pub *world.Published) {
	if pub.Snap.DayID != s.day {
		for _, pl := range s.players {
			s.save(ctx, logger, nk, pl)
		}
		msg := map[string]any{"dayId": s.day, "reset": true, "summaryId": s.day}
		if prev := pub.Prev; prev != nil && prev.DayID == s.day {
			// The next Day opened at once: send this room's result with it.
			msg["reason"], msg["winner"] = prev.EndReason, prev.Winner
			for _, c := range prev.Cults {
				if c.ID == s.cult {
					msg["cult"] = c
				}
			}
		}
		_ = d.BroadcastMessage(protocol.OpDayEnded, world.Encode(msg), nil, nil, true)
		s.ended = true
		s.updateLabel(d)
		var ps []runtime.Presence
		for _, pl := range s.players {
			ps = append(ps, pl.p)
		}
		_ = d.MatchKick(ps)
		return
	}
	_ = d.BroadcastMessage(protocol.OpWorld, pub.Packed, nil, nil, false)
	if pub.Snap.Phase == engine.PhaseConcluded && !s.ended {
		s.ended = true
		s.updateLabel(d)
		_ = d.BroadcastMessage(protocol.OpDayEnded, world.Encode(map[string]any{
			"dayId": s.day, "reason": pub.Snap.EndReason, "winner": pub.Snap.Winner, "summaryId": s.day}), nil, nil, true)
	}
}

func (m *Match) MatchTerminate(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, graceSeconds int) interface{} {
	s := st.(*state)
	setRoom(s.cult, s.day, s.id, 0, false)
	for uid, pl := range s.players {
		s.save(ctx, logger, nk, pl)
		registry.Delete(uid)
	}
	return s
}

// ---- signals from RPCs (defect, switch) ----

type Change struct {
	Type   string `json:"type"` // defect, switch
	UserID string `json:"userId"`
	Cult   string `json:"cult,omitempty"`
}

func (m *Match) MatchSignal(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, dispatcher runtime.MatchDispatcher, tick int64, st interface{}, data string) (interface{}, string) {
	s := st.(*state)
	var c Change
	if json.Unmarshal([]byte(data), &c) != nil {
		return s, `{"error":"bad_signal"}`
	}
	pl := s.players[c.UserID]
	if pl == nil {
		return s, `{"error":"not_here"}`
	}
	out, err := ApplyChange(ctx, nk, pl.pd, c, time.Now().Unix())
	if err != nil {
		return s, fmt.Sprintf(`{"error":%q}`, err.Error())
	}
	pl.dirty = true
	s.save(ctx, logger, nk, pl)
	if c.Type == "switch" {
		// The player belongs to another cult's compound now.
		_ = dispatcher.MatchKick([]runtime.Presence{pl.p})
	} else {
		s.result(dispatcher, pl, 0, true, "defected", nil)
	}
	b, _ := json.Marshal(out)
	return s, string(b)
}

// ApplyChange applies a defect or switch to a player record and tells the
// world. It is used by the room that owns the record, or by the RPC when
// the player is in no room.
func ApplyChange(ctx context.Context, nk runtime.NakamaModule, pd *engine.PlayerDay, c Change, now int64) (*engine.PlayerDay, error) {
	pub := world.Current()
	if pub == nil || pub.Snap.DayID != pd.DayID || pub.Snap.Phase != engine.PhaseLive {
		return nil, fmt.Errorf("day_over")
	}
	var mine *engine.CultView
	for i := range pub.Snap.Cults {
		if pub.Snap.Cults[i].ID == pd.Cult {
			mine = &pub.Snap.Cults[i]
		}
	}
	switch c.Type {
	case "defect":
		if pd.Defected {
			return nil, fmt.Errorf("already_defected")
		}
		if pd.Actions < content.DefectMinActions {
			return nil, fmt.Errorf("need_%d_actions", content.DefectMinActions)
		}
		if mine == nil || mine.Status != engine.StatusStanding {
			return nil, fmt.Errorf("cult_ended")
		}
		pd.Defected = true
		if _, err := world.Send(ctx, nk, world.Signal{Type: "defect", Day: pd.DayID, Cult: pd.Cult}); err != nil {
			return nil, err
		}
	case "switch":
		if pd.SwitchedFrom != "" || pd.Defected {
			return nil, fmt.Errorf("switch_used")
		}
		if mine == nil || mine.Status == engine.StatusStanding {
			return nil, fmt.Errorf("cult_still_standing")
		}
		var target *engine.CultView
		for i := range pub.Snap.Cults {
			if pub.Snap.Cults[i].ID == c.Cult {
				target = &pub.Snap.Cults[i]
			}
		}
		if target == nil || target.Status != engine.StatusStanding {
			return nil, fmt.Errorf("target_not_standing")
		}
		en, at := engine.Energy(pd, now)
		pd.SwitchedFrom, pd.Cult, pd.Energy, pd.EnergyAt = pd.Cult, c.Cult, math.Floor(en/2), at
		if _, err := world.Send(ctx, nk, world.Signal{Type: "players", Day: pd.DayID, Cult: c.Cult, Delta: 1}); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unknown_change")
	}
	return pd, nil
}
