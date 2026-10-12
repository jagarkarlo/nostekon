package backupreview

import (
	"archive/zip"
	"bytes"
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
	Plan     []byte `json:"-"`
	Evidence []byte `json:"-"`
	Review   Review `json:"review"`
}

var bundleLimits = map[string]int64{"manifest.json": 16 << 10, "plan.json": MaxPlanBytes, "run.json": 16 << 20, "review.json": 2 << 20}

func Bundle(planData, evidenceData []byte) ([]byte, error) {
	review, err := Evaluate(planData, evidenceData)
	if err != nil {
		return nil, err
	}
	reviewData, err := json.MarshalIndent(review, "", "  ")
	if err != nil {
		return nil, err
	}
	reviewData = append(reviewData, '\n')
	files := map[string][]byte{"plan.json": planData, "run.json": evidenceData, "review.json": reviewData}
	manifest := bundleManifest{APIVersion: "nostekon/backup-bundle/v1alpha1", Kind: "PostgreSQLBackupBundle", Files: map[string]bundleItem{}}
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
	for _, name := range []string{"manifest.json", "plan.json", "run.json", "review.json"} {
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
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ImportedBundle{}, err
	}
	if len(archive.File) != 4 {
		return ImportedBundle{}, errors.New("backup bundle requires exactly four entries")
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
	if manifest.APIVersion != "nostekon/backup-bundle/v1alpha1" || manifest.Kind != "PostgreSQLBackupBundle" || len(manifest.Files) != 3 {
		return ImportedBundle{}, errors.New("unsupported backup bundle version, kind or file inventory")
	}
	var raw struct {
		Files map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(manifestData, &raw); err != nil {
		return ImportedBundle{}, err
	}
	for _, name := range []string{"plan.json", "run.json", "review.json"} {
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
	return ImportedBundle{Plan: files["plan.json"], Evidence: files["run.json"], Review: review}, nil
}
