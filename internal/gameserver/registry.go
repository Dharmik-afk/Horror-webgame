package gameserver

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/gorilla/websocket"
)

// ── Client ────────────────────────────────────────────────────────

type wsClient struct {
	id   string
	conn *websocket.Conn
	send chan []byte
}

// ── Registry ──────────────────────────────────────────────────────

// Registry is the thread-safe store of connected clients and their states.
type Registry struct {
	mu      sync.RWMutex
	clients map[string]*wsClient
	states  map[string]PlayerState
}

// NewRegistry creates an empty Registry ready for use.
func NewRegistry() *Registry {
	return &Registry{
		clients: make(map[string]*wsClient),
		states:  make(map[string]PlayerState),
	}
}

func (r *Registry) add(c *wsClient) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[c.id] = c
	r.states[c.id] = PlayerState{}
}

func (r *Registry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, id)
	delete(r.states, id)
}

// evict closes the send channel of an existing client with the given ID,
// terminating its writerLoop (and eventually readerLoop).  Called before
// re-registering a reconnecting player so the stale connection is cleaned up.
// No-op if the ID is not in the registry.
func (r *Registry) evict(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if old, ok := r.clients[id]; ok {
		close(old.send)
		delete(r.clients, id)
		delete(r.states, id)
		fmt.Printf("[evict]      id=%-16s  (stale connection replaced)\n", id)
	}
}

func (r *Registry) setState(id string, s PlayerState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states[id] = s
}

func (r *Registry) snapshot(excludeID string) map[string]PlayerState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]PlayerState, len(r.states))
	for id, s := range r.states {
		if id != excludeID {
			out[id] = s
		}
	}
	return out
}

func (r *Registry) broadcast(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[registry] marshal error:", err)
		return
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for id, c := range r.clients {
		select {
		case c.send <- data:
		default:
			fmt.Printf("[registry] send buffer full for %s — skipping\n", id)
		}
		fmt.Printf("%v to id=%v\n", msg, id)
	}
}

func (r *Registry) sendTo(id string, msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[registry] marshal error:", err)
		return
	}
	r.mu.RLock()
	c, ok := r.clients[id]
	r.mu.RUnlock()
	if !ok {
		return
	}
	select {
	case c.send <- data:
	default:
		fmt.Printf("[registry] send buffer full for %s — skipping\n", id)
	}
}

func (r *Registry) count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}
