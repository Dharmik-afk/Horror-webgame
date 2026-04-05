package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"server/internal/fileserver"
	"server/internal/gameserver"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	command := os.Args[1]
	args := os.Args[2:]

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	switch command {
	case "serve":
		fileserver.Run(args)
	case "game":
		gameserver.Run(args)
	case "dev", "all":
		runDev(ctx, args)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Error: Unknown command %q\n\n", command)
		printUsage()
		os.Exit(1)
	}
}

func runDev(ctx context.Context, args []string) {
	fmt.Println("🚀 Starting development environment (File Server + Game Server)...")

	// Set prefixes for dev mode
	fileserver.Logger.SetPrefix("[FILE] ")
	fileserver.ErrorLogger.SetPrefix("[FILE-ERR] ")
	gameserver.Logger.SetPrefix("[GAME] ")
	gameserver.ErrorLogger.SetPrefix("[GAME-ERR] ")

	cwd, _ := os.Getwd()
	publicDir := filepath.Join(cwd, "public") // Simplified for dev, could parse args

	var wg sync.WaitGroup
	wg.Add(2)

	// Run File Server
	go func() {
		defer wg.Done()
		if err := fileserver.Serve(ctx, publicDir, false); err != nil {
			fileserver.ErrorLogger.Printf("File server failed: %v\n", err)
		}
	}()

	// Run Game Server
	go func() {
		defer wg.Done()
		if err := gameserver.Serve(ctx); err != nil {
			gameserver.ErrorLogger.Printf("Game server failed: %v\n", err)
		}
	}()

	wg.Wait()
	fmt.Println("All servers stopped.")
}

func printUsage() {
	fmt.Println("Usage: raycaster <command> [args...]")
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("  dev                Start both File and Game servers (recommended)")
	fmt.Println("  serve [dir] [-f]   Start only the static file server (port 8000)")
	fmt.Println("  game               Start only the game/WebSocket server (port 9000)")
	fmt.Println()
	fmt.Println("  help               Show this help message")
}
