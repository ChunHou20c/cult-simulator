package content

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/cult-simulator/server/protocol"
	"github.com/santhosh-tekuri/jsonschema/v5"
)

// ---- compile helpers ----

func parseValue(raw json.RawMessage) (*Expr, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, nil
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, err
		}
		return compile(s, false)
	}
	f, err := strconv.ParseFloat(string(raw), 64)
	if err != nil {
		return nil, fmt.Errorf("value %s is neither a number nor an expression", raw)
	}
	return ConstExpr(f), nil
}

func compileEffects(defs []EffectDef) ([]Effect, error) {
	out := make([]Effect, 0, len(defs))
	for _, d := range defs {
		e := Effect{Stat: d.Stat, Scaled: d.Scale == "yield"}
		var raw json.RawMessage
		n := 0
		if len(d.Add) > 0 {
			e.Op, raw = OpAdd, d.Add
			n++
		}
		if len(d.Mul) > 0 {
			e.Op, raw = OpMul, d.Mul
			n++
		}
		if len(d.Set) > 0 {
			e.Op, raw = OpSet, d.Set
			n++
		}
		if n != 1 {
			return nil, fmt.Errorf("effect on %q needs exactly one of add, mul, set", d.Stat)
		}
		v, err := parseValue(raw)
		if err != nil {
			return nil, fmt.Errorf("effect on %q: %v", d.Stat, err)
		}
		e.Value = v
		out = append(out, e)
	}
	return out, nil
}

func compileCond(src string) (*Expr, error) {
	if strings.TrimSpace(src) == "" {
		return nil, nil
	}
	return compile(src, true)
}

func compileAction(d ActionDef) (*Action, error) {
	a := &Action{ID: d.ID, Energy: d.Energy, CooldownSec: d.CooldownSec, Buff: d.Buff}
	if a.Energy == 0 {
		a.Energy = 1
	}
	var err error
	if a.Requires, err = compileCond(d.Requires); err != nil {
		return nil, fmt.Errorf("action %s requires: %v", d.ID, err)
	}
	if a.Effects, err = compileEffects(d.Effects); err != nil {
		return nil, fmt.Errorf("action %s: %v", d.ID, err)
	}
	if len(d.Phases) > 0 {
		a.Phases = map[string]bool{}
		for _, p := range d.Phases {
			a.Phases[p] = true
		}
	}
	return a, nil
}

func compileFall(f FallDef) (Fall, error) {
	w, err := compileCond(f.When)
	if err != nil {
		return Fall{}, fmt.Errorf("fall %s: %v", f.Reason, err)
	}
	if w == nil {
		return Fall{}, fmt.Errorf("fall %s: empty condition", f.Reason)
	}
	return Fall{When: w, Reason: f.Reason, Text: f.Text, Historical: f.Historical}, nil
}

// ---- loading ----

// Loader validates packs against the JSON Schema in content/schema.
type Loader struct {
	schema *jsonschema.Schema
}

// NewLoader compiles the manifest schema from contentDir/schema/v1.json.
func NewLoader(contentDir string) (*Loader, error) {
	c := jsonschema.NewCompiler()
	path := filepath.Join(contentDir, "schema", fmt.Sprintf("v%d.json", SchemaMajor))
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if err := c.AddResource("v1.json", f); err != nil {
		return nil, err
	}
	s, err := c.Compile("v1.json")
	if err != nil {
		return nil, err
	}
	return &Loader{schema: s}, nil
}

// ValidationError collects every problem found in one pack.
type ValidationError struct {
	Pack   string
	Issues []string
}

func (v *ValidationError) Error() string {
	return fmt.Sprintf("pack %s: %d issue(s):\n  - %s", v.Pack, len(v.Issues), strings.Join(v.Issues, "\n  - "))
}

