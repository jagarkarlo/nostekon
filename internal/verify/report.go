package verify

import (
	"fmt"
	"sort"
	"time"
)

const ledgerBuckets = 48

type Verdict string

const (
	Verified   Verdict = "verified"
	Failed     Verdict = "failed"
	Incomplete Verdict = "incomplete"
)

type Report struct {
	Name           string        `json:"name"`
	Drill          string        `json:"drill,omitempty"`
	Scenario       string        `json:"scenario,omitempty"`
	Verdict        Verdict       `json:"verdict"`
	Headline       string        `json:"headline"`
	RequestedLevel string        `json:"requestedLevel"`
	DeepestPassed  *string       `json:"deepestPassed"`
	FirstFailed    *string       `json:"firstFailed"`
	FailureAt      time.Time     `json:"failureAt"`
	Levels         []LevelResult `json:"levels"`
	RTO            *RTOResult    `json:"rto"`
	RPO            *RPOResult    `json:"rpo"`
	Provenance     Provenance    `json:"provenance"`
	Findings       []Finding     `json:"findings"`
}

type Provenance struct {
	Status         string `json:"status"`
	Algorithm      string `json:"algorithm,omitempty"`
	KeyID          string `json:"keyId,omitempty"`
	EvidenceSHA256 string `json:"evidenceSHA256,omitempty"`
}

type LevelResult struct {
	ID       string        `json:"id"`
	Question string        `json:"question"`
	Evidence string        `json:"evidence"`
	Status   string        `json:"status"`
	InScope  bool          `json:"inScope"`
	Checks   []CheckResult `json:"checks"`
}

type CheckResult struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Detail string `json:"detail,omitempty"`
	Source string `json:"source"`
}

type RTOResult struct {
	Seconds          float64       `json:"seconds"`
	ObjectiveSeconds *float64      `json:"objectiveSeconds"`
	Met              *bool         `json:"met"`
	UncoveredSeconds float64       `json:"uncoveredSeconds"`
	SlowestPhase     string        `json:"slowestPhase"`
	Phases           []PhaseResult `json:"phases"`
	CompletedAt      time.Time     `json:"completedAt"`
	measure          time.Duration
}

type PhaseResult struct {
	Name            string    `json:"name"`
	StartedAt       time.Time `json:"startedAt"`
	EndedAt         time.Time `json:"endedAt"`
	OffsetSeconds   float64   `json:"offsetSeconds"`
	DurationSeconds float64   `json:"durationSeconds"`
}

type RPOResult struct {
	Seconds           float64        `json:"seconds"`
	ObjectiveSeconds  *float64       `json:"objectiveSeconds"`
	Met               *bool          `json:"met"`
	Acknowledged      int            `json:"acknowledged"`
	Recovered         int            `json:"recovered"`
	Lost              int            `json:"lost"`
	Holes             int            `json:"holes"`
	Unexpected        int            `json:"unexpected"`
	Consistent        bool           `json:"consistent"`
	RecoveryPoint     *time.Time     `json:"recoveryPoint"`
	FirstLostAt       *time.Time     `json:"firstLostAt"`
	ResolutionSeconds *float64       `json:"resolutionSeconds"`
	Timeline          []LedgerBucket `json:"timeline"`
}

type LedgerBucket struct {
	OffsetSeconds float64 `json:"offsetSeconds"`
	Recovered     int     `json:"recovered"`
	Lost          int     `json:"lost"`
}

