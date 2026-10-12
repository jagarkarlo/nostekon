package verify

import (
	"os"
	"strings"
	"testing"
	"time"
)

func loadRun(t *testing.T, name string) *Evidence {
	t.Helper()
	data, err := os.ReadFile("../../examples/runs/" + name)
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := ParseEvidence(data)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return evidence
}

func TestVerifiedRunReachesRequestedLevel(t *testing.T) {
	report := Build(loadRun(t, "mlflow-namespace-loss.run.json"))
	if report.Verdict != Verified || report.DeepestPassed == nil || *report.DeepestPassed != "V4" || report.FirstFailed != nil {
		t.Fatalf("verdict=%s deepest=%v first=%v findings=%+v", report.Verdict, report.DeepestPassed, report.FirstFailed, report.Findings)
	}
	if report.RTO == nil || report.RTO.Seconds != 703 || report.RTO.Met == nil || !*report.RTO.Met {
		t.Fatalf("rto = %+v", report.RTO)
	}
	if report.RTO.SlowestPhase != "restore-database-pitr" {
		t.Fatalf("slowest phase = %q", report.RTO.SlowestPhase)
	}
	rpo := report.RPO
	if rpo == nil || rpo.Lost != 75 || rpo.Holes != 0 || rpo.Seconds != 38 || rpo.Met == nil || !*rpo.Met {
		t.Fatalf("rpo = %+v", rpo)
	}
	if len(rpo.Timeline) != ledgerBuckets {
		t.Fatalf("timeline buckets = %d", len(rpo.Timeline))
	}
	total := 0
	for _, bucket := range rpo.Timeline {
		total += bucket.Recovered + bucket.Lost
	}
	if total != rpo.Acknowledged {
		t.Fatalf("timeline holds %d writes, want %d", total, rpo.Acknowledged)
	}
	ledgerChecks := report.Levels[V4].Checks
	if last := ledgerChecks[len(ledgerChecks)-1]; last.Source != "ledger" || !last.Passed {
		t.Fatalf("ledger check = %+v", last)
	}
}

func TestBackupRehearsalReportsItsLimitedScope(t *testing.T) {
	evidence := loadRun(t, "k3d-postgresql.run.json")
	evidence.Spec.Scenario = "postgresql-backup-rehearsal"
	report := Build(evidence)
	for _, finding := range report.Findings {
		if strings.Contains(finding.Message, "not incident RTO") {
			return
		}
	}
	t.Fatal("backup rehearsal must disclose its timing and application scope")
}

func TestRecordedLabLedgerPolicies(t *testing.T) {
	cases := []struct {
		name    string
		verdict Verdict
		lost    int
		seconds float64
	}{
		{"k3d-ledger-zero-loss", Verified, 0, 0},
		{"k3d-ledger-tail-loss", Failed, 2, 0.978107},
		{"k3d-ledger-budget-loss", Verified, 2, 0.949153},
	}
	for _, sample := range cases {
		t.Run(sample.name, func(t *testing.T) {
			report := Build(loadRun(t, sample.name+".run.json"))
			if report.Verdict != sample.verdict || report.RPO == nil {
				t.Fatalf("verdict=%s, RPO=%+v", report.Verdict, report.RPO)
			}
			rpo := report.RPO
			if rpo.Acknowledged != 10+sample.lost || rpo.Recovered != 10 || rpo.Lost != sample.lost || rpo.Holes != 0 || rpo.Unexpected != 0 || rpo.Seconds != sample.seconds {
				t.Fatalf("recorded RPO = %+v", rpo)
			}
			if rpo.Met == nil || *rpo.Met != (sample.verdict == Verified) {
				t.Fatalf("RPO objective = %+v", rpo)
			}
			deepest := "V4"
			if sample.verdict == Failed {
				deepest = "V3"
			}
			if report.DeepestPassed == nil || *report.DeepestPassed != deepest {
				t.Fatalf("deepest passed = %v", report.DeepestPassed)
			}
		})
	}
}

func TestLedgerTailLossNeedsAnRPOObjectiveForV4(t *testing.T) {
	evidence := loadRun(t, "mlflow-namespace-loss.run.json")
	evidence.hasRPO = false
	report := Build(evidence)
	if report.Verdict != Failed || report.FirstFailed == nil || *report.FirstFailed != "V4" {
		t.Fatalf("tail loss without an RPO objective must fail V4: verdict=%s first=%v", report.Verdict, report.FirstFailed)
	}
}