// LoadPack loads, validates and compiles one pack folder. Every issue is
// collected, so a pack author sees all problems in one run.
func (l *Loader) LoadPack(dir string) (*Pack, error) {
	ve := &ValidationError{Pack: filepath.Base(dir)}
	add := func(format string, args ...any) { ve.Issues = append(ve.Issues, fmt.Sprintf(format, args...)) }

	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		add("read manifest: %v", err)
		return nil, ve
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		add("manifest is not valid JSON: %v", err)
		return nil, ve
	}
	// Schema version gate: newer minor or other major is skipped, never loaded.
	if m, ok := doc.(map[string]any); ok {
		if s, ok := m["schema"].(string); ok {
			var maj, min int
			if _, err := fmt.Sscanf(s, "%d.%d", &maj, &min); err != nil || maj != SchemaMajor || min > SchemaMinor {
				add("pack needs schema %s, engine supports %d.0 to %d.%d", s, SchemaMajor, SchemaMajor, SchemaMinor)
				return nil, ve
			}
		}
	}
	if err := l.schema.Validate(doc); err != nil {
		var se *jsonschema.ValidationError
		if errors.As(err, &se) {
			for _, c := range flatten(se) {
				add("schema: %s", c)
			}
		} else {
			add("schema: %v", err)
		}
		return nil, ve
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		add("manifest: %v", err)
		return nil, ve
	}
	if m.ID != filepath.Base(dir) {
		add("manifest id %q must match folder name %q", m.ID, filepath.Base(dir))
	}

	p := &Pack{Manifest: m, Dir: dir, Actions: map[string]*Action{}}

	// Stats: core first, then the pack's extras.
	p.Stats = map[string]StatRange{
		"followers": {Min: 0, Max: math.Inf(1), Initial: 10},
		"funds":     {Min: 0, Max: math.Inf(1), Initial: 5000},
		"loyalty":   {Min: 0, Max: 100, Initial: 60},
		"scrutiny":  {Min: 0, Max: 100, Initial: 5},
		"paranoia":  {Min: 0, Max: 100, Initial: 5},
		"exposure":  {Min: 0, Max: 100, Initial: 0},
	}
	for k, v := range m.Initial {
		r := p.Stats[k]
		r.Initial = v
		p.Stats[k] = r
	}
	for k, s := range m.Stats {
		if IsCore(k) {
			add("stat %q is a core stat and cannot be redeclared", k)
			continue
		}
		r := StatRange{Min: math.Inf(-1), Max: math.Inf(1), Initial: s.Initial}
		if s.Min != nil {
			r.Min = *s.Min
		}
		if s.Max != nil {
			r.Max = *s.Max
		}
		p.Stats[k] = r
	}

	if p.Progress, err = compile(m.Goal.Progress, false); err != nil {
		add("goal: %v", err)
	}
	if p.Guard, err = compileCond(m.Guard); err != nil {
		add("guard: %v", err)
	}

	shared := m.SharedActions
	if shared == nil {
		shared = SharedActionIDs
	}
	enabled := map[string]bool{}
	for _, s := range shared {
		enabled[s] = true
	}
	for _, a := range sharedActions {
		if enabled[a.ID] {
			p.Actions[a.ID] = a
			p.Order = append(p.Order, a.ID)
		}
	}
	for _, d := range m.Actions {
		if _, dup := p.Actions[d.ID]; dup || isDefectorAction(d.ID) {
			add("action id %q clashes with an engine action or another action", d.ID)
			continue
		}
		a, err := compileAction(d)
		if err != nil {
			add("%v", err)
			continue
		}
		p.Actions[a.ID] = a
		p.Order = append(p.Order, a.ID)
	}
	if p.Tick, err = compileEffects(m.Tick); err != nil {
		add("tick: %v", err)
	}
	for _, f := range m.Falls {
		cf, err := compileFall(f)
		if err != nil {
			add("%v", err)
			continue
		}
		p.Falls = append(p.Falls, cf)
	}
	p.Falls = append(p.Falls, compiledFalls...)
	phaseIDs := map[string]bool{}
	for _, ph := range m.Phases {
		phaseIDs[ph.ID] = true
		cp := Phase{ID: ph.ID, Next: ph.Next}
		if cp.Progress, err = compile(ph.Goal.Progress, false); err != nil {
			add("phase %s goal: %v", ph.ID, err)
		}
		if cp.Guard, err = compileCond(ph.Guard); err != nil {
			add("phase %s guard: %v", ph.ID, err)
		}
		p.Phases = append(p.Phases, cp)
	}
	for _, ev := range m.Events {
		ce := Event{ID: ev.ID, DelayMin: ev.DelayMin, Text: ev.Text}
		if ce.After, err = compileCond(ev.After); err != nil {
			add("event %s after: %v", ev.ID, err)
		}
		if ce.Check, err = compileCond(ev.Check); err != nil {
			add("event %s check: %v", ev.ID, err)
		}
		if ce.Pass, err = compileEffects(ev.Pass); err != nil {
			add("event %s pass: %v", ev.ID, err)
		}
		if ce.Fail, err = compileEffects(ev.Fail); err != nil {
			add("event %s fail: %v", ev.ID, err)
		}
		p.Events = append(p.Events, ce)
	}

	// Compound layout (optional).
	p.Compound = DefaultCompound()
	if b, err := os.ReadFile(filepath.Join(dir, "compound.json")); err == nil {
		var c Compound
		if err := json.Unmarshal(b, &c); err != nil {
			add("compound.json: %v", err)
		} else if c.Width <= 0 || c.Height <= 0 || len(c.Spawn) == 0 {
			add("compound.json needs width, height and at least one spawn point")
		} else {
			p.Compound = c
		}
	}

	// Emblem (optional): the cult's symbol, shown in the lobby, the HUD and
	// the room. Clients render it as an image, so it must be plain, static SVG.
	if b, err := os.ReadFile(filepath.Join(dir, "emblem.svg")); err == nil {
		if msg := checkEmblem(b); msg != "" {
			add("emblem.svg: %s", msg)
		}
	}

	// Strings (English is required at launch).
	if b, err := os.ReadFile(filepath.Join(dir, "strings", "en.json")); err != nil {
		add("strings/en.json missing: %v", err)
	} else if err := json.Unmarshal(b, &p.Strings); err != nil {
		add("strings/en.json: %v", err)
	}

	if len(ve.Issues) == 0 {
		semanticLint(p, phaseIDs, add)
		careLint(p, add)
	}
	if len(ve.Issues) > 0 {
		return nil, ve
	}
	p.Hash, err = HashDir(dir)
	if err != nil {
		add("hash: %v", err)
		return nil, ve
	}
	return p, nil
}

