package backupreview

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"unicode/utf8"
)

type PreflightCheck struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail"`
}

type Preflight struct {
	APIVersion     string           `json:"apiVersion"`
	Kind           string           `json:"kind"`
	Passed         bool             `json:"passed"`
	BackupMatches  bool             `json:"backupMatches"`
	Backup         archive          `json:"backup"`
	PlanSHA256     string           `json:"planSHA256"`
	ImageID        string           `json:"imageId"`
	RequestedLevel string           `json:"requestedLevel"`
	Checks         []PreflightCheck `json:"checks"`
	Limitations    []string         `json:"limitations"`
}

type PreflightReview struct {
	APIVersion         string           `json:"apiVersion"`
	Kind               string           `json:"kind"`
	Passed             bool             `json:"passed"`
	PlanMatches        bool             `json:"planMatches"`
	BackupMatches      bool             `json:"backupMatches"`
	PlanSHA256         string           `json:"planSHA256"`
	PlanFileSHA256     string           `json:"planFileSHA256"`
	PreflightSHA256    string           `json:"preflightSHA256"`
	ObservedPlanSHA256 string           `json:"observedPlanSHA256"`
	ObservedBackup     archive          `json:"observedBackup"`
	ObservedImageID    string           `json:"observedImageId"`
	RequestedLevel     string           `json:"requestedLevel"`
	Checks             []PreflightCheck `json:"checks"`
	Limitations        []string         `json:"limitations"`
	Issues             []string         `json:"issues"`
}

func ParsePreflight(data []byte) (Preflight, error) {
	var preflight Preflight
	if len(data) == 0 || len(data) > MaxPlanBytes || !utf8.Valid(data) {
		return preflight, errors.New("backup preflight must be UTF-8 within 16 KiB")
	}
	checked := json.NewDecoder(bytes.NewReader(data))
	checked.UseNumber()
	if err := uniqueJSON(checked, 0); err != nil {
		return preflight, err
	}
	if _, err := checked.Token(); !errors.Is(err, io.EOF) {
		return preflight, errors.New("backup preflight must contain one JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&preflight); err != nil {
		return preflight, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return preflight, err
	}
	required := []string{"apiVersion", "kind", "passed", "backupMatches", "backup", "planSHA256", "imageId", "requestedLevel", "checks", "limitations"}
	if !exactFields(data, required...) || !exactFields(fields["backup"], "sha256", "bytes") {
		return preflight, errors.New("backup preflight requires exact non-null fields")
	}
	if preflight.APIVersion != "nostekon/backup-preflight/v1alpha1" || preflight.Kind != "PostgreSQLBackupPreflight" {
		return preflight, errors.New("unsupported backup preflight version or kind")
	}
	if !digestPattern.MatchString(preflight.Backup.SHA256) || preflight.Backup.Bytes < 5 || preflight.Backup.Bytes > 64<<20 || !digestPattern.MatchString(preflight.PlanSHA256) || !strings.HasPrefix(preflight.ImageID, "sha256:") || !digestPattern.MatchString(strings.TrimPrefix(preflight.ImageID, "sha256:")) || preflight.RequestedLevel != "V2" && preflight.RequestedLevel != "V3" && preflight.RequestedLevel != "V4" {
		return preflight, errors.New("invalid backup preflight archive, plan digest, image or requested level")
	}
	var rawChecks []map[string]json.RawMessage
	if err := json.Unmarshal(fields["checks"], &rawChecks); err != nil || len(preflight.Checks) == 0 || len(preflight.Checks) > 10 {
		return preflight, errors.New("backup preflight requires 1..10 checks")
	}
	seen := map[string]bool{}
	for index, check := range preflight.Checks {
		checkData, err := json.Marshal(rawChecks[index])
		if err != nil || !exactFields(checkData, "name", "passed", "detail") || !ruleName.MatchString(check.Name) || seen[check.Name] || strings.TrimSpace(check.Detail) == "" || len(check.Detail) > 256 {
			return preflight, fmt.Errorf("preflight check %d: invalid or duplicate check", index+1)
		}
		seen[check.Name] = true
	}
	var rawLimitations []json.RawMessage
	if err := json.Unmarshal(fields["limitations"], &rawLimitations); err != nil || len(preflight.Limitations) < 3 || len(preflight.Limitations) > 10 {
		return preflight, errors.New("backup preflight requires 3..10 limitations")
	}
	for _, item := range rawLimitations {
		if bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
			return preflight, errors.New("backup preflight limitations cannot contain null")
		}
	}
	for _, text := range preflight.Limitations {
		if strings.TrimSpace(text) == "" || len(text) > 256 {
			return preflight, errors.New("backup preflight limitation must be nonempty and within 256 bytes")
		}
	}
	return preflight, nil
}

