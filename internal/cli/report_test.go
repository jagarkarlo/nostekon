package cli

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jagarkarlo/nostekon/internal/attest"
)

func TestValidationProfileMode(t *testing.T) {
	var output, problems bytes.Buffer
	if code := Run([]string{"--validation-profile", "../../examples/validation-profiles/inventory.json"}, &output, &problems); code != 0 {
		t.Fatalf("profile inspection: %d %s", code, problems.String())
	}
	var review map[string]any
	if err := json.Unmarshal(output.Bytes(), &review); err != nil || review["kind"] != "PostgreSQLProfileReview" || review["valid"] != true || review["passed"] != nil {
		t.Fatalf("not a profile-only inspection: %s %v", output.String(), err)
	}
	for _, args := range [][]string{
		{"--validation-profile", "missing.json"},
		{"--validation-profile", "--suite", "profile.json"},
		{"--validation-profile", "--backup-plan", "plan.json", "profile.json"},
		{"--validation-profile", "--pushgateway-job", "nostekon", "profile.json"},
	} {
		output.Reset()
		if code := Run(args, &output, &problems); code != 2 || output.Len() != 0 {
			t.Fatalf("invalid profile mode admitted: %v %d %s", args, code, output.String())
		}
	}
}

func TestBackupPreflightCLIMode(t *testing.T) {
	directory := t.TempDir()
	planPath := "../../studio/e2e/postgresql-semantic-rehearsal.plan.json"
	preflightPath := filepath.Join(directory, "preflight.json")
	preflight := `{
  "apiVersion": "nostekon/backup-preflight/v1alpha1",
  "kind": "PostgreSQLBackupPreflight",
  "passed": true,
  "backupMatches": true,
  "backup": { "sha256": "6d9a0a2794de72ac5c986ccbfa9487c2d7c6a2e2935b27cb0916bac3bf092c50", "bytes": 3323 },
  "planSHA256": "988df63edaa9bf7f3f749d22de856f23aec91dfcd167df4e1d5163a8ebb6e7e1",
  "imageId": "sha256:2698c2096ca78a41ae7477580afb30fe36d5368564511b2ea593dbfb26401fdd",
  "requestedLevel": "V4",
  "checks": [
    { "name": "backup-plan-binding", "passed": true, "detail": "Frozen archive checksum and size match the plan" },
    { "name": "snapshot-count-coverage", "passed": true, "detail": "At least one table count is declared" },
    { "name": "local-linux-daemon", "passed": true, "detail": "Local Linux Docker daemon on a supported native architecture" },
    { "name": "daemon-resource-floor", "passed": true, "detail": "At least 512 MiB and one CPU advertised; free capacity untested" },
    { "name": "native-pinned-image", "passed": true, "detail": "Exact cached Linux image matches native daemon architecture" }
  ],
  "limitations": [
    "Technical prerequisites only; not approval, sanitization or dedicated-host confirmation",
    "Header/byte binding only; full archive validity and restore success untested",
    "No restore ran; capture authenticity, incident RTO and acknowledged-write RPO unmeasured"
  ]
}`
	if err := os.WriteFile(preflightPath, []byte(preflight), 0600); err != nil {
		t.Fatal(err)
	}
	var output, problems bytes.Buffer
	if code := Run([]string{"--backup-plan", planPath, "--backup-preflight", preflightPath}, &output, &problems); code != 0 {
		t.Fatalf("preflight gate: %d %s", code, problems.String())
	}
	var review map[string]any
	if err := json.Unmarshal(output.Bytes(), &review); err != nil || review["kind"] != "PostgreSQLPreflightReview" || review["passed"] != true {
		t.Fatalf("unexpected preflight review: %s %v", output.String(), err)
	}
	blockedPath := filepath.Join(directory, "blocked.json")
	blocked := strings.Replace(preflight, `"name": "native-pinned-image", "passed": true`, `"name": "native-pinned-image", "passed": false`, 1)
	blocked = strings.Replace(blocked, `"passed": true,`, `"passed": false,`, 1)
	if err := os.WriteFile(blockedPath, []byte(blocked), 0600); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if code := Run([]string{"--backup-plan", planPath, "--backup-preflight", blockedPath}, &output, &problems); code != 1 {
		t.Fatalf("blocked preflight exit=%d %s", code, problems.String())
	}
	for _, args := range [][]string{
		{"--backup-preflight", preflightPath},
		{"--backup-plan", planPath, "--backup-preflight", "--export-backup-bundle", preflightPath},
		{"--backup-plan", planPath, "--backup-preflight", "--suite", preflightPath},
	} {
		output.Reset()
		if code := Run(args, &output, &problems); code != 2 || output.Len() != 0 {
			t.Fatalf("invalid preflight args=%v exit=%d", args, code)
		}
	}
}

