package backupreview

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func fixture(t *testing.T) ([]byte, []byte) {
	t.Helper()
	plan := []byte(fmt.Sprintf(`{"apiVersion":"nostekon/restore-plan/v1alpha1","kind":"PostgreSQLRestorePlan","backup":{"sha256":%q,"bytes":5},"imageId":%q,"tables":{"public.orders":3},"timeoutSeconds":300}`, strings.Repeat("a", 64), "sha256:"+strings.Repeat("b", 64)))
	evidence := map[string]any{
		"apiVersion": "nostekon/v1alpha1", "kind": "DrillRun",
		"metadata": map[string]any{"name": "nostekon-backup-aaaaaaaaaaaa"},
		"spec":     map[string]any{"scenario": "postgresql-backup-rehearsal", "upTo": "V3"},
		"status": map[string]any{
			"failureAt": "2026-10-12T08:00:00Z", "completedAt": "2026-10-12T08:00:01Z",
			"checks": []map[string]any{
				{"level": "V0", "name": "Frozen custom archive", "passed": true, "detail": "SHA-256 " + strings.Repeat("a", 64) + "; 5 bytes"},
				{"level": "V0", "name": "Pinned local PostgreSQL image", "passed": true, "detail": "sha256:" + strings.Repeat("b", 64)},
				{"level": "V0", "name": "Restore plan binding", "passed": true, "detail": "Canonical plan SHA-256 " + strings.Repeat("0", 64) + "; backup and image matched; not operator approval or authenticated provenance"},
				{"level": "V1", "name": "Archive restore completed", "passed": true, "detail": "pg_restore --exit-on-error --single-transaction"},
				{"level": "V2", "name": "Restored database query", "passed": true, "detail": "SELECT 1 returned 1; not an application-health proof"},
				{"level": "V2", "name": "Isolated target removed", "passed": true, "detail": "nostekon-backup-aaaaaaaaaaaa"},
				{"level": "V3", "name": "Row count: public.orders", "passed": true, "detail": "expected 3; measured 3"},
			},
		},
	}
	data, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	return plan, data
}

func TestPassingEvidenceCannotBypassPlanFingerprint(t *testing.T) {
	plan, evidence := fixture(t)
	review, err := Evaluate(plan, evidence)
	if err != nil {
		t.Fatal(err)
	}
	if review.Report.Verdict != "verified" || review.Passed || review.EvidenceMatches {
		t.Fatalf("passing report bypassed mismatched plan: %+v", review)
	}
	if len(review.Issues) == 0 || review.Provenance.Status != "unverified" {
		t.Fatalf("missing mismatch or provenance warning: %+v", review)
	}
}

func validFixture(t *testing.T, semantic bool) ([]byte, []byte) {
	t.Helper()
	planData, evidenceData := fixture(t)
	identity := "6c1d42c07bfc288437c775c6c56d8952774637e8a4f11c505ef2169bdedf9b5c"
	if semantic {
		identity = "e2fa786c149b75da09d5a66d076095a4f657d3f0db89cd8d5d3cce4a655519fe"
		var declared map[string]any
		if err := json.Unmarshal(planData, &declared); err != nil {
			t.Fatal(err)
		}
		declared["apiVersion"] = "nostekon/restore-plan/v2alpha1"
		declared["invariants"] = []map[string]any{{"name": "orders-id", "type": "not_null", "table": "public.orders", "column": "id"}}
		planData, _ = json.Marshal(declared)
		var captured map[string]any
		if err := json.Unmarshal(evidenceData, &captured); err != nil {
			t.Fatal(err)
		}
		captured["spec"] = map[string]any{"scenario": "postgresql-backup-rehearsal", "upTo": "V4", "v4Evidence": map[string]any{"invariants": []string{"orders-id"}}}
		status := captured["status"].(map[string]any)
		status["checks"] = append(status["checks"].([]any), map[string]any{"level": "V4", "name": "orders-id", "passed": true, "detail": "not_null: public.orders.id; measured violations: 0; expected 0"})
		evidenceData, _ = json.Marshal(captured)
	}
	evidenceData = bytes.ReplaceAll(evidenceData, []byte(strings.Repeat("0", 64)), []byte(identity))
	return planData, evidenceData
}

func TestCanonicalPlanIdentityAndPassingReview(t *testing.T) {
	for _, semantic := range []bool{false, true} {
		planData, evidenceData := validFixture(t, semantic)
		review, err := Evaluate(planData, evidenceData)
		if err != nil || !review.Passed || !review.EvidenceMatches || !review.Complete || len(review.Issues) != 0 {
			t.Fatalf("semantic=%v: %+v, %v", semantic, review, err)
		}
		if review.PlanFileSHA256 != digest(planData) || review.EvidenceSHA256 != digest(evidenceData) {
			t.Fatal("original byte digests not preserved")
		}
		var indented bytes.Buffer
		if err := json.Indent(&indented, planData, "", "  "); err != nil {
			t.Fatal(err)
		}
		formatted, err := Evaluate(indented.Bytes(), evidenceData)
		if err != nil || !formatted.Passed || formatted.PlanSHA256 != review.PlanSHA256 || formatted.PlanFileSHA256 == review.PlanFileSHA256 {
			t.Fatalf("formatting changed canonical identity: %+v, %v", formatted, err)
		}
	}
}

