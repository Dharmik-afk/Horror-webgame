package fileserver

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ── Checkup types ─────────────────────────────────────────────────

type checkupResult struct {
	success    bool
	message    string
	suggestion string
}

// ── Individual checks ─────────────────────────────────────────────

func checkPublicDirectory(publicDir string) checkupResult {
	info, err := os.Stat(publicDir)
	if err != nil {
		if os.IsNotExist(err) {
			return checkupResult{false, "Public directory does not exist: " + publicDir, "Create the directory or specify a valid path"}
		}
		if os.IsPermission(err) {
			return checkupResult{false, "Permission denied to read public directory: " + publicDir, ""}
		}
		return checkupResult{false, "Error checking directory: " + err.Error(), ""}
	}
	if !info.IsDir() {
		return checkupResult{false, "Public path is not a directory: " + publicDir, ""}
	}
	return checkupResult{true, "Public directory accessible: " + publicDir, ""}
}

func checkIndexFile(publicDir string) checkupResult {
	indexPath := filepath.Join(publicDir, "index.html")
	info, err := os.Stat(indexPath)
	if err != nil {
		if os.IsNotExist(err) {
			return checkupResult{false, "index.html not found: " + indexPath, "Create an index.html or the server will return 404 for GET /"}
		}
		if os.IsPermission(err) {
			return checkupResult{false, "Permission denied to read index.html", ""}
		}
		return checkupResult{false, "Error checking index.html: " + err.Error(), ""}
	}
	if !info.Mode().IsRegular() {
		return checkupResult{false, "index.html is not a regular file", ""}
	}
	return checkupResult{true, fmt.Sprintf("index.html found and readable (%d bytes)", info.Size()), ""}
}

func simulateGetRequest(publicDir string) checkupResult {
	fullPath := safeResolve(publicDir, "/index.html")
	if fullPath == "" {
		return checkupResult{false, "Path resolution failed - possible security issue", ""}
	}
	expected := filepath.Join(publicDir, "index.html")
	if fullPath != expected {
		return checkupResult{false, fmt.Sprintf("Path resolution mismatch: expected %s, got %s", expected, fullPath), ""}
	}
	info, err := os.Stat(fullPath)
	if err != nil {
		return checkupResult{false, "Failed to stat file: " + err.Error(), ""}
	}
	if !info.Mode().IsRegular() {
		return checkupResult{false, "Resolved path is not a regular file", ""}
	}
	f, err := os.Open(fullPath)
	if err != nil {
		return checkupResult{false, "Failed to open file: " + err.Error(), ""}
	}
	defer f.Close()
	buf := make([]byte, 1)
	if _, err = f.Read(buf); err != nil && err != io.EOF {
		return checkupResult{false, "Failed to read file: " + err.Error(), ""}
	}
	return checkupResult{true, "GET / simulation successful", ""}
}

func checkMimeType() checkupResult {
	mime, ok := mimeTypes[".html"]
	if !ok || !strings.Contains(mime, "text/html") {
		return checkupResult{false, "MIME type detection broken for .html", ""}
	}
	return checkupResult{true, "MIME type detection working (.html → " + mime + ")", ""}
}

// ── Runner ────────────────────────────────────────────────────────

func performStartupCheckup(publicDir string) []checkupResult {
	Logger.Println("")
	Logger.Println("🔍 Running startup checkup...")
	Logger.Println("")

	type namedCheck struct {
		label string
		fn    func() checkupResult
	}
	checks := []namedCheck{
		{"Checking public directory", func() checkupResult { return checkPublicDirectory(publicDir) }},
		{"Checking index.html", func() checkupResult { return checkIndexFile(publicDir) }},
		{"Simulating GET / request", func() checkupResult { return simulateGetRequest(publicDir) }},
		{"Verifying MIME type detection", func() checkupResult { return checkMimeType() }},
	}

	results := make([]checkupResult, 0, len(checks))
	for i, ch := range checks {
		Logger.Printf("  [%d/%d] %s...\n", i+1, len(checks), ch.label)
		r := ch.fn()
		results = append(results, r)
		if r.success {
			Logger.Println("  ✅ OK")
		} else {
			Logger.Printf("  ❌ FAILED: %s\n", r.message)
		}
		Logger.Println("")
	}
	return results
}

func printCheckupSummary(results []checkupResult) bool {
	Logger.Println("─────────────────────────────────────")
	Logger.Println("📋 STARTUP CHECKUP SUMMARY")
	Logger.Println("─────────────────────────────────────")

	passed, failed := 0, 0
	var failedResults []checkupResult
	for _, r := range results {
		if r.success {
			passed++
		} else {
			failed++
			failedResults = append(failedResults, r)
		}
	}
	Logger.Printf("  Passed: %d\n  Failed: %d\n", passed, failed)

	if failed > 0 {
		Logger.Println("")
		Logger.Println("❌ Errors found:")
		Logger.Println("")
		for i, r := range failedResults {
			Logger.Printf("  %d. %s\n", i+1, r.message)
			if r.suggestion != "" {
				Logger.Printf("     Suggestion: %s\n", r.suggestion)
			}
		}
	}
	Logger.Println("─────────────────────────────────────")
	Logger.Println("")
	return failed == 0
}