func TestBackupPlanModeRejectsConflictingOptions(t *testing.T) {
	for _, options := range [][]string{
		{"--suite"}, {"--attestation", "sidecar.json", "--trusted-key", "key.pem"},
		{"--pushgateway-url", "http://127.0.0.1:1"}, {"--pushgateway-job", "custom"},
		{"--pushgateway-instance", "custom"},
	} {
		var output, problems bytes.Buffer
		args := append([]string{"--backup-plan", "plan.json"}, options...)
		args = append(args, "run.json")
		if code := Run(args, &output, &problems); code != 2 || output.Len() != 0 {
			t.Fatalf("conflicting options accepted: %v, %d, %s", options, code, problems.String())
		}
	}
}

func TestBackupPlanModeRoutesMissingInputToAdmissionError(t *testing.T) {
	var output, problems bytes.Buffer
	if code := Run([]string{"--backup-plan", "missing-plan.json", "run.json"}, &output, &problems); code != 2 || !strings.Contains(problems.String(), "read backup plan:") || output.Len() != 0 {
		t.Fatalf("gate did not route missing plan: %d %s", code, problems.String())
	}
}

func TestBackupPlanInputRejectsUnsafeFiles(t *testing.T) {
	directory := t.TempDir()
	for name, contents := range map[string][]byte{"empty.json": {}, "large.json": bytes.Repeat([]byte("x"), 16385), "invalid.json": []byte(`{}`)} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, contents, 0600); err != nil {
			t.Fatal(err)
		}
		var output, problems bytes.Buffer
		if code := Run([]string{"--backup-plan", path, path}, &output, &problems); code != 2 || output.Len() != 0 {
			t.Fatalf("invalid input accepted: %s %d %s", name, code, problems.String())
		}
	}
	link := filepath.Join(directory, "link.json")
	if err := os.Symlink(filepath.Join(directory, "invalid.json"), link); err != nil {
		t.Fatal(err)
	}
	if _, err := readBackupInput(link, 16384); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := readBackupInput(directory, 16384); err == nil {
		t.Fatal("directory accepted")
	}
	if tool, err := exec.LookPath("mkfifo"); err == nil {
		fifo := filepath.Join(directory, "input.fifo")
		if err := exec.Command(tool, fifo).Run(); err != nil {
			t.Fatal(err)
		}
		if _, err := readBackupInput(fifo, 16384); err == nil {
			t.Fatal("FIFO accepted")
		}
	}
	var output, problems bytes.Buffer
	if code := Run([]string{"--backup-plan", "", "run.json"}, &output, &problems); code != 2 || output.Len() != 0 {
		t.Fatal("empty explicit plan silently fell back to regular report mode")
	}
}

type failingReviewWriter struct{}

func (failingReviewWriter) Write(data []byte) (int, error) { return 0, io.ErrClosedPipe }

