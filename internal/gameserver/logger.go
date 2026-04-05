package gameserver

import (
	"log"
	"os"
)

// Logger is the package-level logger for game server events.
// It defaults to standard output with no prefix.
var Logger = log.New(os.Stdout, "", 0)

// ErrorLogger is the package-level logger for game server errors.
// It defaults to standard error with no prefix.
var ErrorLogger = log.New(os.Stderr, "", 0)