func isDefectorAction(id string) bool {
	for _, d := range DefectorActionIDs {
		if d == id {
			return true
		}
	}
	return false
}

func flatten(e *jsonschema.ValidationError) []string {
	if len(e.Causes) == 0 {
		loc := e.InstanceLocation
		if loc == "" {
			loc = "/"
		}
		return []string{fmt.Sprintf("%s: %s", loc, e.Message)}
	}
	var out []string
	for _, c := range e.Causes {
		out = append(out, flatten(c)...)
	}
	return out
}

// sampleEnv has every stat the pack declares, so evaluating an expression
// against it finds references to stats that do not exist.
func sampleEnv(p *Pack) Env {
	cult := map[string]float64{}
	for k := range p.Stats {
		cult[k] = 1
	}
	phase := ""
	if len(p.Phases) > 0 {
		phase = p.Phases[0].ID
	}
	return Env{Cult: cult, Phase: phase, MinutesToReset: 600}
}

func semanticLint(p *Pack, phaseIDs map[string]bool, add func(string, ...any)) {
	env := sampleEnv(p)
	chk := func(where string, e *Expr) {
		if err := e.check(env); err != nil {
			add("%s: %v (does every stat it reads exist?)", where, err)
		}
	}
	effects := func(where string, es []Effect) {
		for _, e := range es {
			if _, ok := p.Stats[e.Stat]; !ok {
				add("%s: effect on unknown stat %q", where, e.Stat)
			}
			chk(where, e.Value)
		}
	}
	chk("goal", p.Progress)
	chk("guard", p.Guard)
	for _, id := range p.Order {
		a := p.Actions[id]
		chk("action "+id+" requires", a.Requires)
		effects("action "+id, a.Effects)
		if a.Buff != nil {
			if _, ok := p.Actions[a.Buff.Target]; !ok {
				add("action %s: buff targets unknown action %q", id, a.Buff.Target)
			}
		}
		for ph := range a.Phases {
			if !phaseIDs[ph] {
				add("action %s: unknown phase %q", id, ph)
			}
		}
		if !a.Shared {
			needKey(p, "action."+id, add)
			needKey(p, "action."+id+".desc", add)
		}
	}
	effects("tick", p.Tick)
	for key := range p.Manifest.Animations {
		_, action := p.Actions[key]
		ritual := strings.HasPrefix(key, "ritual.") && protocol.Rituals[strings.TrimPrefix(key, "ritual.")]
		if !action && !ritual && !isDefectorAction(key) {
			add("animations: %q is not an action of this pack or a ritual", key)
		}
	}
	for _, f := range p.Falls {
		chk("fall "+f.Reason, f.When)
		if !strings.HasPrefix(f.Text, "core.") {
			needKey(p, f.Text, add)
		}
	}
	for _, ph := range p.Phases {
		chk("phase "+ph.ID, ph.Progress)
		chk("phase "+ph.ID+" guard", ph.Guard)
		if ph.Next != "" && !phaseIDs[ph.Next] {
			add("phase %s: next phase %q does not exist", ph.ID, ph.Next)
		}
	}
	for _, ev := range p.Events {
		chk("event "+ev.ID, ev.After)
		chk("event "+ev.ID, ev.Check)
		effects("event "+ev.ID+" pass", ev.Pass)
		effects("event "+ev.ID+" fail", ev.Fail)
		if ev.Text != "" {
			needKey(p, ev.Text, add)
		}
	}
	for k, s := range p.Manifest.Stats {
		needKey(p, s.Label, add)
		_ = k
	}
	needKey(p, p.Manifest.Goal.Label, add)
	for _, k := range []string{"name", "tagline", "leader", "era", "summary"} {
		needKey(p, k, add)
	}
}

func needKey(p *Pack, key string, add func(string, ...any)) {
	if _, ok := p.Strings[key]; !ok {
		add("strings/en.json is missing key %q", key)
	}
}

