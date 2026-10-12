package backupreview

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

func TestBundlePreservesOriginalsAndReevaluatesCachedReview(t *testing.T) {
	planData, evidenceData := validFixture(t, true)
	archive, err := Bundle(planData, evidenceData)
	if err != nil {
		t.Fatal(err)
	}
	imported, err := ReadBundle(archive)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(imported.Plan, planData) || !bytes.Equal(imported.Evidence, evidenceData) || !imported.Review.Passed || imported.Review.Provenance.Status != "unverified" {
		t.Fatal("originals or fresh verdict lost")
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{}
	for _, file := range reader.File {
		if file.Method != zip.Store {
			t.Fatal("compressed bundle entry")
		}
		handle, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name], err = io.ReadAll(handle)
		handle.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(files) != 4 {
		t.Fatal("unexpected bundle files")
	}
	files["review.json"] = []byte(`{"passed":false,"provenance":{"status":"verified"}}`)
	var manifest map[string]any
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["files"].(map[string]any)["review.json"] = map[string]any{"sha256": digest(files["review.json"]), "bytes": len(files["review.json"])}
	files["manifest.json"], _ = json.Marshal(manifest)
	var rewritten bytes.Buffer
	writer := zip.NewWriter(&rewritten)
	for name, data := range files {
		handle, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := handle.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	imported, err = ReadBundle(rewritten.Bytes())
	if err != nil || !imported.Review.Passed || imported.Review.Provenance.Status != "unverified" {
		t.Fatalf("cached receipt trusted: %v", err)
	}
}

func TestBundleAdmission(t *testing.T) {
	planData, evidenceData := validFixture(t, false)
	archive, err := Bundle(planData, evidenceData)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"changed-original", "traversal", "duplicate", "extra", "missing", "compressed", "symlink", "bad-manifest", "null-size", "wrong-version", "unknown-field", "duplicate-key", "corrupt-zip"} {
		t.Run(name, func(t *testing.T) {
			reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
			if err != nil {
				t.Fatal(err)
			}
			var output bytes.Buffer
			writer := zip.NewWriter(&output)
			for _, file := range reader.File {
				handle, err := file.Open()
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(handle)
				handle.Close()
				if err != nil {
					t.Fatal(err)
				}
				header := &zip.FileHeader{Name: file.Name, Method: zip.Store}
				header.SetMode(0600)
				if file.Name == "plan.json" {
					switch name {
					case "changed-original":
						data = append(data, '\n')
					case "traversal":
						header.Name = "../plan.json"
					case "duplicate":
						header.Name = "run.json"
					case "missing":
						continue
					case "compressed":
						header.Method = zip.Deflate
					case "symlink":
						header.SetMode(os.ModeSymlink | 0600)
					}
				}
				if file.Name == "manifest.json" {
					switch name {
					case "bad-manifest":
						data = []byte(`{"apiVersion":"invalid"}`)
					case "null-size":
						data = bytes.Replace(data, []byte(fmtBytes(len(planData))), []byte(`"bytes": null`), 1)
					case "wrong-version":
						data = bytes.ReplaceAll(data, []byte("v1alpha1"), []byte("v2alpha1"))
					case "unknown-field":
						data = append([]byte(`{"extra":true,`), data[1:]...)
					case "duplicate-key":
						data = append([]byte(`{"kind":"PostgreSQLBackupBundle",`), data[1:]...)
					}
				}
				target, err := writer.CreateHeader(header)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := target.Write(data); err != nil {
					t.Fatal(err)
				}
			}
			if name == "extra" {
				handle, err := writer.CreateHeader(&zip.FileHeader{Name: "backup.dump", Method: zip.Store})
				if err != nil {
					t.Fatal(err)
				}
				handle.Write([]byte("PGDMP"))
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			data := output.Bytes()
			if name == "corrupt-zip" {
				data = data[:len(data)-10]
			}
			if _, err := ReadBundle(data); err == nil {
				t.Fatal("unsafe bundle admitted")
			}
		})
	}
	if _, err := ReadBundle(nil); err == nil {
		t.Fatal("empty ZIP admitted")
	}
	if _, err := ReadBundle(make([]byte, MaxBundleBytes+1)); err == nil {
		t.Fatal("oversized ZIP admitted")
	}
	oversized := append(planData, []byte(strings.Repeat(" ", MaxPlanBytes))...)
	if _, err := Bundle(oversized, evidenceData); err == nil {
		t.Fatal("oversized plan exported")
	}
}

func fmtBytes(size int) string {
	data, _ := json.Marshal(size)
	return `"bytes": ` + string(data)
}

func TestBundleRejectsUnboundedDirectoryAndTrailingBytes(t *testing.T) {
	plan, evidence := validFixture(t, false)
	archive, err := Bundle(plan, evidence)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"count", "directory-size", "multi-disk", "trailing"} {
		t.Run(name, func(t *testing.T) {
			data := bytes.Clone(archive)
			footer := data[len(data)-22:]
			switch name {
			case "count":
				binary.LittleEndian.PutUint16(footer[8:], 65535)
				binary.LittleEndian.PutUint16(footer[10:], 65535)
			case "directory-size":
				binary.LittleEndian.PutUint32(footer[12:], 4097)
			case "multi-disk":
				binary.LittleEndian.PutUint16(footer[4:], 1)
			case "trailing":
				data = append(data, []byte("unaccounted")...)
			}
			if _, err := ReadBundle(data); err == nil {
				t.Fatal("unsafe ZIP directory admitted")
			}
		})
	}
}
