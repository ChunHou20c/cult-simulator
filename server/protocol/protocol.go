// Package protocol holds the wire constants shared by every match. Opcode
// numbers are fixed forever; new ones are only appended.
package protocol

// Version is the protocol major. It changes only when the wire format does;
// cults never touch it.
const Version = 1

// MinClient is the oldest client build the server accepts.
const MinClient = "1.0.0"

// Client to server.
const (
	OpMove      = 1
	OpKneel     = 2
	OpRise      = 3
	OpRitual    = 4
	OpAct       = 10
	OpDefectAct = 11
	OpHeartbeat = 12
)

// Server to client.
const (
	OpSnapshot    = 20
	OpJoined      = 21
	OpLeft        = 22
	OpWalk        = 23
	OpPose        = 24
	OpRitualSeen  = 25
	OpConvergence = 26
	OpActResult   = 30
	OpWorld       = 31
	OpEvent       = 32
	OpDayEnded    = 33
	OpCorrection  = 40
)

// Rituals are wordless gestures any player can make in a compound.
var Rituals = map[string]bool{"bow": true, "chant": true, "beads": true, "candle": true}

// RoomSize caps players per compound room.
const RoomSize = 50
