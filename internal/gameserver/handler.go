package gameserver

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

// ── WebSocket upgrader ────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // open for local dev
}

// ── Per-client writer goroutine ───────────────────────────────────

func writerLoop(c *wsClient) {
	defer c.conn.Close()
	for data := range c.send {
		c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			Logger.Printf("[ws] write error for %s: %v\n", c.id, err)
			return
		}
	}
}

// ── Per-client reader goroutine ───────────────────────────────────

func readerLoop(c *wsClient, reg *Registry) {
	defer func() {
		close(c.send)
		reg.remove(c.id)
		Logger.Printf("[disconnect] id=%-16s  total=%d\n", c.id, reg.count())
		reg.broadcast(leaveMsg{Type: "leave", ID: c.id})
	}()

	c.conn.SetReadLimit(512)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseNormalClosure,
			) {
				Logger.Printf("[ws] read error for %s: %v\n", c.id, err)
			}
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		var base wsMessage
		if err := json.Unmarshal(raw, &base); err != nil {
			continue // Ignore malformed JSON
		}

		// Intercept ping messages — reply immediately with a pong.
		if base.Type == "ping" {
			pong := pingPongMsg{Type: "pong", ID: base.ID}
			data, _ := json.Marshal(pong)
			c.send <- data
			continue
		}

		var msg moveMsg
		if err := json.Unmarshal(raw, &msg); err != nil || msg.Type != "move" {
			continue
		}

		state := PlayerState{X: msg.X, Y: msg.Y, Angle: msg.Angle, Vx: msg.Vx, Vy: msg.Vy}
		reg.setState(c.id, state)

		snap := reg.snapshot()
		entries := make([]playerEntry, 0, len(snap))
		for id, s := range snap {
			entries = append(entries, playerEntry{ID: id, X: s.X, Y: s.Y, Angle: s.Angle, Vx: s.Vx, Vy: s.Vy})
		}

		reg.broadcast(stateMsg{
			Type:    "state",
			Players: entries,
			NPCs:    []struct{}{},
		})
	}
}

// ── WebSocket handler ─────────────────────────────────────────────

// WSHandler returns an http.HandlerFunc that upgrades connections to WebSocket.
//
// Identity: reads the player_id cookie set by the file server.  If present
// the cookie value becomes the client's ID, giving persistent identity
// across reconnects.  If absent (e.g. direct WebSocket tool) falls back
// to a random ID.
//
// Duplicate handling: if a client reconnects with a cookie ID that is
// already in the registry (stale connection not yet timed out), the old
// connection's send channel is closed — which terminates its writerLoop
// and eventually its readerLoop — before the new connection is registered.
func WSHandler(reg *Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			ErrorLogger.Printf("[ws] upgrade error: %v\n", err)
			return
		}

		// Resolve player ID from cookie, fall back to random.
		id := ""
		if cookie, err := r.Cookie("player_id"); err == nil && cookie.Value != "" {
			id = cookie.Value
		}
		if id == "" {
			id = newID()
		}

		// If the same ID is already connected (stale session), evict it.
		reg.evict(id)

		c := &wsClient{
			id:   id,
			conn: conn,
			send: make(chan []byte, 64),
		}

		reg.add(c)
		Logger.Printf("[connect]    id=%-16s  (cookie) total=%d\n", c.id, reg.count())

		reg.sendTo(c.id, initMsg{
			Type:    "init",
			ID:      c.id,
			Players: reg.snapshot(),
		})

		go writerLoop(c)
		readerLoop(c, reg)
	}
}