func TestRejectsAmbiguousOrUnsafePlans(t *testing.T) {
	planData, evidenceData := validFixture(t, false)
	for _, change := range []struct{ name, before, after string }{
		{"duplicate", `"kind":"PostgreSQLRestorePlan"`, `"kind":"PostgreSQLRestorePlan","kind":"PostgreSQLRestorePlan"`},
		{"case", `"apiVersion"`, `"ApiVersion"`},
		{"nested case", `"sha256"`, `"SHA256"`},
		{"null count", `"public.orders":3`, `"public.orders":null`},
		{"float count", `"public.orders":3`, `"public.orders":3.0`},
		{"negative count", `"public.orders":3`, `"public.orders":-1`},
		{"overflow count", `"public.orders":3`, `"public.orders":9223372036854775808`},
		{"system table", `"public.orders"`, `"pg_catalog.orders"`},
		{"invalid table", `"public.orders"`, `"public.orders;SELECT 1"`},
		{"bool size", `"bytes":5`, `"bytes":true`},
		{"missing size", `,"bytes":5`, ``},
		{"oversize archive", `"bytes":5`, `"bytes":67108865`},
		{"bad timeout", `"timeoutSeconds":300`, `"timeoutSeconds":1801`},
		{"unknown field", `"timeoutSeconds":300`, `"timeoutSeconds":300,"sql":"SELECT 1"`},
		{"mutable image", `"imageId":"sha256:`, `"imageId":"postgres:`},
		{"v1 null invariants", `"timeoutSeconds":300`, `"timeoutSeconds":300,"invariants":null`},
	} {
		t.Run(change.name, func(t *testing.T) {
			altered := bytes.Replace(planData, []byte(change.before), []byte(change.after), 1)
			if bytes.Equal(altered, planData) {
				t.Fatal("test mutation did not change the plan")
			}
			if _, err := Evaluate(altered, evidenceData); err == nil {
				t.Fatal("invalid plan accepted")
			}
		})
	}
	for _, data := range [][]byte{nil, bytes.Repeat([]byte(" "), MaxPlanBytes+1), append(planData, []byte(` {}`)...), {0xff}, []byte(strings.Repeat("[", 40) + strings.Repeat("]", 40))} {
		if _, err := Evaluate(data, evidenceData); err == nil {
			t.Fatal("unbounded or invalid plan accepted")
		}
	}
}

func TestRejectsEvidenceDriftAndContradictoryMeasurements(t *testing.T) {
	planData, evidenceData := validFixture(t, true)
	changes := []struct{ name, before, after string }{
		{"archive", "SHA-256 " + strings.Repeat("a", 64), "SHA-256 " + strings.Repeat("c", 64)},
		{"image", `"detail":"sha256:` + strings.Repeat("b", 64), `"detail":"sha256:` + strings.Repeat("c", 64)},
		{"expected count", "expected 3; measured 3", "expected 2; measured 2"},
		{"count contradicts flag", "expected 3; measured 3", "expected 3; measured 2"},
		{"oversize measurement", "expected 3; measured 3", "expected 3; measured 9223372036854775808"},
		{"missing count", "Row count: public.orders", "Row count: public.other"},
		{"rule scope", "not_null: public.orders.id", "not_null: public.other.id"},
		{"rule contradicts flag", "measured violations: 0", "measured violations: 1"},
		{"extra declaration", `"invariants":["orders-id"]`, `"invariants":["orders-id","extra"]`},
		{"depth", `"upTo":"V4"`, `"upTo":"V3"`},
		{"cleanup target", `"detail":"nostekon-backup-aaaaaaaaaaaa"`, `"detail":"nostekon-backup-bbbbbbbbbbbb"`},
		{"scenario", "postgresql-backup-rehearsal", "cluster-loss"},
	}
	for _, change := range changes {
		t.Run(change.name, func(t *testing.T) {
			altered := bytes.Replace(evidenceData, []byte(change.before), []byte(change.after), 1)
			if bytes.Equal(altered, evidenceData) {
				t.Fatal("test mutation did not change the evidence")
			}
			review, err := Evaluate(planData, altered)
			if err != nil {
				if change.name == "extra declaration" {
					return
				}
				t.Fatal(err)
			}
			if review.Passed || review.EvidenceMatches || len(review.Issues) == 0 {
				t.Fatalf("drift accepted: %+v", review)
			}
		})
	}
}
