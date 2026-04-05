package fileserver

import (
	"time"

	"github.com/gin-gonic/gin"
)

// LoggingMiddleware returns a Gin middleware that logs each request with
// colour-coded status codes and timing information.
func LoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		rawPath := c.Request.URL.RequestURI()

		c.Next()

		duration := time.Since(start).Milliseconds()
		status := c.Writer.Status()

		const (
			green  = "\033[32m"
			yellow = "\033[33m"
			red    = "\033[31m"
			reset  = "\033[0m"
		)
		var color string
		switch {
		case status < 400:
			color = green
		case status < 500:
			color = yellow
		default:
			color = red
		}

		Logger.Printf("%s - %s %s %s %s%d%s %dms\n",
			c.ClientIP(),
			time.Now().UTC().Format(time.RFC3339),
			c.Request.Method,
			rawPath,
			color, status, reset,
			duration,
		)
	}
}
