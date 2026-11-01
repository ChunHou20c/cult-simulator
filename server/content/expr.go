package content

import (
	"fmt"
	"math"
	"strings"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"
)

// Expression costs are capped so a pack can never stall the world loop.
const exprCostLimit = 2000

// Env is what an expression may read. Nothing else is visible to a pack.
type Env struct {
	Cult           map[string]float64
	Phase          string
	MinutesToReset float64
}

func (e Env) vars() map[string]any {
	return map[string]any{
		"cult":  e.Cult,
		"phase": e.Phase,
		"world": map[string]float64{"minutesToReset": e.MinutesToReset},
	}
}

var celEnv *cel.Env

func init() {
	var err error
	celEnv, err = cel.NewEnv(
		cel.Variable("cult", cel.MapType(cel.StringType, cel.DoubleType)),
		cel.Variable("phase", cel.StringType),
		cel.Variable("world", cel.MapType(cel.StringType, cel.DoubleType)),
		cel.CrossTypeNumericComparisons(true),
		binaryDouble("min", math.Min),
		binaryDouble("max", math.Max),
		cel.Function("clamp", cel.Overload("clamp_double_double_double",
			[]*cel.Type{cel.DoubleType, cel.DoubleType, cel.DoubleType}, cel.DoubleType,
			cel.FunctionBinding(func(args ...ref.Val) ref.Val {
				v, lo, hi := float64(args[0].(types.Double)), float64(args[1].(types.Double)), float64(args[2].(types.Double))
				return types.Double(math.Max(lo, math.Min(hi, v)))
			}))),
	)
	if err != nil {
		panic(err)
	}
}

// Expr is a compiled pack expression. A constant number is also an Expr, so
// effects can say either `"add": 5` or `"add": "cult.followers * 0.1"`.
type Expr struct {
	Src     string
	isConst bool
	konst   float64
	prog    cel.Program
	isBool  bool
}

func ConstExpr(v float64) *Expr { return &Expr{isConst: true, konst: v, Src: fmt.Sprint(v)} }

// floatLiterals rewrites integer literals to doubles ("140" -> "140.0"), so
// pack authors can write cult.followers / 140 without CEL's int/double
// type error. Strings are left untouched.
func binaryDouble(name string, f func(a, b float64) float64) cel.EnvOption {
	return cel.Function(name, cel.Overload(name+"_double_double",
		[]*cel.Type{cel.DoubleType, cel.DoubleType}, cel.DoubleType,
		cel.BinaryBinding(func(a, b ref.Val) ref.Val {
			return types.Double(f(float64(a.(types.Double)), float64(b.(types.Double))))
		})))
}

func floatLiterals(src string) string {
	var b strings.Builder
	inStr := byte(0)
	isIdent := func(c byte) bool {
		return c == '_' || c == '.' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
	}
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inStr != 0 {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(src) {
				i++
				b.WriteByte(src[i])
			} else if c == inStr {
				inStr = 0
			}
			continue
		}
		if c == '"' || c == '\'' {
			inStr = c
			b.WriteByte(c)
			continue
		}
		if c >= '0' && c <= '9' && (i == 0 || !isIdent(src[i-1])) {
			j := i
			for j < len(src) && src[j] >= '0' && src[j] <= '9' {
				j++
			}
			b.WriteString(src[i:j])
			if j >= len(src) || !(src[j] == '.' || src[j] == 'e' || src[j] == 'E' || src[j] == 'u' || isIdent(src[j])) {
				b.WriteString(".0")
			}
			i = j - 1
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

func compile(src string, wantBool bool) (*Expr, error) {
	ast, iss := celEnv.Compile(floatLiterals(src))
	if iss != nil && iss.Err() != nil {
		return nil, fmt.Errorf("expression %q: %v", src, iss.Err())
	}
	want := cel.DoubleType
	if wantBool {
		want = cel.BoolType
	}
	if !ast.OutputType().IsExactType(want) {
		return nil, fmt.Errorf("expression %q: must return %s, returns %s", src, want, ast.OutputType())
	}
	prog, err := celEnv.Program(ast, cel.CostLimit(exprCostLimit))
	if err != nil {
		return nil, fmt.Errorf("expression %q: %v", src, err)
	}
	return &Expr{Src: src, prog: prog, isBool: wantBool}, nil
}

func eval(p cel.Program, env Env) (ref.Val, error) {
	out, _, err := p.Eval(env.vars())
	return out, err
}

// Num evaluates a numeric expression. Errors (for example a stat missing at
// runtime) count as 0 so a bad pack can never crash the world; the semantic
// lint catches them before a pack ships.
func (e *Expr) Num(env Env) float64 {
	if e == nil {
		return 0
	}
	if e.isConst {
		return e.konst
	}
	v, err := eval(e.prog, env)
	if err != nil {
		return 0
	}
	if d, ok := v.(types.Double); ok {
		return float64(d)
	}
	return 0
}

// Bool evaluates a condition. A nil condition is true; errors are false.
func (e *Expr) Bool(env Env) bool {
	if e == nil {
		return true
	}
	v, err := eval(e.prog, env)
	if err != nil {
		return false
	}
	b, ok := v.(types.Bool)
	return ok && bool(b)
}

// check evaluates against a sample env and reports runtime errors such as a
// stat that does not exist.
func (e *Expr) check(env Env) error {
	if e == nil || e.isConst {
		return nil
	}
	if _, err := eval(e.prog, env); err != nil {
		return fmt.Errorf("expression %q: %v", e.Src, err)
	}
	return nil
}
