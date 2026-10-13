package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"unicode/utf8"

	"github.com/jagarkarlo/nostekon/internal/backupreview"
)

func registerBackupRoutes(mux *http.ServeMux) {
	for _, path := range []string{"/api/v1/backups/review", "/api/v1/backups/bundle", "/api/v1/backups/import", "/api/v1/backups/profile"} {
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
	limit := int64(2*backupreview.MaxBundleBytes + 1024)
	profileMode := request.URL.Path == "/api/v1/backups/profile"
	if profileMode {
		limit = 6*backupreview.MaxPlanBytes + 1024
	}
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
	var fields map[string]json.RawMessage
	if profileMode {
		fields, err = backupStringFields(body, "profile")
	} else {
		fields, err = backupRequestFields(body, request.URL.Path == "/api/v1/backups/import")
	}
	if err != nil {
		problem(http.StatusBadRequest, err.Error())
		return
	}
	if profileMode {
		var original string
		if err := json.Unmarshal(fields["profile"], &original); err != nil {
			problem(http.StatusBadRequest, "profile must be a JSON string")
			return
		}
		review, err := backupreview.InspectProfile([]byte(original))
		if err != nil {
			problem(http.StatusUnprocessableEntity, err.Error())
			return
		}
		writeJSON(writer, http.StatusOK, review)
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
	if importing {
		return backupStringFields(body, "bundle")
	}
	return backupStringFields(body, "plan", "evidence")
}

func backupStringFields(body []byte, names ...string) (map[string]json.RawMessage, error) {
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
		if !ok || duplicate || !slices.Contains(names, key) {
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
	if len(fields) != len(names) {
		return nil, errors.New("missing backup request fields")
	}
	return fields, nil
}