type Finding struct {
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

// Build evaluates validated evidence. Every level up to the requested one must
// be checked and pass, and every set objective must be met, for a drill to be
// verified. A failure at any in-scope level or a missed objective fails it.
func Build(evidence *Evidence) Report {
	report := Report{
		Name:           evidence.Metadata.Name,
		Drill:          evidence.Metadata.Drill,
		Scenario:       evidence.Spec.Scenario,
		RequestedLevel: evidence.upTo.String(),
		FailureAt:      evidence.Status.FailureAt,
		Provenance:     Provenance{Status: "unverified"},
		Findings:       []Finding{},
	}
	finding := func(severity, format string, args ...any) {
		report.Findings = append(report.Findings, Finding{severity, fmt.Sprintf(format, args...)})
	}
	if evidence.Spec.Scenario == "postgresql-backup-rehearsal" {
		finding("warning", "backup rehearsal duration is not incident RTO; selected row counts do not prove application consistency or production readiness")
	}

	checks := make([][]CheckResult, len(Levels))
	ledgerV4Passed := true
	for _, check := range evidence.Status.Checks {
		checks[check.level] = append(checks[check.level], CheckResult{
			Name: check.Name, Passed: *check.Passed, Detail: check.Detail, Source: "reported",
		})
	}

	if ledger := evidence.Status.Ledger; ledger != nil {
		measurement := MeasureRPO(ledger.Acks, ledger.Present, evidence.Status.FailureAt)
		if measurement.Acknowledged == 0 {
			finding("warning", "the ledger holds no writes acknowledged before the failure, so it proves nothing about data loss")
		} else {
			report.RPO = rpoResult(measurement, evidence)
			detail := fmt.Sprintf("%d of %d acknowledged writes recovered", measurement.Recovered, measurement.Acknowledged)
			if !measurement.Consistent() {
				detail = fmt.Sprintf("%d writes missing before the recovery point; not a consistent point in time", measurement.Holes)
			}
			ledgerV4Passed = measurement.Consistent() && measurement.Unexpected == 0 &&
				(measurement.Lost == 0 || evidence.hasRPO && measurement.RPO <= evidence.rpo)
			checks[V4] = append(checks[V4], CheckResult{
				Name: "acknowledged-write ledger", Passed: ledgerV4Passed,
				Detail: detail, Source: "ledger",
			})
		}
		if measurement.Unexpected > 0 {
			finding("warning", "%d restored writes were never acknowledged before the failure; check the point-in-time target", measurement.Unexpected)
		}
		if measurement.Lost > 0 && measurement.Consistent() {
			finding("warning", "%d acknowledged writes were lost", measurement.Lost)
		}
	}

	var deepest, first *Level
	for level := V0; level <= V4; level++ {
		result := LevelResult{
			ID: level.String(), Question: Levels[level].Question, Evidence: Levels[level].Evidence,
			Status: "not-checked", InScope: level <= evidence.upTo, Checks: checks[level],
		}
		if result.Checks == nil {
			result.Checks = []CheckResult{}
		}
		if len(result.Checks) > 0 {
			result.Status = "passed"
			for _, check := range result.Checks {
				if !check.Passed || level == V4 && check.Source == "ledger" && !ledgerV4Passed {
					result.Status = "failed"
				}
			}
		}
		if result.Status == "failed" && first == nil {
			value := level
			first = &value
		}
		if result.Status == "passed" && (deepest != nil && *deepest == level-1 || deepest == nil && level == V0) {
			value := level
			deepest = &value
		}
		if result.Status == "not-checked" && result.InScope {
			finding("warning", "%s was not checked: %s", level, Levels[level].Question)
		}
		report.Levels = append(report.Levels, result)
	}
	if deepest != nil {
		value := deepest.String()
		report.DeepestPassed = &value
	}
	if first != nil {
		value := first.String()
		report.FirstFailed = &value
		severity := "error"
		if *first > evidence.upTo {
			severity = "warning"
		}
		for _, check := range checks[*first] {
			if !check.Passed {
				finding(severity, "%s failed: %s%s", *first, check.Name, suffix(check.Detail))
			}
		}
	}

	report.RTO = rtoResult(evidence)
	if report.RTO.UncoveredSeconds >= 1 {
		finding("info", "%s of the recovery was not covered by a recorded phase", seconds(report.RTO.UncoveredSeconds))
	}
	for _, phase := range evidence.Status.Phases {
		if phase.StartedAt.Before(evidence.Status.FailureAt) {
			finding("warning", "phase %q started before the failure was injected", phase.Name)
		}
	}
	if evidence.hasRPO && report.RPO == nil {
		finding("warning", "an RPO objective is set but no write ledger was recorded")
	}

	rtoMissed := report.RTO != nil && report.RTO.Met != nil && !*report.RTO.Met
	rpoMissed := report.RPO != nil && report.RPO.Met != nil && !*report.RPO.Met
	rtoUnmeasured := evidence.hasRTO && report.RTO == nil
	rpoUnmeasured := evidence.hasRPO && report.RPO == nil
	if rtoMissed {
		finding("error", "recovery took %s, over the %s RTO objective; slowest phase: %s",
			seconds(report.RTO.Seconds), seconds(*report.RTO.ObjectiveSeconds), report.RTO.SlowestPhase)
	}
	if rpoMissed {
		finding("error", "%s of acknowledged data was lost, over the %s RPO objective",
			seconds(report.RPO.Seconds), seconds(*report.RPO.ObjectiveSeconds))
	}

	switch {
	case first != nil && *first <= evidence.upTo:
		report.Verdict = Failed
		report.Headline = fmt.Sprintf("Failed at %s: %s", *first, firstFailingName(checks[*first]))
	case rtoMissed || rpoMissed:
		report.Verdict = Failed
		report.Headline = "Recovered, but outside the recovery objectives"
	case rtoUnmeasured || rpoUnmeasured:
		report.Verdict = Incomplete
		report.Headline = "Incomplete: a recovery objective is missing its measurement"
	case deepest != nil && *deepest >= evidence.upTo:
		report.Verdict = Verified
		report.Headline = fmt.Sprintf("Verified to %s", evidence.upTo)
	default:
		report.Verdict = Incomplete
		reached := "no level"
		if deepest != nil {
			reached = deepest.String()
		}
		report.Headline = fmt.Sprintf("Incomplete: evidence reaches %s of the requested %s", reached, evidence.upTo)
	}
	sort.SliceStable(report.Findings, func(i, j int) bool {
		return severityRank[report.Findings[i].Severity] < severityRank[report.Findings[j].Severity]
	})
	return report
}

var severityRank = map[string]int{"error": 0, "warning": 1, "info": 2}

func rtoResult(evidence *Evidence) *RTOResult {
	phases := append([]Phase(nil), evidence.Status.Phases...)
	sort.SliceStable(phases, func(i, j int) bool { return phases[i].StartedAt.Before(phases[j].StartedAt) })
	failureAt := evidence.Status.FailureAt
	result := &RTOResult{Phases: make([]PhaseResult, 0, len(phases))}

	var slowest time.Duration
	var covered time.Duration
	coveredUntil := failureAt
	for _, phase := range phases {
		duration := phase.EndedAt.Sub(phase.StartedAt)
		result.Phases = append(result.Phases, PhaseResult{
			Name: phase.Name, StartedAt: phase.StartedAt, EndedAt: phase.EndedAt,
			OffsetSeconds: phase.StartedAt.Sub(failureAt).Seconds(), DurationSeconds: duration.Seconds(),
		})
		if duration > slowest || result.SlowestPhase == "" {
			slowest, result.SlowestPhase = duration, phase.Name
		}
		start := phase.StartedAt
		if start.Before(coveredUntil) {
			start = coveredUntil
		}
		end := phase.EndedAt
		if end.After(evidence.Status.CompletedAt) {
			end = evidence.Status.CompletedAt
		}
		if end.After(start) {
			covered += end.Sub(start)
			coveredUntil = end
		}
	}
	result.CompletedAt = evidence.Status.CompletedAt
	result.measure = result.CompletedAt.Sub(failureAt)
	if result.measure < 0 {
		result.measure = 0
	}
	result.Seconds = result.measure.Seconds()
	result.UncoveredSeconds = max(0, (result.measure - covered).Seconds())
	if evidence.hasRTO {
		objective := evidence.rto.Seconds()
		met := result.measure <= evidence.rto
		result.ObjectiveSeconds, result.Met = &objective, &met
	}
	return result
}

func rpoResult(measurement RPOMeasurement, evidence *Evidence) *RPOResult {
	result := &RPOResult{
		Seconds:       measurement.RPO.Seconds(),
		Acknowledged:  measurement.Acknowledged,
		Recovered:     measurement.Recovered,
		Lost:          measurement.Lost,
		Holes:         measurement.Holes,
		Unexpected:    measurement.Unexpected,
		Consistent:    measurement.Consistent(),
		RecoveryPoint: measurement.RecoveryPoint,
		FirstLostAt:   measurement.FirstLostAt,
		Timeline:      []LedgerBucket{},
	}
	if resolution := measurement.Resolution(); resolution != nil {
		value := resolution.Seconds()
		result.ResolutionSeconds = &value
	}
	if evidence.hasRPO {
		objective := evidence.rpo.Seconds()
		met := measurement.RPO <= evidence.rpo
		result.ObjectiveSeconds, result.Met = &objective, &met
	}
	if len(measurement.expected) > 0 {
		start := measurement.expected[0].AckedAt
		span := measurement.FailureAt.Sub(start)
		width := span / ledgerBuckets
		if width <= 0 {
			width = time.Second
		}
		buckets := make([]LedgerBucket, ledgerBuckets)
		for index := range buckets {
			buckets[index].OffsetSeconds = (start.Add(time.Duration(index) * width)).Sub(measurement.FailureAt).Seconds()
		}
		for index, ack := range measurement.expected {
			slot := min(int(ack.AckedAt.Sub(start)/width), ledgerBuckets-1)
			if measurement.recovered[index] {
				buckets[slot].Recovered++
			} else {
				buckets[slot].Lost++
			}
		}
		result.Timeline = buckets
	}
	return result
}

func firstFailingName(checks []CheckResult) string {
	for _, check := range checks {
		if !check.Passed {
			return check.Name
		}
	}
	return "unknown check"
}

func suffix(detail string) string {
	if detail == "" {
		return ""
	}
	return " (" + detail + ")"
}

func seconds(value float64) string {
	total := int64(time.Duration(value * float64(time.Second)).Round(time.Second).Seconds())
	if total <= 0 {
		return "0s"
	}
	var out string
	for _, unit := range []struct {
		size int64
		name string
	}{{3600, "h"}, {60, "m"}, {1, "s"}} {
		if part := total / unit.size; part > 0 {
			out += fmt.Sprintf("%d%s", part, unit.name)
			total %= unit.size
		}
	}
	return out
}
