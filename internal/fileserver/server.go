// Package fileserver implements the static-file HTTP server (port 8000).
// Entry point: Run(args []string) — called from the root dispatcher.
package fileserver

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// ── Network helpers ───────────────────────────────────────────────

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not determine LAN IP, falling back to 127.0.0.1: %v\n", err)
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

// ── Entry point ───────────────────────────────────────────────────

// Run is called by the root dispatcher with os.Args[2:].
func Run(args []string) {
	cli := parseArgs(args)

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to get working directory:", err)
		os.Exit(1)
	}

	publicDir := filepath.Join(cwd, "public")
	if cli.publicDir != "" {
		publicDir = filepath.Join(cwd, cli.publicDir)
	}

	results := performStartupCheckup(publicDir)
	allPassed := printCheckupSummary(results)

	if !allPassed {
		if cli.force {
			fmt.Println("⚠️  Errors detected but --force flag provided. Starting server anyway...")
			fmt.Println("")
		} else {
			fmt.Fprintln(os.Stderr, "🛑 Server not started due to checkup failures.")
			fmt.Fprintln(os.Stderr, "   Use --force or -f to start anyway.")
			fmt.Fprintln(os.Stderr, "")
			os.Exit(1)
		}
	} else {
		fmt.Println("✅ All checks passed. Starting server...")
		fmt.Println("")
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()

	r.Use(LoggingMiddleware())
	r.Use(IdentityMiddleware())

	handler := FileHandler(publicDir)

	r.GET("/*filepath", handler)
	r.HEAD("/*filepath", handler)
	r.NoRoute(handler)

	addr := fmt.Sprintf("%s:%d", host, defaultPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-quit
		fmt.Printf("\nReceived %s. Shutting down gracefully...\n", sig)

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := srv.Shutdown(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "Forcing shutdown after timeout.")
			os.Exit(1)
		}
		fmt.Println("Server closed.")
		os.Exit(0)
	}()

	ip := getLocalIP()
	fmt.Printf("Serving locally: http://localhost:%d/\n", defaultPort)
	fmt.Printf("Serving on LAN:  http://%s:%d/\n", ip, defaultPort)
	fmt.Printf("Web root: %s\n", publicDir)
	if cli.force {
		fmt.Println("⚠️  Server started with --force flag (errors ignored)")
	}

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		switch {
		case strings.Contains(err.Error(), "address already in use"):
			fmt.Fprintf(os.Stderr, "Port %d is already in use.\n", defaultPort)
		case strings.Contains(err.Error(), "permission denied"):
			fmt.Fprintf(os.Stderr, "Permission denied to bind to port %d.\n", defaultPort)
		default:
			fmt.Fprintln(os.Stderr, "Server error:", err)
		}
		os.Exit(1)
	}
}
