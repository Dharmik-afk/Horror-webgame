package fileserver

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// ── Path resolution ───────────────────────────────────────────────

var controlCharsRe = regexp.MustCompile(`[\x00-\x1f]`)

func safeResolve(publicDir, requestPath string) string {
	if controlCharsRe.MatchString(requestPath) {
		return ""
	}
	resolved := filepath.Clean(filepath.Join(publicDir, requestPath))
	if !strings.HasPrefix(resolved, publicDir) {
		return ""
	}
	return resolved
}

func parseRequestPath(rawURL string) (string, *httpError) {
	if len(rawURL) > maxURLLen {
		return "", errURITooLong()
	}
	if idx := strings.Index(rawURL, "?"); idx >= 0 {
		rawURL = rawURL[:idx]
	}
	decoded, err := url.PathUnescape(rawURL)
	if err != nil {
		return "", errBadRequest("Malformed URL encoding")
	}
	return decoded, nil
}

// ── Range request parsing ─────────────────────────────────────────

type rangeResult struct {
	start, end int64
	invalid    bool
}

func parseRange(header string, fileSize int64) *rangeResult {
	if header == "" || !strings.HasPrefix(header, "bytes=") {
		return nil
	}
	spec := strings.TrimPrefix(header, "bytes=")
	parts := strings.SplitN(spec, "-", 2)
	if len(parts) != 2 {
		return nil
	}
	startStr, endStr := parts[0], parts[1]

	var start, end int64

	switch {
	case startStr == "" && endStr != "":
		n, err := strconv.ParseInt(endStr, 10, 64)
		if err != nil {
			return nil
		}
		start = max64(0, fileSize-n)
		end = fileSize - 1
	case startStr != "" && endStr == "":
		n, err := strconv.ParseInt(startStr, 10, 64)
		if err != nil {
			return nil
		}
		start = n
		end = fileSize - 1
	default:
		s, err1 := strconv.ParseInt(startStr, 10, 64)
		e, err2 := strconv.ParseInt(endStr, 10, 64)
		if err1 != nil || err2 != nil {
			return nil
		}
		start, end = s, e
	}

	if start > end || start >= fileSize || end >= fileSize {
		return &rangeResult{invalid: true}
	}
	return &rangeResult{start: start, end: end}
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ── Cache headers ─────────────────────────────────────────────────

// isHTML reports whether the file extension is .html.
func isHTML(ext string) bool {
	return ext == ".html"
}

// setCacheHeaders writes the appropriate Cache-Control header for the file.
//
// HTML (index.html):
//
//	no-cache, must-revalidate
//	The browser keeps a local copy but sends a conditional request on every
//	navigation. The server replies 304 if unchanged, 200 with fresh content
//	if modified.
//
// All other assets (JS, CSS, images, fonts, JSON):
//
//	public, max-age=0, must-revalidate
//	Effectively the same revalidation behaviour as no-cache but explicitly
//	permits shared caches (CDN, proxy) to store the response.
func setCacheHeaders(c *gin.Context, ext string) {
	if isHTML(ext) {
		c.Header("Cache-Control", "no-cache, must-revalidate")
	} else {
		c.Header("Cache-Control", "public, max-age=0, must-revalidate")
	}
}

// ── File serving ──────────────────────────────────────────────────

func serveFileContents(c *gin.Context, filePath string, info os.FileInfo) {
	ext := strings.ToLower(filepath.Ext(filePath))
	contentType, ok := mimeTypes[ext]
	if !ok {
		contentType = "application/octet-stream"
	}

	modTime := info.ModTime().UTC()
	lastModified := modTime.Format(http.TimeFormat)

	c.Header("Content-Type", contentType)
	c.Header("Accept-Ranges", "bytes")
	c.Header("Last-Modified", lastModified)
	setCacheHeaders(c, ext)

	// ── Conditional GET: If-Modified-Since ───────────────────────
	if ims := c.GetHeader("If-Modified-Since"); ims != "" {
		if t, err := http.ParseTime(ims); err == nil {
			if !modTime.Truncate(time.Second).After(t) {
				c.Status(http.StatusNotModified)
				return
			}
		}
	}

	fileSize := info.Size()

	// HEAD: headers only, no body.
	if c.Request.Method == http.MethodHead {
		c.Header("Content-Length", strconv.FormatInt(fileSize, 10))
		c.Status(http.StatusOK)
		return
	}

	// Range request check (must happen before opening the file).
	r := parseRange(c.GetHeader("Range"), fileSize)
	if r != nil && r.invalid {
		c.Header("Content-Range", fmt.Sprintf("bytes */%d", fileSize))
		sendError(c, errRangeNotSatisfiable())
		return
	}

	f, err := os.Open(filePath)
	if err != nil {
		sendError(c, mapFSError(err, filePath))
		return
	}
	defer f.Close()

	if r != nil {
		chunkSize := r.end - r.start + 1
		c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", r.start, r.end, fileSize))
		c.Header("Content-Length", strconv.FormatInt(chunkSize, 10))
		c.Status(http.StatusPartialContent)
		if _, err = f.Seek(r.start, io.SeekStart); err != nil {
			ErrorLogger.Printf("Seek error for %s: %v\n", filePath, err)
			return
		}
		if _, err = io.CopyN(c.Writer, f, chunkSize); err != nil && err != io.EOF {
			ErrorLogger.Printf("Stream error for %s: %v\n", filePath, err)
		}
		return
	}

	c.Header("Content-Length", strconv.FormatInt(fileSize, 10))
	c.Status(http.StatusOK)
	if _, err = io.Copy(c.Writer, f); err != nil {
		ErrorLogger.Printf("Stream error for %s: %v\n", filePath, err)
	}
}

func serveFile(c *gin.Context, filePath string) {
	info, err := os.Stat(filePath)
	if err != nil {
		sendError(c, mapFSError(err, filePath))
		return
	}

	if info.IsDir() {
		indexPath := filepath.Join(filePath, "index.html")
		indexInfo, err := os.Stat(indexPath)
		if err != nil || !indexInfo.Mode().IsRegular() {
			sendError(c, errNotFound("Directory index"))
			return
		}
		serveFileContents(c, indexPath, indexInfo)
		return
	}

	if !info.Mode().IsRegular() {
		sendError(c, errBadRequest("Not a regular file"))
		return
	}

	serveFileContents(c, filePath, info)
}

// FileHandler returns the Gin handler that processes all GET/HEAD requests.
func FileHandler(publicDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		method := c.Request.Method
		if method != http.MethodGet && method != http.MethodHead {
			sendError(c, errMethodNotAllowed())
			return
		}

		requestPath, he := parseRequestPath(c.Request.URL.RequestURI())
		if he != nil {
			sendError(c, he)
			return
		}

		if requestPath == "/" {
			requestPath = "/index.html"
		}

		fullPath := safeResolve(publicDir, requestPath)
		if fullPath == "" {
			sendError(c, errForbidden())
			return
		}

		serveFile(c, fullPath)
	}
}
