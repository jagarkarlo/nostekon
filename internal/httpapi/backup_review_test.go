package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jagarkarlo/nostekon/internal/backupreview"
)

func TestValidationProfileRoute(t *testing.T) {
	profile, err := os.ReadFile("../../examples/validation-profiles/orders.json")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"profile": string(profile)})
	expected, err := backupreview.InspectProfile(profile)
	if err != nil {
		t.Fatal(err)
	}
	expectedJSON, _ := json.Marshal(expected)
	for _, test := range []struct {
		body   string
		status int
	}{
		{string(body), 200},
		{`{}`, 400}, {`{"profile":null}`, 400}, {`{"Profile":"{}"}`, 400},
		{`{"profile":"{}","profile":"{}"}`, 400},
		{`{"profile":"{}"} {}`, 400}, {`{"profile":"{}"}`, 422},
		{`{"profile":"` + strings.Repeat("x", 6*backupreview.MaxPlanBytes+1024) + `"}`, 413},
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/backups/profile", strings.NewReader(test.body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		NewHandler().ServeHTTP(response, request)
		if response.Code != test.status || test.status == 200 && !bytes.Equal(bytes.TrimSpace(response.Body.Bytes()), expectedJSON) {
			t.Fatalf("profile route: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestBackupReviewAndBundleRoutes(t *testing.T) {
	plan, err := os.ReadFile("../../studio/e2e/postgresql-semantic-rehearsal.plan.json")
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := os.ReadFile("../../studio/e2e/postgresql-semantic-rehearsal.run.json")
	if err != nil {
		t.Fatal(err)
	}
	expected, err := backupreview.Evaluate(plan, evidence)
	if err != nil || expected.PlanSHA256 != "988df63edaa9bf7f3f749d22de856f23aec91dfcd167df4e1d5163a8ebb6e7e1" || expected.Passed || !expected.Complete || !expected.EvidenceMatches {
		t.Fatalf("real fixture: %+v %v", expected, err)
	}
	call := func(path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		NewHandler().ServeHTTP(response, request)
		return response
	}
	body := map[string]string{"plan": string(plan), "evidence": string(evidence)}
	response := call("/api/v1/backups/review", body)
	var review backupreview.Review
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &review) != nil || review.Passed || !review.Complete || !review.EvidenceMatches || review.PlanSHA256 != expected.PlanSHA256 {
		t.Fatalf("review response: %d %s", response.Code, response.Body.String())
	}
	response = call("/api/v1/backups/bundle", body)
	var packed struct {
		Bundle []byte `json:"bundle"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &packed) != nil || len(packed.Bundle) == 0 {
		t.Fatalf("bundle response: %d %s", response.Code, response.Body.String())
	}
	response = call("/api/v1/backups/import", packed)
	var imported struct {
		Plan     string              `json:"plan"`
		Evidence string              `json:"evidence"`
		Review   backupreview.Review `json:"review"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &imported) != nil || imported.Plan != string(plan) || imported.Evidence != string(evidence) || imported.Review.Passed || !imported.Review.Complete || !imported.Review.EvidenceMatches || imported.Review.Provenance.Status != "unverified" {
		t.Fatalf("import response: %d %s", response.Code, response.Body.String())
	}
}

func TestBackupReviewAdmission(t *testing.T) {
	for _, test := range []struct {
		body, mediaType string
		status          int
	}{
		{`{}`, "text/plain", 415},
		{`null`, "application/json", 400},
		{`{"plan":"{}","evidence":"{}","plan":"{}"}`, "application/json", 400},
		{`{"Plan":"{}","evidence":"{}"}`, "application/json", 400},
		{`{"plan":null,"evidence":"{}"}`, "application/json", 400},
		{`{"plan":"{}","evidence":"{}"} {}`, "application/json", 400},
		{`{"plan":"{}","evidence":"{}"}`, "application/json", 422},
		{`{"plan":"` + strings.Repeat(" ", backupreview.MaxPlanBytes+1) + `","evidence":"{}"}`, "application/json", 422},
		{string([]byte{255}), "application/json", 400},
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/backups/review", strings.NewReader(test.body))
		request.Header.Set("Content-Type", test.mediaType)
		response := httptest.NewRecorder()
		NewHandler().ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("expected %d got %d: %s", test.status, response.Code, response.Body.String())
		}
	}
	for _, body := range []string{`{"bundle":null}`, `{"bundle":"not-base64"}`, `{"bundle":"UEsDBAD/"}`, `{"bundle":"","extra":""}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/backups/import", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		NewHandler().ServeHTTP(response, request)
		if response.Code != 400 && response.Code != 422 {
			t.Fatalf("unsafe import: %d %s", response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/backups/review", strings.NewReader(strings.Repeat(" ", 2*backupreview.MaxBundleBytes+1025)))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	NewHandler().ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized envelope: %d", response.Code)
	}
}

func TestBackupReviewSharesReportCapacity(t *testing.T) {
	for range maxConcurrentReports {
		reportSlots <- struct{}{}
	}
	defer func() {
		for range maxConcurrentReports {
			<-reportSlots
		}
	}()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/backups/review", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	NewHandler().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("capacity not enforced: %d", response.Code)
	}
}
