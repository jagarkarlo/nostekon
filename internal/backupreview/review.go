package backupreview

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jagarkarlo/nostekon/internal/verify"
)

const MaxPlanBytes = 16 << 10

type archive struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type reference struct {
	Table  string `json:"table"`
	Column string `json:"column"`
}

type invariant struct {
	Name      string     `json:"name"`
	Type      string     `json:"type"`
	Table     string     `json:"table"`
	Column    string     `json:"column"`
	Reference *reference `json:"reference,omitempty"`
}

type plan struct {
	APIVersion     string           `json:"apiVersion"`
	Kind           string           `json:"kind"`
	Backup         archive          `json:"backup"`
	ImageID        string           `json:"imageId"`
	Tables         map[string]int64 `json:"tables"`
	TimeoutSeconds int              `json:"timeoutSeconds"`
	Invariants     []invariant      `json:"invariants,omitempty"`
}

type Review struct {
	APIVersion      string            `json:"apiVersion"`
	Kind            string            `json:"kind"`
	Passed          bool              `json:"passed"`
	Complete        bool              `json:"complete"`
	EvidenceMatches bool              `json:"evidenceMatches"`
	PlanSHA256      string            `json:"planSHA256"`
	PlanFileSHA256  string            `json:"planFileSHA256"`
	EvidenceSHA256  string            `json:"evidenceSHA256"`
	Provenance      verify.Provenance `json:"provenance"`
	Report          verify.Report     `json:"report"`
	Issues          []string          `json:"issues"`
}

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var identifier = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)
var ruleName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
var countDetail = regexp.MustCompile(`^expected ([0-9]{1,19}); measured ([0-9]{1,19})$`)
var violationDetail = regexp.MustCompile(`^measured violations: ([0-9]{1,19}); expected 0$`)

