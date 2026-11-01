// Command server is the Nakama Go plugin (build with -buildmode=plugin).
package main

import (
	"context"
	"database/sql"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"

	"github.com/cult-simulator/server/compound"
	"github.com/cult-simulator/server/content"
	"github.com/cult-simulator/server/rpc"
	"github.com/cult-simulator/server/world"
)

// InitModule is Nakama's entry point for Go plugins.
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	env, _ := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	set := world.SettingsFrom(env)
	// Fail fast on broken content so a bad deploy is visible at start.
	c, err := content.LoadRoster(set.ContentDir)
	if err != nil {
		logger.Error("content: %v", err)
	} else {
		logger.Info("content: roster %v, content hash %s", c.Roster, c.Hash)
		for id, e := range c.Dropped {
			logger.Error("content: ALERT pack %s dropped: %v", id, e)
		}
	}
	if err := initializer.RegisterMatch(world.ModuleName, world.New); err != nil {
		return err
	}
	if err := initializer.RegisterMatch(compound.ModuleName, compound.New); err != nil {
		return err
	}
	if err := rpc.Register(initializer); err != nil {
		return err
	}
	// Match creation may not be allowed during init; start the world right
	// after, and every RPC also ensures it exists.
	go func() {
		for i := 0; i < 30; i++ {
			time.Sleep(time.Second)
			if id, err := world.Ensure(context.Background(), nk); err == nil {
				logger.Info("world match %s", id)
				return
			}
		}
	}()
	logger.Info("cult simulator plugin loaded")
	return nil
}

// main is unused: Nakama loads this package as a plugin.
func main() {}