// harmVerbs: a playable action may never harm anyone. The list is matched
// against action ids and action strings.
var harmVerbs = regexp.MustCompile(`(?i)\b(poison\w*|shoot\w*|shot|kill\w*|murder\w*|abus\w*|assault\w*|rape\w*|stab\w*|bomb\w*|attack\w*|tortur\w*|kidnap\w*|beat(ing)?|suicide|massacre\w*|gas(sing)?|arson|burn(ing)?\s+down|execut\w*|sarin|cyanide)\b`)

// historicalReasons are fall reasons that name a real tragedy; such falls
// must be marked historical with their real outcome stated in the codex.
func careLint(p *Pack, add func(string, ...any)) {
	for _, id := range p.Order {
		if p.Actions[id].Shared {
			continue
		}
		if harmVerbs.MatchString(strings.ReplaceAll(id, "_", " ")) {
			add("care: action id %q uses a harm verb", id)
		}
		for _, k := range []string{"action." + id, "action." + id + ".desc"} {
			if harmVerbs.MatchString(p.Strings[k]) {
				add("care: string %q describes harm: %q", k, p.Strings[k])
			}
		}
	}
	for _, f := range p.Manifest.Falls {
		if f.Historical {
			txt := p.Strings[f.Text]
			if !regexp.MustCompile(`\b(1[89]|20)\d\d\b`).MatchString(txt) {
				add("care: historical fall %q must state the real date in %q", f.Reason, f.Text)
			}
		}
	}
	// Goals and guards may not reward a historical ending: a goal or guard
	// may not read a condition used only by a historical fall.
	for _, f := range p.Manifest.Falls {
		if f.Historical && (strings.Contains(p.Manifest.Goal.Progress, f.When) || strings.Contains(p.Manifest.Guard, f.When)) {
			add("care: goal or guard rewards historical ending %q", f.Reason)
		}
	}
}

// HashDir hashes every file under dir: sha256 over "path\0bytes\0" for each
// file in sorted path order, first 12 hex chars. The web build computes the
// same hash so asset URLs match.
// MaxEmblemBytes keeps emblems simple: a symbol, not an illustration.
const MaxEmblemBytes = 16 << 10

var emblemBad = regexp.MustCompile(`(?i)<script|<foreignObject|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?:[a-z]+:|//)|url\(\s*["']?(?:[a-z]+:|//)|@import`)

// checkEmblem returns why an emblem is unusable, or "" if it is fine.
func checkEmblem(b []byte) string {
	if len(b) > MaxEmblemBytes {
		return fmt.Sprintf("%d bytes, over the %d byte limit", len(b), MaxEmblemBytes)
	}
	s := strings.TrimSpace(string(b))
	if !strings.HasPrefix(s, "<svg") || !strings.HasSuffix(s, "</svg>") {
		return "must be a single <svg> element"
	}
	if !strings.Contains(s, "viewBox=") {
		return "needs a viewBox so it scales"
	}
	if m := emblemBad.FindString(s); m != "" {
		return fmt.Sprintf("no scripts, handlers or outside references (found %q)", m)
	}
	return ""
}

func HashDir(dir string) (string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f)))
		if err != nil {
			return "", err
		}
		h.Write([]byte(f))
		h.Write([]byte{0})
		h.Write(b)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:12], nil
}

// ---- roster ----

type Roster struct {
	Cults []string `json:"cults"`
}

// Content is everything one Day runs on, frozen at its start.
type Content struct {
	Roster  []string
	Packs   map[string]*Pack
	Hash    string
	Dropped map[string]error
}

// LoadRoster reads content/roster.json and loads each listed pack from
// content/cults. A pack that fails validation is dropped (and reported) so
// the other cults still open.
func LoadRoster(contentDir string) (*Content, error) {
	l, err := NewLoader(contentDir)
	if err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}
	b, err := os.ReadFile(filepath.Join(contentDir, "roster.json"))
	if err != nil {
		return nil, err
	}
	var r Roster
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("roster.json: %w", err)
	}
	c := &Content{Packs: map[string]*Pack{}, Dropped: map[string]error{}}
	h := sha256.New()
	for _, id := range r.Cults {
		p, err := l.LoadPack(filepath.Join(contentDir, "cults", id))
		if err != nil {
			c.Dropped[id] = err
			continue
		}
		c.Roster = append(c.Roster, id)
		c.Packs[id] = p
		fmt.Fprintf(h, "%s@%s:%s\n", id, p.Manifest.Version, p.Hash)
	}
	c.Hash = hex.EncodeToString(h.Sum(nil))[:12]
	if len(c.Roster) == 0 {
		return c, errors.New("no cult in the roster passed validation")
	}
	return c, nil
}