func digest(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func validTable(table string) bool {
	parts := strings.Split(table, ".")
	return len(parts) == 2 && identifier.MatchString(parts[0]) && identifier.MatchString(parts[1]) && parts[0] != "information_schema" && !strings.HasPrefix(parts[0], "pg_")
}

func exactFields(data []byte, names ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || len(fields) != len(names) {
		return false
	}
	for _, name := range names {
		value, present := fields[name]
		if !present || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

func uniqueJSON(decoder *json.Decoder, depth int) error {
	if depth > 16 {
		return errors.New("JSON nesting exceeds safety limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			seen := map[string]bool{}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate or invalid JSON field")
				}
				seen[name] = true
				if err := uniqueJSON(decoder, depth+1); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := uniqueJSON(decoder, depth+1); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		_, err = decoder.Token()
	}
	return err
}

func parsePlan(data []byte) (plan, string, error) {
	var restored plan
	if len(data) == 0 || len(data) > MaxPlanBytes || !utf8.Valid(data) {
		return restored, "", errors.New("restore plan must be UTF-8 within 16 KiB")
	}
	checked := json.NewDecoder(bytes.NewReader(data))
	checked.UseNumber()
	if err := uniqueJSON(checked, 0); err != nil {
		return restored, "", err
	}
	if _, err := checked.Token(); !errors.Is(err, io.EOF) {
		return restored, "", errors.New("restore plan must contain one JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&restored); err != nil {
		return restored, "", err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return restored, "", err
	}
	version2 := restored.APIVersion == "nostekon/restore-plan/v2alpha1"
	expectedFields := 6
	if version2 {
		expectedFields++
	}
	required := []string{"apiVersion", "kind", "backup", "imageId", "tables", "timeoutSeconds"}
	if version2 {
		required = append(required, "invariants")
	}
	if !exactFields(data, required...) || !exactFields(fields["backup"], "sha256", "bytes") {
		return restored, "", errors.New("restore plan requires exact non-null fields")
	}
	if len(fields) != expectedFields || restored.Kind != "PostgreSQLRestorePlan" || !version2 && restored.APIVersion != "nostekon/restore-plan/v1alpha1" {
		return restored, "", errors.New("unsupported restore plan version, kind or fields")
	}
	if !digestPattern.MatchString(restored.Backup.SHA256) || restored.Backup.Bytes < 5 || restored.Backup.Bytes > 64<<20 || !strings.HasPrefix(restored.ImageID, "sha256:") || !digestPattern.MatchString(strings.TrimPrefix(restored.ImageID, "sha256:")) || restored.Tables == nil || len(restored.Tables) > 20 || restored.TimeoutSeconds < 30 || restored.TimeoutSeconds > 1800 {
		return restored, "", errors.New("invalid restore plan archive, image, tables or timeout")
	}
	var rawTables map[string]json.RawMessage
	if err := json.Unmarshal(fields["tables"], &rawTables); err != nil {
		return restored, "", err
	}
	for table, count := range restored.Tables {
		if !validTable(table) || count < 0 || bytes.Equal(bytes.TrimSpace(rawTables[table]), []byte("null")) {
			return restored, "", errors.New("invalid restore plan table expectation")
		}
	}
	if !version2 {
		if _, present := fields["invariants"]; present {
			return restored, "", errors.New("v1 restore plan cannot declare invariants")
		}
	} else {
		if len(restored.Invariants) < 1 || len(restored.Invariants) > 20 || len(restored.Tables) == 0 {
			return restored, "", errors.New("semantic restore plan requires counts and 1..20 invariants")
		}
		var rawRules []map[string]json.RawMessage
		if err := json.Unmarshal(fields["invariants"], &rawRules); err != nil {
			return restored, "", err
		}
		seen := map[string]bool{}
		for index, rule := range restored.Invariants {
			foreign := rule.Type == "foreign_key"
			_, hasReference := rawRules[index]["reference"]
			fieldCount := 4
			if foreign {
				fieldCount++
			}
			ruleFields := []string{"name", "type", "table", "column"}
			if foreign {
				ruleFields = append(ruleFields, "reference")
				if !exactFields(rawRules[index]["reference"], "table", "column") {
					return restored, "", errors.New("foreign-key reference requires exact non-null fields")
				}
			}
			ruleData, err := json.Marshal(rawRules[index])
			if err != nil || !exactFields(ruleData, ruleFields...) {
				return restored, "", errors.New("invariant requires exact non-null fields")
			}
			if len(rawRules[index]) != fieldCount || !ruleName.MatchString(rule.Name) || seen[rule.Name] || !validTable(rule.Table) || !identifier.MatchString(rule.Column) || rule.Type != "not_null" && rule.Type != "unique" && !foreign || hasReference != foreign || foreign && (rule.Reference == nil || !validTable(rule.Reference.Table) || !identifier.MatchString(rule.Reference.Column)) {
				return restored, "", errors.New("invalid or duplicate restore plan invariant")
			}
			seen[rule.Name] = true
		}
	}
	typed, err := json.Marshal(restored)
	if err != nil {
		return restored, "", err
	}
	canonicalDecoder := json.NewDecoder(bytes.NewReader(typed))
	canonicalDecoder.UseNumber()
	var canonicalFields map[string]any
	if err := canonicalDecoder.Decode(&canonicalFields); err != nil {
		return restored, "", err
	}
	canonical, err := json.Marshal(canonicalFields)
	return restored, digest(canonical), err
}

func Evaluate(planData, evidenceData []byte) (Review, error) {
	restored, identity, err := parsePlan(planData)
	if err != nil {
		return Review{}, fmt.Errorf("decode restore plan: %w", err)
	}
	if len(evidenceData) > 16<<20 || !utf8.Valid(evidenceData) {
		return Review{}, errors.New("evidence must be UTF-8 within 16 MiB")
	}
	checked := json.NewDecoder(bytes.NewReader(evidenceData))
	checked.UseNumber()
	if err := uniqueJSON(checked, 0); err != nil {
		return Review{}, fmt.Errorf("decode evidence: %w", err)
	}
	evidence, err := verify.ParseEvidence(evidenceData)
	if err != nil {
		return Review{}, err
	}
	review := Review{
		APIVersion: "nostekon/backup-review/v1alpha1", Kind: "PostgreSQLBackupReview",
		PlanSHA256: identity, PlanFileSHA256: digest(planData), EvidenceSHA256: digest(evidenceData),
		Provenance: verify.Provenance{Status: "unverified"}, Report: verify.Build(evidence), Issues: []string{},
	}
	type expectedCheck struct{ level, detail string }
	expected := map[string]expectedCheck{
		"Frozen custom archive":         {"V0", fmt.Sprintf("SHA-256 %s; %d bytes", restored.Backup.SHA256, restored.Backup.Bytes)},
		"Pinned local PostgreSQL image": {"V0", restored.ImageID},
		"Restore plan binding":          {"V0", "Canonical plan SHA-256 " + identity + "; backup and image matched; not operator approval or authenticated provenance"},
		"Archive restore completed":     {"V1", "pg_restore --exit-on-error --single-transaction"},
		"Restored database query":       {"V2", "SELECT 1 returned 1; not an application-health proof"},
		"Isolated target removed":       {"V2", evidence.Metadata.Name},
	}
	rules := map[string]invariant{}
	declared := []string{}
	for _, rule := range restored.Invariants {
		rules[rule.Name] = rule
		declared = append(declared, rule.Name)
	}
	seen := map[string]int{}
	missing := false
	for _, level := range review.Report.Levels {
		for _, check := range level.Checks {
			if check.Source != "reported" {
				continue
			}
			seen[check.Name]++
			if want, found := expected[check.Name]; found {
				if level.ID != want.level || check.Detail != want.detail || !check.Passed {
					review.Issues = append(review.Issues, "captured "+check.Name+" does not match the restore plan contract")
				}
				continue
			}
			if strings.HasPrefix(check.Name, "Row count: ") {
				table := strings.TrimPrefix(check.Name, "Row count: ")
				want, found := restored.Tables[table]
				counts := countDetail.FindStringSubmatch(check.Detail)
				if !found || level.ID != "V3" || len(counts) != 3 {
					missing = true
					review.Issues = append(review.Issues, "unexpected or malformed table-count check: "+check.Name)
					continue
				}
				expectedCount, expectedErr := strconv.ParseInt(counts[1], 10, 64)
				measured, measuredErr := strconv.ParseInt(counts[2], 10, 64)
				if expectedErr != nil || measuredErr != nil {
					missing = true
				}
				if expectedErr != nil || measuredErr != nil || expectedCount != want || check.Passed != (measured == want) {
					review.Issues = append(review.Issues, "table measurement contradicts its plan or pass flag: "+table)
				}
				continue
			}
			if rule, found := rules[check.Name]; found {
				description := rule.Type + ": " + rule.Table + "." + rule.Column
				if rule.Reference != nil {
					description += " -> " + rule.Reference.Table + "." + rule.Reference.Column
				}
				prefix := description + "; "
				measurement := violationDetail.FindStringSubmatch(strings.TrimPrefix(check.Detail, prefix))
				if level.ID != "V4" || !strings.HasPrefix(check.Detail, prefix) {
					missing = true
					review.Issues = append(review.Issues, "semantic rule scope does not match the plan: "+rule.Name)
					continue
				}
				if len(measurement) == 2 {
					violations, measureErr := strconv.ParseInt(measurement[1], 10, 64)
					if measureErr != nil {
						missing = true
					}
					if measureErr != nil || check.Passed != (violations == 0) {
						review.Issues = append(review.Issues, "semantic measurement contradicts its pass flag: "+rule.Name)
					}
				} else if check.Passed || check.Detail != prefix+"query failed; no raw database output retained" && check.Detail != prefix+"not evaluated because the rehearsal did not reach validation" {
					missing = true
					review.Issues = append(review.Issues, "missing or malformed semantic measurement: "+rule.Name)
				} else {
					missing = true
				}
				continue
			}
			if check.Passed || check.Name != "Backup rehearsal error" && check.Name != "Backup rehearsal interrupted" && check.Name != "Isolated target cleanup" {
				review.Issues = append(review.Issues, "unexpected reported check: "+check.Name)
			}
		}
	}
	for name := range expected {
		if seen[name] != 1 {
			review.Issues = append(review.Issues, "captured evidence requires exactly one "+name)
			missing = true
		}
	}
	for table := range restored.Tables {
		if seen["Row count: "+table] != 1 {
			review.Issues = append(review.Issues, "missing or duplicate planned table count: "+table)
			missing = true
		}
	}
	for name := range rules {
		if seen[name] != 1 {
			review.Issues = append(review.Issues, "missing or duplicate planned semantic rule: "+name)
			missing = true
		}
	}
	if evidence.Spec.Scenario != "postgresql-backup-rehearsal" {
		review.Issues = append(review.Issues, "evidence is not a PostgreSQL backup rehearsal")
	}
	depth := "V2"
	if len(restored.Tables) > 0 {
		depth = "V3"
	}
	if len(restored.Invariants) > 0 {
		depth = "V4"
	}
	if review.Report.RequestedLevel != depth {
		review.Issues = append(review.Issues, "requested validation depth differs from the plan")
	}
	actualDeclarations := []string{}
	if evidence.Spec.V4Evidence != nil {
		actualDeclarations = evidence.Spec.V4Evidence.Invariants
	}
	if !slices.Equal(actualDeclarations, declared) || evidence.Status.Ledger != nil || evidence.Spec.Objectives != nil {
		review.Issues = append(review.Issues, "semantic declarations, ledger or objectives differ from the backup plan")
	}
	review.Complete = !missing && review.Report.Verdict != verify.Incomplete
	review.EvidenceMatches = len(review.Issues) == 0
	review.Passed = review.Complete && review.EvidenceMatches && review.Report.Verdict == verify.Verified
	slices.Sort(review.Issues)
	return review, nil
}