func TestBackupPlanModeReturnsReviewAndWriteFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plan.json")
	planData := []byte(`{"apiVersion":"nostekon/restore-plan/v1alpha1","kind":"PostgreSQLRestorePlan","backup":{"sha256":"` + strings.Repeat("a", 64) + `","bytes":5},"imageId":"sha256:` + strings.Repeat("b", 64) + `","tables":{"public.orders":3},"timeoutSeconds":300}`)
	if err := os.WriteFile(path, planData, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--backup-plan", path, "../../studio/e2e/postgresql-plan-rehearsal.run.json"}
	var output, problems bytes.Buffer
	if code := Run(args, &output, &problems); code != 1 || problems.Len() != 0 {
		t.Fatalf("mismatch review failed: %d %s", code, problems.String())
	}
	var review struct {
		Kind            string
		Passed          bool
		EvidenceMatches bool
		Issues          []string
	}
	if err := json.Unmarshal(output.Bytes(), &review); err != nil || review.Kind != "PostgreSQLBackupReview" || review.Passed || review.EvidenceMatches || len(review.Issues) == 0 {
		t.Fatalf("invalid mismatch review: %+v %v", review, err)
	}
	problems.Reset()
	if code := Run(args, failingReviewWriter{}, &problems); code != 2 || !strings.Contains(problems.String(), "write backup review:") {
		t.Fatalf("output error: %d %s", code, problems.String())
	}
}

