package fileserver

import "strings"

// ── Constants ─────────────────────────────────────────────────────

const (
	host        = "0.0.0.0"
	defaultPort = 8000
	maxURLLen   = 2048
)

// ── MIME types ────────────────────────────────────────────────────

var mimeTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript",
	".mjs":   "application/javascript",
	".css":   "text/css",
	".json":  "application/json",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".svg":   "image/svg+xml",
	".ico":   "image/x-icon",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// ── CLI argument parsing ──────────────────────────────────────────

type cliArgs struct {
	publicDir string
	force     bool
}

func parseArgs(args []string) cliArgs {
	result := cliArgs{}
	for _, arg := range args {
		if arg == "-f" || arg == "--force" || arg == "--forced" {
			result.force = true
		} else if !strings.HasPrefix(arg, "-") && result.publicDir == "" {
			result.publicDir = arg
		}
	}
	return result
}
