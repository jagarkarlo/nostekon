package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"unicode/utf8"

	"github.com/jagarkarlo/nostekon/internal/backupreview"
)

func registerBackupRoutes(mux *http.ServeMux) {
	for _, path := range []string{"/api/v1/backups/review", "/api/v1/backups/bundle", "/api/v1/backups/import"} {
		mux.HandleFunc("POST "+path, backupReviewHandler)
	}
}

func backupReviewHandler(writer http.ResponseWriter, request *http.Request) {
	select {
	case reportSlots <- struct{}{}:
		defer func() { <-reportSlots }()
	default:
		writer.Header().Set("Retry-After", "1")
		writeJSON(writer, http.StatusServiceUnavailable, reportProblem{Errors: []string{"report capacity reached; retry shortly"}})
		return
	}
	problem := func(status int, message string) { writeJSON(writer, status, reportProblem{Errors: []string{message}}) }
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		problem(http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return
	}
	const limit = 2*backupreview.MaxBundleBytes + 1024
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, limit))
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			problem(http.StatusRequestEntityTooLarge, "backup request exceeds its bounded JSON envelope limit")
		} else {
			problem(http.StatusBadRequest, "could not read backup request")
		}
		return
	}
	if !utf8.Valid(body) {
		problem(http.StatusBadRequest, "backup request must be UTF-8 JSON")
		return
	}
	fields, err := backupRequestFields(body, request.URL.Path == "/api/v1/backups/import")
	if err != nil {
		problem(http.StatusBadRequest, err.Error())
		return
	}
	if request.URL.Path == "/api/v1/backups/import" {
		var archive []byte
		if err := json.Unmarshal(fields["bundle"], &archive); err != nil {
			problem(http.StatusBadRequest, "bundle must be standard base64")
			return
		}
		imported, err := backupreview.ReadBundle(archive)
		if err != nil {
			problem(http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSON(writer, http.StatusOK, struct {
			Plan     string              `json:"plan"`
			Evidence string              `json:"evidence"`
			Review   backupreview.Review `json:"review"`
		}{string(imported.Plan), string(imported.Evidence), imported.Review})
		return
	}
	var plan, evidence string
	if json.Unmarshal(fields["plan"], &plan) != nil || json.Unmarshal(fields["evidence"], &evidence) != nil {
		problem(http.StatusBadRequest, "plan and evidence must be JSON strings containing original UTF-8 documents")
		return
	}
	if request.URL.Path == "/api/v1/backups/bundle" {
		archive, err := backupreview.Bundle([]byte(plan), []byte(evidence))
		if err != nil {
			problem(http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSON(writer, http.StatusOK, struct {
			Bundle []byte `json:"bundle"`
		}{archive})
		return
	}
	review, err := backupreview.Evaluate([]byte(plan), []byte(evidence))
	if err != nil {
		problem(http.StatusUnprocessableEntity, err.Error())
		return
	}
	writeJSON(writer, http.StatusOK, review)
}

func backupRequestFields(body []byte, importing bool) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("backup request must be one JSON object")
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := token.(string)
		_, duplicate := fields[key]
		if !ok || duplicate || importing && key != "bundle" || !importing && key != "plan" && key != "evidence" {
			return nil, errors.New("unknown or duplicate backup request field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if len(value) == 0 || value[0] != '"' {
			return nil, errors.New("backup request fields must be non-null strings")
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("backup request requires one JSON document")
	}
	expected := 2
	if importing {
		expected = 1
	}
	if len(fields) != expected {
		return nil, errors.New("missing backup request fields")
	}
	return fields, nil
}
