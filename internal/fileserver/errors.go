package fileserver

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// ── Error type ────────────────────────────────────────────────────

type httpError struct {
	statusCode int
	message    string
	allowed    []string
}

func (e *httpError) Error() string { return e.message }

// ── Error constructors ────────────────────────────────────────────

func errNotFound(resource string) *httpError {
	return &httpError{404, resource + " not found", nil}
}
func errForbidden() *httpError {
	return &httpError{403, "Forbidden", nil}
}
func errBadRequest(msg string) *httpError {
	if msg == "" {
		msg = "Bad Request"
	}
	return &httpError{400, msg, nil}
}
func errMethodNotAllowed() *httpError {
	return &httpError{405, "Method Not Allowed", []string{"GET", "HEAD"}}
}
func errInternalError(msg string) *httpError {
	if msg == "" {
		msg = "Internal Server Error"
	}
	return &httpError{500, msg, nil}
}
func errRangeNotSatisfiable() *httpError {
	return &httpError{416, "Range Not Satisfiable", nil}
}
func errURITooLong() *httpError {
	return &httpError{414, "URI Too Long", nil}
}

// ── FS error mapping ─────────────────────────────────────────────

func mapFSError(err error, filePath string) *httpError {
	if err == nil {
		return nil
	}
	if os.IsNotExist(err) {
		return errNotFound("File")
	}
	if os.IsPermission(err) {
		return errForbidden()
	}
	if strings.Contains(err.Error(), "name too long") {
		return errURITooLong()
	}
	fmt.Fprintf(os.Stderr, "FS Error for %s: %v\n", filePath, err)
	return errInternalError("")
}

// ── Error response ────────────────────────────────────────────────

// sendError writes an HTML error page.
// Error responses are never cached — no-store prevents proxies and browsers
// from serving a stale error page on retry.
func sendError(c *gin.Context, he *httpError) {
	status := 500
	message := "Internal Server Error"
	if he != nil {
		status = he.statusCode
		message = he.message
		if status == 405 && len(he.allowed) > 0 {
			c.Header("Allow", strings.Join(he.allowed, ", "))
		}
	}

	c.Header("Cache-Control", "no-store")
	body := fmt.Sprintf(`<!DOCTYPE html>
<html>
<head><title>%d - %s</title></head>
<body>
<h1>%d</h1>
<p>%s</p>
</body>
</html>`, status, message, status, message)

	c.Header("Content-Type", "text/html; charset=utf-8")
	c.Header("Content-Length", strconv.Itoa(len([]byte(body))))
	c.String(status, "%s", body)
}
