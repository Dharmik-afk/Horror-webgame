package fileserver

import (
	"log"
	"os"
)

// Logger is the package-level logger for file server events.
// It defaults to standard output with no prefix.
var Logger = log.New(os.Stdout, "", 0)

// ErrorLogger is the package-level logger for file server errors.
var ErrorLogger = log.New(os.Stderr, "", 0)
