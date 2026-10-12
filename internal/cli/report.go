package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/jagarkarlo/nostekon/internal/attest"
	"github.com/jagarkarlo/nostekon/internal/backupreview"
	"github.com/jagarkarlo/nostekon/internal/metrics"
	"github.com/jagarkarlo/nostekon/internal/suitereview"
	"github.com/jagarkarlo/nostekon/internal/verify"
)

const maxReportInputBytes = 16 << 20

func readBackupInput(path string, limit int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() < 1 || before.Size() > limit {
		return nil, errors.New("input must be a nonempty regular file within its size limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return nil, errors.New("input changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	after, err := file.Stat()
	if err != nil || len(data) > int(limit) || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return nil, errors.New("input changed or exceeded its size limit while reading")
	}
	return data, nil
}

// Run evaluates a captured DrillRun file. The exported entry point is shared
// by the standalone command and tests.
func Run(args []string, stdout, stderr io.Writer) int {
	usage := "usage: nostekon-report [--suite | --backup-plan PLAN.json [--export-backup-bundle] | --backup-bundle] [--attestation FILE --trusted-key PUBLIC.pem] [--pushgateway-url URL [--pushgateway-job NAME] [--pushgateway-instance NAME]] <run.json | suite-directory | evidence.zip>"
	if len(args) == 0 || len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(stderr, usage)
		if len(args) == 1 {
			return 0
		}
		return 2
	}
	flags := flag.NewFlagSet("nostekon-report", flag.ContinueOnError)
	flags.SetOutput(stderr)
	suiteMode := flags.Bool("suite", false, "gate a captured PostgreSQL policy suite directory or evidence ZIP")
	backupPlanPath := flags.String("backup-plan", "", "independently gate captured backup evidence against a reviewed restore plan")
	backupBundleMode := flags.Bool("backup-bundle", false, "gate an original-only backup bundle offline with a freshly computed review")
	exportBackupBundle := flags.Bool("export-backup-bundle", false, "with --backup-plan, write a portable ZIP to stdout instead of review JSON")
	attestationPath := flags.String("attestation", "", "detached Ed25519 attestation JSON file")
	trustedKeyPath := flags.String("trusted-key", "", "trusted Ed25519 PKIX public key PEM")
	pushgatewayURL := flags.String("pushgateway-url", "", "push recovery metrics to this Prometheus Pushgateway URL")
	pushgatewayJob := flags.String("pushgateway-job", "nostekon", "Pushgateway job label")
	pushgatewayInstance := flags.String("pushgateway-instance", "", "Pushgateway instance label (defaults to the evidence name)")
	if err := flags.Parse(args); err != nil {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	if flags.NArg() != 1 || (*attestationPath == "") != (*trustedKeyPath == "") {
		fmt.Fprintln(stderr, usage)
		return 2
	}
	backupMode := false
	flags.Visit(func(option *flag.Flag) {
		if option.Name == "backup-plan" {
			backupMode = true
		}
	})
	if backupMode || *backupBundleMode || *exportBackupBundle {
		if *suiteMode || *attestationPath != "" || *pushgatewayURL != "" || *pushgatewayJob != "nostekon" || *pushgatewayInstance != "" || backupMode && *backupBundleMode || *exportBackupBundle && !backupMode {
			fmt.Fprintln(stderr, "backup modes cannot be combined or use suite, attestation or Pushgateway flags; export requires --backup-plan")
			return 2
		}
		var planData, evidenceData []byte
		var review backupreview.Review
		var err error
		if *backupBundleMode {
			var archive []byte
			archive, err = readBackupInput(flags.Arg(0), backupreview.MaxBundleBytes)
			if err == nil {
				var imported backupreview.ImportedBundle
				imported, err = backupreview.ReadBundle(archive)
				review = imported.Review
			}
		} else {
			planData, err = readBackupInput(*backupPlanPath, backupreview.MaxPlanBytes)
			if err != nil {
				fmt.Fprintf(stderr, "read backup plan: %v\n", err)
				return 2
			}
			evidenceData, err = readBackupInput(flags.Arg(0), maxReportInputBytes)
			if err != nil {
				fmt.Fprintf(stderr, "read backup evidence: %v\n", err)
				return 2
			}
			review, err = backupreview.Evaluate(planData, evidenceData)
		}
		if err != nil {
			fmt.Fprintf(stderr, "review backup: %v\n", err)
			return 2
		}
		if *exportBackupBundle {
			var archive []byte
			archive, err = backupreview.Bundle(planData, evidenceData)
			if err == nil {
				var written int
				written, err = stdout.Write(archive)
				if err == nil && written != len(archive) {
					err = io.ErrShortWrite
				}
			}
		} else {
			encoder := json.NewEncoder(stdout)
			encoder.SetIndent("", "  ")
			err = encoder.Encode(review)
		}
		if err != nil {
			fmt.Fprintf(stderr, "write backup review: %v\n", err)
			return 2
		}
		if review.Passed {
			return 0
		}
		return 1
	}
	if *suiteMode {
		if *attestationPath != "" || *pushgatewayURL != "" || *pushgatewayJob != "nostekon" || *pushgatewayInstance != "" {
			fmt.Fprintln(stderr, "suite mode cannot use per-run attestation or Pushgateway flags")
			return 2
		}
		sources, err := suitereview.Read(flags.Arg(0))
		if err != nil {
			fmt.Fprintf(stderr, "read suite: %v\n", err)
			return 2
		}
		review, err := suitereview.Evaluate(sources)
		if err != nil {
			fmt.Fprintf(stderr, "review suite: %v\n", err)
			return 2
		}
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(review); err != nil {
			fmt.Fprintf(stderr, "write suite review: %v\n", err)
			return 2
		}
		if review.Passed {
			return 0
		}
		return 1
	}
	file, err := os.Open(flags.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "open evidence: %v\n", err)
		return 1
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxReportInputBytes+1))
	if err != nil {
		fmt.Fprintf(stderr, "read evidence: %v\n", err)
		return 1
	}
	if len(data) > maxReportInputBytes {
		fmt.Fprintf(stderr, "evidence exceeds 16 MiB\n")
		return 1
	}
	evidence, err := verify.ParseEvidence(data)
	if err != nil {
		var decodeErr *verify.DecodeError
		var validationErr *verify.ValidationError
		switch {
		case errors.As(err, &decodeErr):
			fmt.Fprintln(stderr, decodeErr)
		case errors.As(err, &validationErr):
			for _, problem := range validationErr.Problems {
				fmt.Fprintf(stderr, "- %s\n", problem)
			}
		default:
			fmt.Fprintln(stderr, err)
		}
		return 2
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	report := verify.Build(evidence)
	if *attestationPath != "" {
		sidecar, err := attest.ReadSidecar(*attestationPath)
		if err != nil {
			fmt.Fprintf(stderr, "verify attestation: %v\n", err)
			return 1
		}
		trustedKey, err := attest.LoadPublicKey(*trustedKeyPath)
		if err != nil {
			fmt.Fprintf(stderr, "load trusted key: %v\n", err)
			return 1
		}
		if err := attest.Verify(data, sidecar, trustedKey); err != nil {
			fmt.Fprintf(stderr, "verify attestation: %v\n", err)
			return 1
		}
		report.Provenance = verify.Provenance{
			Status: "verified", Algorithm: sidecar.Algorithm,
			KeyID: sidecar.KeyID, EvidenceSHA256: sidecar.EvidenceSHA256,
		}
	}
	if *pushgatewayURL != "" {
		instance := *pushgatewayInstance
		if instance == "" {
			instance = evidence.Metadata.Name
		}
		if err := metrics.Push(*pushgatewayURL, *pushgatewayJob, map[string]string{"instance": instance}, metrics.FromReport(report)); err != nil {
			fmt.Fprintf(stderr, "push metrics: %v\n", err)
		}
	}
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintf(stderr, "write report: %v\n", err)
		return 1
	}
	switch report.Verdict {
	case verify.Verified:
		return 0
	case verify.Failed:
		return 1
	default:
		return 2
	}
}
