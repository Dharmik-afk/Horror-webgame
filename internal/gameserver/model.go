// Package gameserver implements the WebSocket game server (port 9000).
// Wire protocol and message types for client-server communication.
package gameserver

import (
	"crypto/rand"
	"encoding/hex"
)

// ── ID generator ──────────────────────────────────────────────────

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ── Wire types ────────────────────────────────────────────────────

// PlayerState holds the authoritative position of one connected player.
type PlayerState struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Angle float64 `json:"angle"`
	Vx    float64 `json:"vx"`
	Vy    float64 `json:"vy"`
}

type initMsg struct {
	Type    string                 `json:"type"`
	ID      string                 `json:"id"`
	Players map[string]PlayerState `json:"players"`
}

type playerEntry struct {
	ID    string  `json:"id"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Angle float64 `json:"angle"`
	Vx    float64 `json:"vx"`
	Vy    float64 `json:"vy"`
}

type stateMsg struct {
	Type    string        `json:"type"`
	Players []playerEntry `json:"players"`
	NPCs    []struct{}    `json:"npcs"` // always empty — Phase 2 placeholder
}

type leaveMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type moveMsg struct {
	Type  string  `json:"type"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Angle float64 `json:"angle"`
	Vx    float64 `json:"vx"`
	Vy    float64 `json:"vy"`
}
