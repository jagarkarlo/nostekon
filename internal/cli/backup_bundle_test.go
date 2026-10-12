package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/jagarkarlo/nostekon/internal/backupreview"
)

func TestBackupBundleCLIRoundTrip(t *testing.T) {
	plan := "../../studio/e2e/postgresql-semantic-rehearsal.plan.json"
	run := "../../studio/e2e/postgresql-semantic-rehearsal.run.json"
	var archive, expected, stderr bytes.Buffer
	if code := Run([]string{"--backup-plan", plan, run}, &expected, &stderr); code != 1 {
		t.Fatalf("review exit=%d %s", code, &stderr)
	}
	if code := Run([]string{"--backup-plan", plan, "--export-backup-bundle", run}, &archive, &stderr); code != 1 || archive.Len() == 0 {
		t.Fatalf("export exit=%d %s", code, &stderr)
	}
	path := filepath.Join(t.TempDir(), "capture.zip")
	if err := os.WriteFile(path, archive.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	var imported bytes.Buffer
	if code := Run([]string{"--backup-bundle", path}, &imported, &stderr); code != 1 || !bytes.Equal(imported.Bytes(), expected.Bytes()) {
		t.Fatalf("import exit=%d %s %s", code, &stderr, &imported)
	}
	var review backupreview.Review
	if json.Unmarshal(imported.Bytes(), &review) != nil || !review.Complete || !review.EvidenceMatches || review.Passed || review.Provenance.Status != "unverified" {
		t.Fatal("measured failure or unverified provenance lost")
	}
	for _, args := range [][]string{
		{"--export-backup-bundle", run},
		{"--backup-bundle", "--backup-plan", plan, path},
		{"--backup-bundle", "--suite", path},
		{"--backup-bundle", "--pushgateway-job", "other", path},
		{"--backup-bundle", "--export-backup-bundle", path},
		{"--backup-bundle", run},
	} {
		var stdout, stderr bytes.Buffer
		if code := Run(args, &stdout, &stderr); code != 2 || stdout.Len() != 0 {
			t.Fatalf("args=%v exit=%d %s", args, code, &stderr)
		}
	}
}
