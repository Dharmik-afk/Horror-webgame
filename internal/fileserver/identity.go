package fileserver

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
)

const (
	playerIDCookie = "player_id"
	playerIDBytes  = 8 // 8 bytes → 16 hex chars, matches gameserver.newID format
	cookieMaxAge   = 86400 // 24 hours
)

// newPlayerID generates a cryptographically random 16-hex-char player ID.
func newPlayerID() string {
	b := make([]byte, playerIDBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// IdentityMiddleware returns a Gin middleware that ensures every request
// carries a persistent player_id cookie.
//
// On first visit the middleware generates a new random ID and sets it as a
// cookie.  Subsequent requests reuse the existing cookie value.
//
// The cookie is scoped to Path=/ so it is sent to both the file server
// (:8000) and the game server (:9000) on the same hostname — browsers
// scope cookies by domain, not port.
func IdentityMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := c.Cookie(playerIDCookie)
		if err != nil || id == "" {
			id = newPlayerID()
			c.SetSameSite(http.SameSiteLaxMode)
			c.SetCookie(
				playerIDCookie,
				id,
				cookieMaxAge,
				"/",      // Path — sent to all routes on this host
				"",       // Domain — defaults to the request host
				false,    // Secure — false for local dev (HTTP)
				false,    // HttpOnly — false so DevTools can inspect/clear it
			)
		}

		// Store in context for downstream handlers / logging.
		c.Set("player_id", id)
		c.Next()
	}
}