func TestRPOWithinObjectivePassesV4AndUnexpectedWritesDoNot(t *testing.T) {
	evidence := loadRun(t, "mlflow-namespace-loss.run.json")
	failureAt := evidence.Status.FailureAt
	evidence.Status.Ledger.Acks = []Ack{
		{WriteID: "w1", AckedAt: failureAt.Add(-2 * time.Second)},
		{WriteID: "w2", AckedAt: failureAt.Add(-time.Second)},
	}
	evidence.Status.Ledger.Present = []string{"w1"}
	evidence.Status.Checks = evidence.Status.Checks[:len(evidence.Status.Checks)-1]
	evidence.rpo = 5 * time.Second
	evidence.hasRPO = true
	report := Build(evidence)
	if report.Levels[V4].Status != "passed" || report.RPO.Met == nil || !*report.RPO.Met {
		t.Fatalf("loss within objective should pass V4: V4=%s RPO=%+v", report.Levels[V4].Status, report.RPO)
	}

	evidence.Status.Ledger.Present = append(evidence.Status.Ledger.Present, "not-acknowledged")
	report = Build(evidence)
	if report.Levels[V4].Status != "failed" || report.RPO.Unexpected != 1 {
		t.Fatalf("unexpected write should fail V4: V4=%s RPO=%+v", report.Levels[V4].Status, report.RPO)
	}
}

func TestEmptyLedgerCannotClaimZeroRPO(t *testing.T) {
	evidence := loadRun(t, "mlflow-namespace-loss.run.json")
	evidence.Status.Ledger.Acks = nil
	evidence.Status.Ledger.Present = nil
	report := Build(evidence)
	if report.RPO != nil {
		t.Fatalf("empty ledger produced an RPO measurement: %+v", report.RPO)
	}
	if report.Verdict != Incomplete || report.Headline != "Incomplete: a recovery objective is missing its measurement" {
		t.Fatalf("empty ledger verdict=%s headline=%q", report.Verdict, report.Headline)
	}
}

func TestFailedRunReportsFirstFailureAndMissedRTO(t *testing.T) {
	report := Build(loadRun(t, "crud-cluster-loss.run.json"))
	if report.Verdict != Failed || report.FirstFailed == nil || *report.FirstFailed != "V3" {
		t.Fatalf("verdict=%s first=%v", report.Verdict, report.FirstFailed)
	}
	if report.DeepestPassed == nil || *report.DeepestPassed != "V2" {
		t.Fatalf("deepest = %v", report.DeepestPassed)
	}
	if !strings.Contains(report.Headline, "table row counts") {
		t.Fatalf("headline = %q", report.Headline)
	}
	if report.RTO == nil || report.RTO.Met == nil || *report.RTO.Met {
		t.Fatalf("expected missed RTO, got %+v", report.RTO)
	}
	if report.RTO.UncoveredSeconds != 166 {
		t.Fatalf("uncovered = %v, want 166", report.RTO.UncoveredSeconds)
	}
	if report.Findings[0].Severity != "error" {
		t.Fatalf("errors must sort first: %+v", report.Findings)
	}
	if report.Levels[V4].InScope {
		t.Fatal("V4 is beyond the requested V3")
	}
}

const minimalRun = `{
	"apiVersion": "nostekon/v1alpha1", "kind": "DrillRun",
	"metadata": {"name": "demo"},
	"spec": {"upTo": "V2", "objectives": {"rpo": 10}},
	"status": {
		"failureAt": "2026-10-01T10:00:10Z",
		"completedAt": "2026-10-01T10:00:40Z",
		"checks": [
			{"level": "V0", "name": "backup", "passed": true},
			{"level": 2, "name": "pods", "passed": true}
		],
		"ledger": {
			"acks": [{"writeId": "a", "ackedAt": "2026-10-01T09:59:40Z"}, {"writeId": "b", "ackedAt": "2026-10-01T10:00:05Z"}],
			"present": ["a"]
		}
	}
}`

func TestGapInLevelsIsIncompleteAndRPOMissFails(t *testing.T) {
	evidence, err := ParseEvidence([]byte(minimalRun))
	if err != nil {
		t.Fatal(err)
	}
	report := Build(evidence)
	if report.DeepestPassed == nil || *report.DeepestPassed != "V0" {
		t.Fatalf("a missing V1 must stop the chain at V0, got %v", report.DeepestPassed)
	}
	if report.Verdict != Failed || report.RPO.Seconds != 30 || *report.RPO.Met {
		t.Fatalf("expected RPO miss: verdict=%s rpo=%+v", report.Verdict, report.RPO)
	}

	evidence, _ = ParseEvidence([]byte(strings.Replace(minimalRun, `"rpo": 10`, `"rpo": "1m"`, 1)))
	if report := Build(evidence); report.Verdict != Incomplete {
		t.Fatalf("verdict = %s, want incomplete; headline %q", report.Verdict, report.Headline)
	}
}

