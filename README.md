# Cult Simulator

One shared world a day. Everyone picks a cult, spends energy on actions that move its shared stats, and the first cult to reach its goal with its guard holding ends the Day for everyone. A templated summary follows, and a fresh world opens at the reset.

Every cult is a real historical group. Their tragic endings are **loss states, never rewards**, and no playable action harms anyone. See [Content care](#content-care).

Launch roster: **The Source Family** (tutorial), **Synanon** (easy), **Rajneeshpuram** (medium).

## Layout

```
apps/web/            React + PixiJS PWA (Vite, Zustand, nakama-js, MessagePack)
server/              Nakama Go plugin
  content/           loads, validates and compiles cult packs (no Nakama deps)
  engine/            pure game rules: actions, ticks, wins, falls (no Nakama deps)
  summary/           templated Day summary (no Nakama deps)
  world/             the singleton world match: the only writer of scores
  compound/          50-player room matches: presence, energy, convergence
  rpc/               hello, get_day, join_cult, switch_cult, defect, join_room,
                     get_summary, list_archive, get_pack
  sim/, cmd/sim/     headless bot simulator for the balance run
  cmd/packcheck/     schema + semantic + care lint for every pack
content/
  schema/v1.json     JSON Schema for pack manifests (schema 1.x)
  cults/<id>/        live packs: manifest.json, strings/en.json, codex/en.md, compound.json
  fixtures/          update-2 packs, validated in CI but not live
  roster.json        which cults are live, in lobby order
deploy/              Dockerfile, docker-compose.yml, nakama.yml, .env.example
scripts/             dev server, e2e bots, pack build, cult-id lint
```

No core file names a cult. A Go test (`server/lint_test.go`) and `npm run lint:cult-ids` fail the build on any literal cult id in code.

## Run it locally

Requirements: Go 1.27, Node 22, Docker.

```sh
# 1. Server: builds the plugin with Heroic Labs' plugin builder and starts
#    Nakama 3.41 + Postgres. DAY_SECONDS=900 makes 15-minute Days for testing.
DAY_SECONDS=900 scripts/dev-server.sh

# 2. Client
npm install
npm run dev            # http://localhost:5173, talks to Nakama on :7350

# 3. Bots: 6 players log in, pick cults, walk, act, defect.
#    WAIT_RESET=1 also waits for the Day to end and checks the summary and reset.
npm run e2e
```

## Checks

```sh
cd server
go test ./...                                  # engine, content, cult-id lint
go run ./cmd/packcheck -content ../content     # schema, semantic and care lint per pack
go run ./cmd/sim -content ../content -days 50  # balance: median finish 14-22 h, fall rate <= 60%
```

CI (`.github/workflows/ci.yml`) runs all of these, builds the Nakama image, and builds the web app.

Current balance with 25 bots per cult (50 Days each): The Source Family 18.9 h, Synanon 20.2 h, Rajneeshpuram 18.5 h, 0% falls. The bots are fairly careful; real players will fall more often.

## Adding a cult

1. Add `content/cults/<id>/` (or move it from `content/fixtures/`).
2. Run `packcheck` and `sim`; open a pull request.
3. Add the id to `content/roster.json`. The next reset loads it.

No client release, no plugin rebuild, no Nakama restart. Content only changes at the Day boundary.

A pack can declare extra stats, a goal expression, a guard, signature actions with costs, cooldowns, `requires` conditions and timed buffs, per-minute tick rules, extra falls, phases and scheduled events. Expressions are [CEL](https://github.com/google/cel-go), compiled once at load with a cost limit, and can read only `cult.*`, `phase` and `world.minutesToReset`. Integer literals are treated as doubles, and `min`, `max` and `clamp` are available.

## Deploying on your own server

1. `cp deploy/.env.example deploy/.env` and set every secret.
2. `docker compose -f deploy/docker-compose.yml up -d --build`. Only `127.0.0.1:7350` is published; the console port 7351 never is.
3. Create a Cloudflare Tunnel that routes `play.<your domain>` to `http://nakama:7350`, put its token in `.env`, and start it with `docker compose --profile tunnel up -d`.
4. Build the client with `VITE_NAKAMA_HOST=play.<your domain> VITE_NAKAMA_SSL=true VITE_NAKAMA_KEY=<server key> npm run build` and publish `apps/web/dist` to Cloudflare Pages. Set `ASSET_BASE=https://<pages domain>/packs` so clients load packs from the CDN; without it they use the `get_pack` RPC.
5. Back up Postgres nightly (`pg_dump`) to another machine.

## Protocol

Match payloads are MessagePack; RPC payloads are JSON. Opcode numbers are fixed forever and only appended (`server/protocol/protocol.go`). Clients send only ids and tap targets, never amounts or stats.

| Op | Direction | Payload |
|---|---|---|
| 1 MOVE | client | `{x, y}` |
| 2 KNEEL / 3 RISE | client | `{mat}` / `{}` |
| 4 RITUAL | client | `{ritual}` (bow, chant, beads, candle) |
| 10 ACT / 11 DEFECT_ACT | client | `{actionId, clientSeq}` |
| 12 HEARTBEAT | client | `{}` every 30 s |
| 20 SNAPSHOT | server | room presence, mats, your energy and cooldowns |
| 21 JOINED / 22 LEFT | server | player |
| 23 WALK / 24 POSE | server | `{id, fx, fy, tx, ty, t0}` / `{id, pose, mat}` |
| 25 RITUAL_SEEN / 26 CONVERGENCE | server | `{id, ritual}` / `{key, players}` |
| 30 ACT_RESULT | server | `{clientSeq, ok, reason, energy, deltas, cooldowns}` |
| 31 WORLD | server | world snapshot, once a second |
| 33 DAY_ENDED | server | `{dayId, reason, winner, reset}` |
| 40 CORRECTION | server | your true position and pose |

## Content care

- A historical ending can only be a fall condition (`historical: true`), with the real date, place and outcome stated plainly in the pack's strings. The care lint enforces the date and rejects harm verbs in action ids and strings.
- Defecting is always a way to win.
- The codex texts were written from memory and **must be fact-checked against sources before release**.
- Every historical end card links to the International Cultic Studies Association.
