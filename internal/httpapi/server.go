package httpapi

import (
	"crypto/ed25519"
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/jagarkarlo/nostekon/internal/buildinfo"
	"github.com/jagarkarlo/nostekon/internal/labjobs"
	"github.com/jagarkarlo/nostekon/internal/schema"
)

func NewHandler() http.Handler {
	return NewHandlerWithTrustedKeys(nil)
}

func NewHandlerWithTrustedKeys(configuredKeys map[string]ed25519.PublicKey) http.Handler {
	return NewHandlerWithStudio(configuredKeys, nil)
}

func NewHandlerWithStudio(configuredKeys map[string]ed25519.PublicKey, studio fs.FS) http.Handler {
	return NewHandlerWithLab(configuredKeys, studio, nil)
}

func NewHandlerWithLab(configuredKeys map[string]ed25519.PublicKey, studio fs.FS, lab *labjobs.Manager) http.Handler {
	trustedKeys := make(map[string]ed25519.PublicKey, len(configuredKeys))
	for keyID, key := range configuredKeys {
		trustedKeys[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	mux := http.NewServeMux()
	probe := func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}
	mux.HandleFunc("GET /healthz", probe)
	mux.HandleFunc("GET /readyz", probe)
	mux.HandleFunc("GET /api/v1/info", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"build":        buildinfo.Current(),
			"capabilities": map[string]bool{"studio": studio != nil, "labExecution": lab != nil, "signatureVerification": true, "backupReview": true},
		})
	})
	mux.HandleFunc("GET /api/v1/schemas/drillrun", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/schema+json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write(schema.DrillRunJSONSchema)
	})
	mux.HandleFunc("POST /api/v1/drills/validate", validateDrillHandler)
	mux.HandleFunc("POST /api/v1/attestations/key", inspectPublicKeyHandler)
	mux.HandleFunc("POST /api/v1/attestations/verify", selectedKeyVerificationHandler)
	mux.HandleFunc("POST /api/v1/runs/report", func(writer http.ResponseWriter, request *http.Request) {
		runReportHandler(writer, request, trustedKeys)
	})
	registerBackupRoutes(mux)
	registerLabRoutes(mux, lab)
	if studio != nil {
		files := http.FileServer(http.FS(studio))
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/api" || strings.HasPrefix(request.URL.Path, "/api/") || request.URL.Path == "/healthz" || request.URL.Path == "/readyz" {
				mux.ServeHTTP(writer, request)
				return
			}
			if request.Method != http.MethodGet && request.Method != http.MethodHead {
				writer.Header().Set("Allow", "GET, HEAD")
				http.Error(writer, "Method Not Allowed", http.StatusMethodNotAllowed)
				return
			}
			for _, segment := range strings.Split(request.URL.Path, "/") {
				if strings.HasPrefix(segment, ".") {
					http.NotFound(writer, request)
					return
				}
			}
			if request.URL.Path != "/" {
				info, err := fs.Stat(studio, strings.TrimPrefix(request.URL.Path, "/"))
				if err != nil || info.IsDir() {
					http.NotFound(writer, request)
					return
				}
			}
			writer.Header().Set("X-Content-Type-Options", "nosniff")
			writer.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(writer, request)
		})
	}
	return mux
}

func NewServer(address string) *http.Server {
	return NewServerWithTrustedKeys(address, nil)
}

func NewServerWithTrustedKeys(address string, trustedKeys map[string]ed25519.PublicKey) *http.Server {
	return NewServerWithStudio(address, trustedKeys, nil)
}

func NewServerWithStudio(address string, trustedKeys map[string]ed25519.PublicKey, studio fs.FS) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           NewHandlerWithStudio(trustedKeys, studio),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}