func TestRunSuiteGateAcceptsExpectedPolicyFailure(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"--suite", "../../examples/suites/postgresql-policy"}, &stdout, &stderr)
	if code != 0 || stderr.Len() != 0 {
		t.Fatalf("suite exit=%d stderr=%s output=%s", code, stderr.String(), stdout.String())
	}
	var review struct {
		APIVersion      string `json:"apiVersion"`
		Kind            string `json:"kind"`
		Passed          bool   `json:"passed"`
		Complete        bool   `json:"complete"`
		EvidenceMatches bool   `json:"evidenceMatches"`
		Cases           []struct {
			Name              string   `json:"name"`
			EvaluatedExitCode *int     `json:"evaluatedExitCode"`
			EvidenceSHA256    string   `json:"evidenceSHA256"`
			Issues            []string `json:"issues"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &review); err != nil {
		t.Fatal(err)
	}
	if review.APIVersion != "nostekon/suite-review/v1alpha1" || review.Kind != "SuiteReview" || !review.Passed || !review.Complete || !review.EvidenceMatches || len(review.Cases) != 3 {
		t.Fatalf("unexpected suite review: %s", stdout.String())
	}
	for index, expected := range []int{0, 1, 0} {
		item := review.Cases[index]
		if item.EvaluatedExitCode == nil || *item.EvaluatedExitCode != expected || len(item.Issues) != 0 || len(item.EvidenceSHA256) != 64 {
			t.Fatalf("case %d: %+v", index, item)
		}
	}
}

func suiteFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	for _, name := range []string{"suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"} {
		data, err := os.ReadFile(filepath.Join("../../examples/suites/postgresql-policy", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return directory
}

func changeSuiteJSON(t *testing.T, directory, name string, change func(map[string]any)) {
	t.Helper()
	path := filepath.Join(directory, name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	change(value)
	data, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunSuiteGateFailsClosed(t *testing.T) {
	for _, scenario := range []struct {
		name string
		code int
	}{
		{"missing-evidence", 1}, {"partial", 1}, {"empty", 1}, {"runner-failed", 1},
		{"bad-evidence", 1}, {"non-v4", 1}, {"unrelated-failure", 1}, {"incomplete-levels", 1}, {"rto-missed", 1}, {"invariant-missed", 1},
		{"wrong-order", 2}, {"missing-observed", 2}, {"wrong-kind", 2}, {"contradictory-passed", 2},
		{"symlink", 2}, {"oversized-summary", 2}, {"invalid-utf8", 2},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			directory := suiteFixture(t)
			switch scenario.name {
			case "missing-evidence":
				if err := os.Remove(filepath.Join(directory, "tail-loss.drillrun.json")); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				path := filepath.Join(directory, "tail-loss.drillrun.json")
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("zero-loss.drillrun.json", path); err != nil {
					t.Fatal(err)
				}
			case "oversized-summary", "invalid-utf8":
				data := bytes.Repeat([]byte(" "), 64*1024+1)
				if scenario.name == "invalid-utf8" {
					data = []byte{255}
				}
				if err := os.WriteFile(filepath.Join(directory, "suite.json"), data, 0o600); err != nil {
					t.Fatal(err)
				}
			case "bad-evidence":
				if err := os.WriteFile(filepath.Join(directory, "zero-loss.drillrun.json"), []byte("{}"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "non-v4":
				changeSuiteJSON(t, directory, "zero-loss.drillrun.json", func(value map[string]any) { value["spec"].(map[string]any)["upTo"] = "V3" })
			case "unrelated-failure":
				changeSuiteJSON(t, directory, "tail-loss.drillrun.json", func(value map[string]any) {
					value["status"].(map[string]any)["checks"].([]any)[0].(map[string]any)["passed"] = false
				})
			case "incomplete-levels":
				changeSuiteJSON(t, directory, "tail-loss.drillrun.json", func(value map[string]any) {
					checks := value["status"].(map[string]any)["checks"].([]any)
					kept := []any{}
					for _, check := range checks {
						if check.(map[string]any)["level"] != "V2" {
							kept = append(kept, check)
						}
					}
					value["status"].(map[string]any)["checks"] = kept
				})
			case "rto-missed":
				changeSuiteJSON(t, directory, "tail-loss.drillrun.json", func(value map[string]any) {
					value["spec"].(map[string]any)["objectives"].(map[string]any)["rtoSeconds"] = 0
				})
			case "invariant-missed":
				changeSuiteJSON(t, directory, "tail-loss.drillrun.json", func(value map[string]any) {
					checks := value["status"].(map[string]any)["checks"].([]any)
					for _, check := range checks {
						if check.(map[string]any)["level"] == "V4" {
							check.(map[string]any)["passed"] = false
						}
					}
				})
			default:
				changeSuiteJSON(t, directory, "suite.json", func(value map[string]any) {
					cases := value["cases"].([]any)
					switch scenario.name {
					case "partial":
						value["status"], value["passed"], value["cases"] = "interrupted", false, cases[:1]
					case "empty":
						value["status"], value["passed"], value["cases"] = "running", false, []any{}
					case "runner-failed":
						value["status"], value["passed"] = "failed", false
					case "wrong-order":
						cases[0], cases[1] = cases[1], cases[0]
					case "missing-observed":
						delete(cases[0].(map[string]any), "observedExitCode")
					case "wrong-kind":
						value["kind"] = "wrong"
					case "contradictory-passed":
						value["status"] = "failed"
					}
				})
			}
			var stdout, stderr bytes.Buffer
			code := Run([]string{"--suite", directory}, &stdout, &stderr)
			if code != scenario.code {
				t.Fatalf("exit=%d want=%d stderr=%s stdout=%s", code, scenario.code, stderr.String(), stdout.String())
			}
			if scenario.code == 1 {
				var review struct {
					Passed bool `json:"passed"`
				}
				if err := json.Unmarshal(stdout.Bytes(), &review); err != nil || review.Passed {
					t.Fatalf("invalid failed review: %s (%v)", stdout.String(), err)
				}
			} else if stdout.Len() != 0 || stderr.Len() == 0 {
				t.Fatalf("invalid input must not emit a success report")
			}
		})
	}
}

func TestRunSuiteGateComparesEveryMeasurement(t *testing.T) {
	for _, field := range []string{"acknowledged", "recovered", "lost", "holes", "unexpected", "seconds", "objectiveSeconds", "met"} {
		t.Run(field, func(t *testing.T) {
			directory := suiteFixture(t)
			changeSuiteJSON(t, directory, "suite.json", func(value map[string]any) {
				measurement := value["cases"].([]any)[0].(map[string]any)["rpo"].(map[string]any)
				if field == "met" {
					measurement[field] = false
				} else {
					measurement[field] = measurement[field].(float64) + 1
				}
			})
			var stdout, stderr bytes.Buffer
			if code := Run([]string{"--suite", directory}, &stdout, &stderr); code != 1 || !strings.Contains(stdout.String(), field+" differs") {
				t.Fatalf("exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunSuiteModeRejectsSingleRunOptions(t *testing.T) {
	for _, args := range [][]string{{"--attestation", "sidecar.json", "--trusted-key", "key.pem"}, {"--pushgateway-url", "http://127.0.0.1:1"}, {"--pushgateway-job", "other"}, {"--pushgateway-instance", "other"}} {
		var stdout, stderr bytes.Buffer
		code := Run(append(append([]string{"--suite"}, args...), "../../examples/suites/postgresql-policy"), &stdout, &stderr)
		if code != 2 || stdout.Len() != 0 {
			t.Fatalf("flags=%v exit=%d output=%s", args, code, stdout.String())
		}
	}
}

func suiteArchive(t *testing.T, change func(map[string]any, map[string][]byte), extra ...zip.FileHeader) string {
	t.Helper()
	files := make(map[string][]byte)
	descriptors := []map[string]any{}
	for _, name := range []string{"suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"} {
		data, err := os.ReadFile(filepath.Join("../../examples/suites/postgresql-policy", name))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = data
		digest := sha256.Sum256(data)
		descriptors = append(descriptors, map[string]any{"name": name, "size": len(data), "sha256": hex.EncodeToString(digest[:])})
	}
	manifest := map[string]any{"apiVersion": "nostekon/evidence-bundle/v1alpha1", "kind": "LabEvidenceBundle", "job": map[string]any{"id": strings.Repeat("a", 24), "status": "completed", "completedAt": "2026-10-07T12:00:00Z"}, "files": descriptors, "missingArtifacts": []string{}}
	if change != nil {
		change(manifest, files)
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files["manifest.json"] = data
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	for name, source := range files {
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(source); err != nil {
			t.Fatal(err)
		}
	}
	for _, header := range extra {
		entry, err := archive.CreateHeader(&header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte("extra")); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "evidence.zip")
	if err := os.WriteFile(path, output.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunSuiteGateReadsPortableBundle(t *testing.T) {
	var zipped, directory, stderr bytes.Buffer
	path := suiteArchive(t, nil)
	if code := Run([]string{"--suite", path}, &zipped, &stderr); code != 0 {
		t.Fatalf("ZIP exit=%d stderr=%s", code, stderr.String())
	}
	if code := Run([]string{"--suite", "../../examples/suites/postgresql-policy"}, &directory, &stderr); code != 0 {
		t.Fatalf("directory exit=%d stderr=%s", code, stderr.String())
	}
	if !bytes.Equal(zipped.Bytes(), directory.Bytes()) {
		t.Fatalf("ZIP and directory reviews differ")
	}
}

func TestRunSuiteGateRejectsUnsafeBundles(t *testing.T) {
	for _, scenario := range []string{"checksum", "size", "missing-declaration", "overlap", "duplicate-descriptor", "recovery", "active", "wrong-version", "oversized", "invalid-utf8", "traversal", "absolute", "ledger", "duplicate-entry", "compression"} {
		t.Run(scenario, func(t *testing.T) {
			extra := []zip.FileHeader{}
			if scenario == "duplicate-entry" {
				extra = append(extra, zip.FileHeader{Name: "suite.json", Method: zip.Store})
			}
			if scenario == "compression" {
				extra = append(extra, zip.FileHeader{Name: "budget-loss.drillrun.json", Method: zip.Deflate})
			}
			path := suiteArchive(t, func(manifest map[string]any, files map[string][]byte) {
				descriptors := manifest["files"].([]map[string]any)
				switch scenario {
				case "checksum":
					files["suite.json"] = append(files["suite.json"], byte(' '))
				case "size":
					descriptors[0]["size"] = 1
				case "missing-declaration":
					delete(files, "budget-loss.drillrun.json")
					manifest["files"] = descriptors[:3]
				case "overlap":
					manifest["missingArtifacts"] = []string{"suite.json"}
				case "duplicate-descriptor":
					manifest["files"] = append(descriptors[:3], descriptors[0])
				case "recovery":
					manifest["job"].(map[string]any)["recoveryRequired"] = true
				case "active":
					manifest["job"].(map[string]any)["status"] = "running"
				case "wrong-version":
					manifest["apiVersion"] = "unknown"
				case "oversized":
					files["suite.json"] = bytes.Repeat([]byte(" "), 64*1024+1)
				case "invalid-utf8":
					files["suite.json"] = []byte{255}
				case "traversal", "absolute", "ledger":
					delete(files, "budget-loss.drillrun.json")
					name := "../suite.json"
					if scenario == "absolute" {
						name = "/suite.json"
					}
					if scenario == "ledger" {
						name = "zero-loss.drillrun.json.ledger.db"
					}
					files[name] = []byte("private")
				case "duplicate-entry", "compression":
					delete(files, "budget-loss.drillrun.json")
				}
			}, extra...)
			var stdout, stderr bytes.Buffer
			if code := Run([]string{"--suite", path}, &stdout, &stderr); code != 2 || stdout.Len() != 0 || stderr.Len() == 0 {
				t.Fatalf("exit=%d stderr=%s stdout=%s", code, stderr.String(), stdout.String())
			}
		})
	}
}

func TestRunSuiteGateReportsExplicitPartialBundle(t *testing.T) {
	path := suiteArchive(t, func(manifest map[string]any, files map[string][]byte) {
		delete(files, "budget-loss.drillrun.json")
		manifest["files"] = manifest["files"].([]map[string]any)[:3]
		manifest["missingArtifacts"] = []string{"budget-loss.drillrun.json"}
	})
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"--suite", path}, &stdout, &stderr); code != 1 || !strings.Contains(stdout.String(), "Missing evidence: budget-loss.drillrun.json") {
		t.Fatalf("exit=%d stderr=%s stdout=%s", code, stderr.String(), stdout.String())
	}
}

func TestRunWritesVerifiedReport(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"../../examples/runs/mlflow-namespace-loss.run.json"}, &stdout, &stderr)
	var report struct {
		Verdict string `json:"verdict"`
		RPO     struct {
			Seconds float64 `json:"seconds"`
			Lost    int     `json:"lost"`
		} `json:"rpo"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report %s: %v", stdout.String(), err)
	}
	if code != 0 || report.Verdict != "verified" || report.RPO.Seconds != 38 || report.RPO.Lost != 75 || stderr.Len() > 0 {
		t.Fatalf("exit=%d report=%+v stderr=%s", code, report, stderr.String())
	}
}

