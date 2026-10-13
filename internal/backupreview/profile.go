package backupreview

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"unicode/utf8"
)

type ProfileReview struct {
	APIVersion    string      `json:"apiVersion"`
	Kind          string      `json:"kind"`
	Valid         bool        `json:"valid"`
	ProfileSHA256 string      `json:"profileSHA256"`
	Invariants    []invariant `json:"invariants"`
	Tables        []string    `json:"tables"`
	Warnings      []string    `json:"warnings"`
	Limitations   []string    `json:"limitations"`
}

func validateInvariants(data json.RawMessage, rules []invariant) error {
	if len(rules) < 1 || len(rules) > 20 {
		return errors.New("profile requires 1..20 invariants")
	}
	var rawRules []map[string]json.RawMessage
	if err := json.Unmarshal(data, &rawRules); err != nil {
		return err
	}
	seen := map[string]bool{}
	for index, rule := range rules {
		foreign := rule.Type == "foreign_key"
		_, hasReference := rawRules[index]["reference"]
		ruleFields := []string{"name", "type", "table", "column"}
		if foreign {
			ruleFields = append(ruleFields, "reference")
			if !exactFields(rawRules[index]["reference"], "table", "column") {
				return fmt.Errorf("rule %d: reference requires exact non-null table and column", index+1)
			}
		}
		ruleData, err := json.Marshal(rawRules[index])
		if err != nil || !exactFields(ruleData, ruleFields...) {
			return fmt.Errorf("rule %d: requires exact non-null fields", index+1)
		}
		if !ruleName.MatchString(rule.Name) || seen[rule.Name] || !validTable(rule.Table) || !identifier.MatchString(rule.Column) || rule.Type != "not_null" && rule.Type != "unique" && !foreign || hasReference != foreign || foreign && (rule.Reference == nil || !validTable(rule.Reference.Table) || !identifier.MatchString(rule.Reference.Column)) {
			return fmt.Errorf("rule %d: invalid or duplicate invariant", index+1)
		}
		seen[rule.Name] = true
	}
	return nil
}

func InspectProfile(data []byte) (ProfileReview, error) {
	if len(data) == 0 || len(data) > MaxPlanBytes || !utf8.Valid(data) {
		return ProfileReview{}, errors.New("validation profile must be UTF-8 within 16 KiB")
	}
	checked := json.NewDecoder(bytes.NewReader(data))
	checked.UseNumber()
	if err := uniqueJSON(checked, 0); err != nil {
		return ProfileReview{}, err
	}
	if _, err := checked.Token(); !errors.Is(err, io.EOF) {
		return ProfileReview{}, errors.New("validation profile must contain one JSON value")
	}
	var profile struct {
		APIVersion string      `json:"apiVersion"`
		Kind       string      `json:"kind"`
		Invariants []invariant `json:"invariants"`
	}
	if err := json.Unmarshal(data, &profile); err != nil {
		return ProfileReview{}, err
	}
	if !exactFields(data, "apiVersion", "kind", "invariants") || profile.APIVersion != "nostekon/validation-profile/v1alpha1" || profile.Kind != "PostgreSQLValidationProfile" {
		return ProfileReview{}, errors.New("unsupported validation profile version, kind or fields")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return ProfileReview{}, err
	}
	if err := validateInvariants(fields["invariants"], profile.Invariants); err != nil {
		return ProfileReview{}, err
	}
	review := ProfileReview{
		APIVersion: "nostekon/profile-review/v1alpha1", Kind: "PostgreSQLProfileReview", Valid: true,
		ProfileSHA256: digest(data), Invariants: profile.Invariants, Tables: []string{}, Warnings: []string{},
		Limitations: []string{"Data not measured", "Snapshot counts not supplied", "Owner approval unverified"},
	}
	coverage := map[string]map[string]bool{}
	tables := map[string]bool{}
	for _, rule := range profile.Invariants {
		key := rule.Table + "." + rule.Column
		if coverage[key] == nil {
			coverage[key] = map[string]bool{}
		}
		coverage[key][rule.Type] = true
		tables[rule.Table] = true
		if rule.Reference != nil {
			tables[rule.Reference.Table] = true
		}
	}
	for _, rule := range profile.Invariants {
		checks := coverage[rule.Table+"."+rule.Column]
		if rule.Type != "not_null" && !checks["not_null"] {
			review.Warnings = append(review.Warnings, fmt.Sprintf("Rule %s ignores null values.", rule.Name))
		}
		if rule.Reference != nil {
			parent := coverage[rule.Reference.Table+"."+rule.Reference.Column]
			if !parent["not_null"] || !parent["unique"] {
				review.Warnings = append(review.Warnings, fmt.Sprintf("Rule %s lacks required and unique parent-key coverage.", rule.Name))
			}
		}
	}
	for table := range tables {
		review.Tables = append(review.Tables, table)
	}
	slices.Sort(review.Tables)
	return review, nil
}
