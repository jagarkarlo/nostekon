package backupreview

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const MaxBundleBytes = 20 << 20

type bundleItem struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type bundleManifest struct {
	APIVersion string                `json:"apiVersion"`
	Kind       string                `json:"kind"`
	Files      map[string]bundleItem `json:"files"`
}

type ImportedBundle struct {
	Plan            []byte           `json:"-"`
	Preflight       []byte           `json:"-"`
	Evidence        []byte           `json:"-"`
	Review          Review           `json:"review"`
	PreflightReview *PreflightReview `json:"preflightReview,omitempty"`
}

var bundleLimits = map[string]int64{"manifest.json": 16 << 10, "plan.json": MaxPlanBytes, "preflight.json": MaxPlanBytes, "run.json": 16 << 20, "review.json": 2 << 20}

func Bundle(planData, evidenceData []byte) ([]byte, error) {
	return BundleWithPreflight(planData, evidenceData, nil)
}

func BundleWithPreflight(planData, evidenceData, preflightData []byte) ([]byte, error) {
	review, err := Evaluate(planData, evidenceData)
	if err != nil {
		return nil, err
	}
	if len(preflightData) > 0 {
		if _, err := EvaluatePreflight(planData, preflightData); err != nil {
			return nil, err
		}
	}
	reviewData, err := json.MarshalIndent(review, "", "  ")
	if err != nil {
		return nil, err
	}
	reviewData = append(reviewData, '\n')
	files := map[string][]byte{"plan.json": planData, "run.json": evidenceData, "review.json": reviewData}
	order := []string{"manifest.json", "plan.json", "run.json", "review.json"}
	manifestVersion := "nostekon/backup-bundle/v1alpha1"
	if len(preflightData) > 0 {
		files["preflight.json"] = preflightData
		order = []string{"manifest.json", "plan.json", "preflight.json", "run.json", "review.json"}
		manifestVersion = "nostekon/backup-bundle/v2alpha1"
	}
	manifest := bundleManifest{APIVersion: manifestVersion, Kind: "PostgreSQLBackupBundle", Files: map[string]bundleItem{}}
	for name, data := range files {
		if len(data) == 0 || int64(len(data)) > bundleLimits[name] {
			return nil, errors.New("bundle entry exceeds its size limit")
		}
		manifest.Files[name] = bundleItem{SHA256: digest(data), Bytes: int64(len(data))}
	}
	files["manifest.json"], err = json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	files["manifest.json"] = append(files["manifest.json"], '\n')
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, name := range order {
		header := &zip.FileHeader{Name: name, Method: zip.Store}
		header.SetMode(0600)
		handle, err := writer.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		if _, err := handle.Write(files[name]); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if output.Len() > MaxBundleBytes {
		return nil, errors.New("bundle exceeds 20 MiB")
	}
	return output.Bytes(), nil
}

func ReadBundle(data []byte) (ImportedBundle, error) {
	if len(data) == 0 || len(data) > MaxBundleBytes {
		return ImportedBundle{}, errors.New("backup bundle must be nonempty and within 20 MiB")
	}
	if !boundedBundleDirectory(data) {
		return ImportedBundle{}, errors.New("backup bundle requires a bounded four- or five-entry single-disk ZIP directory with no trailing bytes")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ImportedBundle{}, err
	}
	if len(archive.File) != 4 && len(archive.File) != 5 {
		return ImportedBundle{}, errors.New("backup bundle requires four or five entries")
	}
	files := map[string][]byte{}
	for _, file := range archive.File {
		limit, allowed := bundleLimits[file.Name]
		if _, duplicate := files[file.Name]; duplicate || !allowed || !file.Mode().IsRegular() || file.Method != zip.Store || file.Flags&1 != 0 || file.UncompressedSize64 == 0 || file.UncompressedSize64 > uint64(limit) || file.CompressedSize64 != file.UncompressedSize64 {
			return ImportedBundle{}, errors.New("unsafe, duplicate, compressed or oversized backup bundle entry")
		}
		handle, err := file.Open()
		if err != nil {
			return ImportedBundle{}, err
		}
		payload, readErr := io.ReadAll(io.LimitReader(handle, limit+1))
		handle.Close()
		if readErr != nil || len(payload) > int(limit) || uint64(len(payload)) != file.UncompressedSize64 {
			return ImportedBundle{}, errors.New("backup bundle entry failed bounded integrity reading")
		}
		files[file.Name] = payload
	}
	manifestData := files["manifest.json"]
	if !utf8.Valid(manifestData) || !exactFields(manifestData, "apiVersion", "kind", "files") {
		return ImportedBundle{}, errors.New("invalid backup bundle manifest fields")
	}
	checker := json.NewDecoder(bytes.NewReader(manifestData))
	checker.UseNumber()
	if err := uniqueJSON(checker, 0); err != nil {
		return ImportedBundle{}, err
	}
	if _, err := checker.Token(); !errors.Is(err, io.EOF) {
		return ImportedBundle{}, errors.New("manifest requires one JSON document")
	}
	decoder := json.NewDecoder(bytes.NewReader(manifestData))
	decoder.DisallowUnknownFields()
	var manifest bundleManifest
	if err := decoder.Decode(&manifest); err != nil {
		return ImportedBundle{}, err
	}
	v2 := manifest.APIVersion == "nostekon/backup-bundle/v2alpha1"
	expectedEntries := 3
	requiredNames := []string{"plan.json", "run.json", "review.json"}
	if v2 {
		expectedEntries = 4
		requiredNames = append(requiredNames, "preflight.json")
	}
	if !v2 && manifest.APIVersion != "nostekon/backup-bundle/v1alpha1" || manifest.Kind != "PostgreSQLBackupBundle" || len(manifest.Files) != expectedEntries || len(files) != expectedEntries+1 {
		return ImportedBundle{}, errors.New("unsupported backup bundle version, kind or file inventory")
	}
	var raw struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(manifestData, &raw); err != nil {
		return ImportedBundle{}, err
	}
	for _, name := range requiredNames {
		item, present := manifest.Files[name]
		if !present || !exactFields(raw.Files[name], "sha256", "bytes") || !digestPattern.MatchString(item.SHA256) || item.Bytes != int64(len(files[name])) || item.SHA256 != digest(files[name]) {
			return ImportedBundle{}, fmt.Errorf("backup bundle checksum or size mismatch: %s", name)
		}
	}
	if !utf8.Valid(files["review.json"]) || !json.Valid(files["review.json"]) {
		return ImportedBundle{}, errors.New("cached review must be UTF-8 JSON")
	}
	review, err := Evaluate(files["plan.json"], files["run.json"])
	if err != nil {
		return ImportedBundle{}, err
	}
	imported := ImportedBundle{Plan: files["plan.json"], Evidence: files["run.json"], Review: review}
	if v2 {
		preflightReview, err := EvaluatePreflight(files["plan.json"], files["preflight.json"])
		if err != nil {
			return ImportedBundle{}, err
		}
		imported.Preflight = files["preflight.json"]
		imported.PreflightReview = &preflightReview
	}
	return imported, nil
}

func boundedBundleDirectory(data []byte) bool {
	if len(data) < 22 {
		return false
	}
	footer := data[len(data)-22:]
	count := binary.LittleEndian.Uint16(footer[8:])
	totalCount := binary.LittleEndian.Uint16(footer[10:])
	if binary.LittleEndian.Uint32(footer) != 0x06054b50 || binary.LittleEndian.Uint16(footer[4:]) != 0 || binary.LittleEndian.Uint16(footer[6:]) != 0 || count != totalCount || count != 4 && count != 5 || binary.LittleEndian.Uint16(footer[20:]) != 0 {
		return false
	}
	start := uint64(binary.LittleEndian.Uint32(footer[16:]))
	size := uint64(binary.LittleEndian.Uint32(footer[12:]))
	if size > 4096 || start+size != uint64(len(data)-22) {
		return false
	}
	directory := data[start : start+size]
	for range count {
		if len(directory) < 46 || binary.LittleEndian.Uint32(directory) != 0x02014b50 {
			return false
		}
		recordSize := 46 + int(binary.LittleEndian.Uint16(directory[28:])) + int(binary.LittleEndian.Uint16(directory[30:])) + int(binary.LittleEndian.Uint16(directory[32:]))
		if recordSize > len(directory) {
			return false
		}
		directory = directory[recordSize:]
	}
	return len(directory) == 0
}