func TestRunReportVerifiesDetachedAttestation(t *testing.T) {
	directory := t.TempDir()
	privatePath := directory + "/private.pem"
	publicPath := directory + "/public.pem"
	sidecarPath := directory + "/run.attestation.json"
	if err := attest.WriteKeyPair(privatePath, publicPath); err != nil {
		t.Fatal(err)
	}
	evidence, err := os.ReadFile("../../examples/runs/mlflow-namespace-loss.run.json")
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := attest.LoadPrivateKey(privatePath)
	if err != nil {
		t.Fatal(err)
	}
	sidecar, err := attest.Sign(evidence, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := attest.WriteSidecar(sidecarPath, sidecar); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run([]string{"--attestation", sidecarPath, "--trusted-key", publicPath, "../../examples/runs/mlflow-namespace-loss.run.json"}, &stdout, &stderr)
	var report struct {
		Verdict    string `json:"verdict"`
		Provenance struct {
			Status         string `json:"status"`
			KeyID          string `json:"keyId"`
			EvidenceSHA256 string `json:"evidenceSHA256"`
		} `json:"provenance"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v; output=%s", err, stdout.String())
	}
	if code != 0 || report.Verdict != "verified" || report.Provenance.Status != "verified" || report.Provenance.KeyID != sidecar.KeyID || report.Provenance.EvidenceSHA256 != sidecar.EvidenceSHA256 || stderr.Len() > 0 {
		t.Fatalf("exit=%d report=%+v stderr=%s", code, report, stderr.String())
	}
}

func TestRunReportRejectsInvalidAttestationAndMarksUnsignedReport(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"../../examples/runs/mlflow-namespace-loss.run.json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("unsigned report exit=%d stderr=%s", code, stderr.String())
	}
	var unsigned struct {
		Provenance struct {
			Status string `json:"status"`
		} `json:"provenance"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &unsigned); err != nil || unsigned.Provenance.Status != "unverified" {
		t.Fatalf("unsigned provenance=%+v err=%v output=%s", unsigned.Provenance, err, stdout.String())
	}

	directory := t.TempDir()
	privatePath := directory + "/private.pem"
	publicPath := directory + "/public.pem"
	sidecarPath := directory + "/invalid.attestation.json"
	if err := attest.WriteKeyPair(privatePath, publicPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sidecarPath, []byte(`{"apiVersion":"wrong"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	code := Run([]string{"--attestation", sidecarPath, "--trusted-key", publicPath, "../../examples/runs/mlflow-namespace-loss.run.json"}, &stdout, &stderr)
	if code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "unsupported attestation apiVersion") {
		t.Fatalf("invalid attestation exit=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
}

func TestRunExitCodesForFailedAndVerified(t *testing.T) {
	for _, tc := range []struct {
		file string
		want int
	}{
		{"../../examples/runs/crud-cluster-loss.run.json", 1},
		{"../../examples/runs/mlflow-namespace-loss.run.json", 0},
	} {
		t.Run(tc.file, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Run([]string{tc.file}, &stdout, &stderr)
			if code != tc.want {
				t.Fatalf("exit = %d, want %d; report=%s stderr=%s", code, tc.want, stdout.String(), stderr.String())
			}
		})
	}
}

func TestRunExitsTwoForIncompleteReport(t *testing.T) {
	const evidence = `{"apiVersion":"nostekon/v1alpha1","kind":"DrillRun","metadata":{"name":"incomplete"},"spec":{"upTo":"V2"},"status":{"failureAt":"2026-10-01T10:00:00Z","completedAt":"2026-10-01T10:00:30Z","checks":[{"level":"V0","name":"backup","passed":true},{"level":"V2","name":"health","passed":true}]}}`
	file := t.TempDir() + "/incomplete.json"
	if err := os.WriteFile(file, []byte(evidence), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run([]string{file}, &stdout, &stderr)
	var report struct {
		Verdict string `json:"verdict"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report %s: %v", stdout.String(), err)
	}
	if code != 2 || report.Verdict != "incomplete" {
		t.Fatalf("exit=%d verdict=%s report=%s stderr=%s", code, report.Verdict, stdout.String(), stderr.String())
	}
}

func TestRunValidatesEvidenceAndUsage(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := Run(nil, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "usage:") {
		t.Fatalf("usage exit=%d stderr=%q", code, stderr.String())
	}
	stderr.Reset()
	file := t.TempDir() + "/invalid.json"
	if err := os.WriteFile(file, []byte(`{"kind":"DrillRun"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := Run([]string{file}, &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "apiVersion:") {
		t.Fatalf("invalid evidence exit=%d stderr=%q", code, stderr.String())
	}
}

func TestRunPushesMetricsToThePushgatewayUnderTheEvidenceName(t *testing.T) {
	var gotPath, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		body, _ := io.ReadAll(request.Body)
		gotBody = string(body)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	code := Run([]string{"--pushgateway-url", server.URL, "../../examples/runs/mlflow-namespace-loss.run.json"}, &stdout, &stderr)
	if code != 0 || stderr.Len() > 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if gotPath != "/metrics/job/nostekon/instance/mlflow-namespace-loss-20261001" {
		t.Errorf("pushgateway path = %s", gotPath)
	}
	if !strings.Contains(gotBody, "nostekon_drill_verified 1") {
		t.Errorf("pushgateway body missing verified sample: %s", gotBody)
	}
}

func TestRunStillReportsAndKeepsItsExitCodeWhenThePushgatewayIsUnreachable(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"--pushgateway-url", "http://127.0.0.1:1", "--pushgateway-job", "ci", "--pushgateway-instance", "nightly", "../../examples/runs/crud-cluster-loss.run.json"}, &stdout, &stderr)
	var report struct {
		Verdict string `json:"verdict"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v; output=%s", err, stdout.String())
	}
	if code != 1 || report.Verdict != "failed" {
		t.Fatalf("exit=%d verdict=%s, want the report's own verdict regardless of the push", code, report.Verdict)
	}
	if !strings.Contains(stderr.String(), "push metrics:") {
		t.Fatalf("stderr = %q, want a warning that the push failed", stderr.String())
	}
}