func EvaluatePreflight(planData, preflightData []byte) (PreflightReview, error) {
	restored, identity, err := parsePlan(planData)
	if err != nil {
		return PreflightReview{}, fmt.Errorf("decode restore plan: %w", err)
	}
	preflight, err := ParsePreflight(preflightData)
	if err != nil {
		return PreflightReview{}, fmt.Errorf("decode backup preflight: %w", err)
	}
	expectedLevel := "V2"
	if len(restored.Tables) > 0 {
		expectedLevel = "V3"
	}
	if len(restored.Invariants) > 0 {
		expectedLevel = "V4"
	}
	review := PreflightReview{
		APIVersion:         "nostekon/preflight-review/v1alpha1",
		Kind:               "PostgreSQLPreflightReview",
		PlanSHA256:         identity,
		PlanFileSHA256:     digest(planData),
		PreflightSHA256:    digest(preflightData),
		ObservedPlanSHA256: preflight.PlanSHA256,
		ObservedBackup:     preflight.Backup,
		ObservedImageID:    preflight.ImageID,
		RequestedLevel:     expectedLevel,
		Checks:             preflight.Checks,
		Limitations:        preflight.Limitations,
		Issues:             []string{},
	}
	if preflight.PlanSHA256 != identity {
		review.Issues = append(review.Issues, "preflight planSHA256 does not match the canonical restore plan")
	}
	if preflight.ImageID != restored.ImageID {
		review.Issues = append(review.Issues, "preflight imageId does not match the restore plan")
	}
	if preflight.RequestedLevel != expectedLevel {
		review.Issues = append(review.Issues, "preflight requestedLevel does not match the restore plan")
	}
	actualMatches := preflight.Backup == restored.Backup
	if preflight.BackupMatches != actualMatches {
		review.Issues = append(review.Issues, "preflight backupMatches flag contradicts the restore plan backup digest or size")
	}
	if !actualMatches {
		review.Issues = append(review.Issues, "observed backup archive does not match the restore plan")
	}
	checkMap := map[string]PreflightCheck{}
	allChecksPassed := true
	for _, check := range preflight.Checks {
		checkMap[check.Name] = check
		if !check.Passed {
			allChecksPassed = false
		}
	}
	bindingCheck, hasBinding := checkMap["backup-plan-binding"]
	if !hasBinding {
		review.Issues = append(review.Issues, "missing required preflight check: backup-plan-binding")
	} else if bindingCheck.Passed != actualMatches {
		review.Issues = append(review.Issues, "backup-plan-binding check contradicts the restore plan backup binding")
	}
	countCheck, hasCounts := checkMap["snapshot-count-coverage"]
	expectedCounts := len(restored.Tables) > 0
	if !hasCounts {
		review.Issues = append(review.Issues, "missing required preflight check: snapshot-count-coverage")
	} else if countCheck.Passed != expectedCounts {
		review.Issues = append(review.Issues, "snapshot-count-coverage check contradicts the restore plan table expectations")
	}
	if actualMatches {
		for _, required := range []string{"local-linux-daemon", "native-pinned-image"} {
			if _, ok := checkMap[required]; !ok {
				review.Issues = append(review.Issues, "missing required host preflight check: "+required)
			}
		}
		if daemonCheck, ok := checkMap["local-linux-daemon"]; ok && daemonCheck.Passed {
			if _, hasFloor := checkMap["daemon-resource-floor"]; !hasFloor {
				review.Issues = append(review.Issues, "missing required host preflight check: daemon-resource-floor")
			}
		}
		for name := range checkMap {
			if name != "backup-plan-binding" && name != "snapshot-count-coverage" && name != "local-linux-daemon" && name != "daemon-resource-floor" && name != "native-pinned-image" {
				review.Issues = append(review.Issues, "unexpected preflight check: "+name)
			}
		}
	} else if len(preflight.Checks) != 2 || !hasBinding || !hasCounts {
		review.Issues = append(review.Issues, "mismatched backup preflight must stop before querying Docker host metadata")
	}
	expectedPassed := actualMatches && expectedCounts && allChecksPassed && len(review.Issues) == 0
	if preflight.Passed != (actualMatches && expectedCounts && allChecksPassed) {
		review.Issues = append(review.Issues, "preflight passed flag contradicts its recorded checks")
	}
	for _, check := range preflight.Checks {
		if !check.Passed {
			review.Issues = append(review.Issues, fmt.Sprintf("preflight check failed: %s (%s)", check.Name, check.Detail))
		}
	}
	slices.Sort(review.Issues)
	review.PlanMatches = preflight.PlanSHA256 == identity && preflight.ImageID == restored.ImageID && preflight.RequestedLevel == expectedLevel
	review.BackupMatches = actualMatches && hasBinding && bindingCheck.Passed
	review.Passed = expectedPassed && review.PlanMatches && review.BackupMatches && len(review.Issues) == 0
	return review, nil
}