func TestParseEvidenceReportsProblemsWithPaths(t *testing.T) {
	body := `{"apiVersion": "v1", "kind": "DrillRun", "metadata": {"name": "Bad_Name"},
		"spec": {"upTo": "V9", "objectives": {"rto": "soon"}},
		"status": {
			"phases": [{"name": "restore", "startedAt": "2026-10-01T10:05:00Z", "endedAt": "2026-10-01T10:00:00Z"}],
			"checks": [{"level": "V1", "name": ""}],
			"ledger": {"acks": [{"writeId": "a", "ackedAt": "2026-10-01T10:00:00Z"}, {"writeId": "a", "ackedAt": "2026-10-01T10:00:01Z"}], "present": []}
		}}`
	_, err := ParseEvidence([]byte(body))
	problems, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("err = %v", err)
	}
	joined := strings.Join(problems.Problems, "\n")
	for _, want := range []string{
		"apiVersion:", "metadata.name:", "spec.upTo:", "spec.objectives.rto:", "status.failureAt: field required", "status.completedAt: field required",
		"status.phases.0.endedAt:", "status.checks.0.name:", "status.checks.0.passed:", "status.ledger.acks.1.writeId: duplicate",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing problem %q in:\n%s", want, joined)
		}
	}
}

func TestParseEvidenceRejectsUnknownFields(t *testing.T) {
	if _, err := ParseEvidence([]byte(strings.Replace(minimalRun, `"kind"`, `"extra": 1, "kind"`, 1))); err == nil {
		t.Fatal("unknown fields must be rejected")
	}
}

func TestParseEvidenceAcceptsCurrentAndLegacyAPIVersions(t *testing.T) {
	for _, version := range []string{"nostekon/v1alpha1", "checkride/v1alpha1"} {
		body := strings.Replace(minimalRun, `"nostekon/v1alpha1"`, `"`+version+`"`, 1)
		if _, err := ParseEvidence([]byte(body)); err != nil {
			t.Errorf("%s: %v", version, err)
		}
	}
	body := strings.Replace(minimalRun, `"nostekon/v1alpha1"`, `"nostekon/v2"`, 1)
	if _, err := ParseEvidence([]byte(body)); err == nil || !strings.Contains(err.Error(), "apiVersion: must be nostekon/v1alpha1") {
		t.Fatalf("unknown apiVersion error = %v", err)
	}
}

func TestParseObjectiveRejectsOverflow(t *testing.T) {
	for _, value := range []string{`9223372037`, `"999999999999999999h"`} {
		if _, _, err := parseObjective([]byte(value)); err == nil {
			t.Errorf("parseObjective(%s) accepted an overflowing objective", value)
		}
	}
}

func TestV4RequiresDeclaredCorrectnessEvidence(t *testing.T) {
	withoutEvidence := `{"apiVersion":"nostekon/v1alpha1","kind":"DrillRun","metadata":{"name":"demo"},"spec":{"upTo":"V4"},"status":{"failureAt":"2026-10-01T10:00:00Z","completedAt":"2026-10-01T10:00:30Z","checks":[{"level":"V0","name":"backup","passed":true},{"level":"V1","name":"restore","passed":true},{"level":"V2","name":"health","passed":true},{"level":"V3","name":"rows","passed":true},{"level":"V4","name":"correct","passed":true}]}}`
	_, err := ParseEvidence([]byte(withoutEvidence))
	if validation, ok := err.(*ValidationError); !ok || !strings.Contains(validation.Error(), "spec.v4Evidence: V4 requires") {
		t.Fatalf("err = %v, want V4 evidence error", err)
	}

	withInvariant := strings.Replace(withoutEvidence, `"upTo":"V4"`, `"upTo":"V4","v4Evidence":{"invariants":["row-count"]}`, 1)
	withInvariant = strings.Replace(withInvariant, `"checks":[`, `"checks":[{"level":"V4","name":"row-count","passed":true},`, 1)
	if _, err := ParseEvidence([]byte(withInvariant)); err != nil {
		t.Fatalf("declared V4 invariant should satisfy evidence requirement: %v", err)
	}
}

func TestFindingDurationsAreCompact(t *testing.T) {
	for value, want := range map[float64]string{0: "0s", 38: "38s", 1800: "30m", 2371: "39m31s", 3720: "1h2m"} {
		if got := seconds(value); got != want {
			t.Errorf("seconds(%v) = %q, want %q", value, got, want)
		}
	}
}
