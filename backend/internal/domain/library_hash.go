package domain

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

func LibraryBytesHash(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
func libraryFrame(s string) string { return strconv.Itoa(len(s)) + ":" + s + "\n" }

func ValidateLibraryPath(path string) error {
	if path == "" || len(path) > 1024 || !utf8.ValidString(path) || !norm.NFC.IsNormalString(path) || strings.ContainsAny(path, "\\:") {
		return fmt.Errorf("invalid_path")
	}
	parts := strings.Split(path, "/")
	if len(parts) > 16 {
		return fmt.Errorf("invalid_path")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid_path")
		}
		for _, r := range part {
			if unicode.IsControl(r) {
				return fmt.Errorf("invalid_path")
			}
		}
	}
	return nil
}

func (e LibraryEntry) ComputeContentHash() (string, error) {
	if e.SchemaVersion != 1 {
		return "", fmt.Errorf("unsupported_schema")
	}
	switch e.Kind {
	case "rule", "persona", "skill", "prompt_command", "executable_command", "hook":
	default:
		return "", fmt.Errorf("unsupported_kind")
	}
	if err := ValidateLibraryPath(e.EntryPoint); err != nil {
		return "", err
	}
	if e.Format == "" || len(e.Files) == 0 || len(e.Files) > MaxLibraryFiles {
		return "", fmt.Errorf("invalid_entry")
	}
	files := append([]LibraryFile(nil), e.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	seen := map[string]bool{}
	found := false
	total := int64(0)
	var b strings.Builder
	for _, s := range []string{"shared-library-entry-v1", e.Kind, e.Format, e.EntryPoint, strconv.Itoa(len(files))} {
		b.WriteString(libraryFrame(s))
	}
	for _, f := range files {
		if err := ValidateLibraryPath(f.Path); err != nil {
			return "", err
		}
		key := cases.Fold().String(f.Path)
		if seen[key] {
			return "", fmt.Errorf("path_collision")
		}
		seen[key] = true
		if f.Mode != "text" || f.SizeBytes < 0 || f.SizeBytes > MaxLibraryFileBytes || !ValidLibraryHash(f.SHA256) {
			return "", fmt.Errorf("invalid_file")
		}
		total += f.SizeBytes
		if total > MaxLibraryEntryBytes {
			return "", fmt.Errorf("entry_limit")
		}
		found = found || f.Path == e.EntryPoint
		for _, s := range []string{f.Path, f.Mode, strconv.FormatInt(f.SizeBytes, 10), f.SHA256} {
			b.WriteString(libraryFrame(s))
		}
	}
	if !found {
		return "", fmt.Errorf("missing_entry_point")
	}
	reqs := append([]string(nil), e.Requirements...)
	sort.Strings(reqs)
	unique := reqs[:0]
	for _, r := range reqs {
		if !utf8.ValidString(r) || r == "" {
			return "", fmt.Errorf("invalid_requirement")
		}
		if len(unique) == 0 || unique[len(unique)-1] != r {
			unique = append(unique, r)
		}
	}
	b.WriteString(libraryFrame(strconv.Itoa(len(unique))))
	for _, r := range unique {
		b.WriteString(libraryFrame(r))
	}
	return LibraryBytesHash([]byte(b.String())), nil
}

func (s LibraryStagedEntry) Verify() error {
	hash, err := s.Entry.ComputeContentHash()
	if err != nil {
		return err
	}
	if hash != s.Entry.ContentHash || len(s.Content) != len(s.Entry.Files) {
		return fmt.Errorf("digest_mismatch")
	}
	for _, f := range s.Entry.Files {
		data, ok := s.Content[f.Path]
		if !ok || !utf8.ValidString(data) || strings.ContainsRune(data, 0) || int64(len(data)) != f.SizeBytes || LibraryBytesHash([]byte(data)) != f.SHA256 {
			return fmt.Errorf("digest_mismatch")
		}
	}
	return nil
}

func LibraryRecordDigest(frame string, value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	canonical, err := CanonicalLibraryJSON(data)
	if err != nil {
		return "", err
	}
	return LibraryBytesHash([]byte(libraryFrame(frame) + libraryFrame(string(canonical)))), nil
}

func CanonicalLibraryJSON(data []byte) ([]byte, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid_utf8")
	}
	if err := validLibraryEscapes(data); err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := readLibraryJSON(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing_json")
	}
	var b strings.Builder
	if err := writeLibraryJSON(&b, value); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func validLibraryEscapes(data []byte) error {
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) {
			return fmt.Errorf("invalid_escape")
		}
		if data[i] != 'u' {
			continue
		}
		if i+4 >= len(data) {
			return fmt.Errorf("invalid_escape")
		}
		v, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return err
		}
		i += 4
		if v >= 0xD800 && v <= 0xDBFF {
			if i+6 >= len(data) || string(data[i+1:i+3]) != "\\u" {
				return fmt.Errorf("unpaired_surrogate")
			}
			low, err := strconv.ParseUint(string(data[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return fmt.Errorf("unpaired_surrogate")
			}
			i += 6
		} else if v >= 0xDC00 && v <= 0xDFFF {
			return fmt.Errorf("unpaired_surrogate")
		}
	}
	return nil
}

func readLibraryJSON(d *json.Decoder) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t := token.(type) {
	case json.Delim:
		if t == '{' {
			m := map[string]any{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				k, ok := key.(string)
				if !ok {
					return nil, fmt.Errorf("invalid_key")
				}
				if _, ok := m[k]; ok {
					return nil, fmt.Errorf("duplicate_key")
				}
				v, err := readLibraryJSON(d)
				if err != nil {
					return nil, err
				}
				m[k] = v
			}
			_, err = d.Token()
			return m, err
		}
		if t == '[' {
			a := []any{}
			for d.More() {
				v, err := readLibraryJSON(d)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err = d.Token()
			return a, err
		}
		return nil, fmt.Errorf("invalid_json")
	case json.Number:
		if strings.ContainsAny(string(t), ".eE") {
			return nil, fmt.Errorf("integer_required")
		}
		if _, err := strconv.ParseInt(string(t), 10, 64); err != nil {
			return nil, fmt.Errorf("integer_range")
		}
		return t, nil
	default:
		return t, nil
	}
}

func writeLibraryString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 32:
			fmt.Fprintf(b, "\\u%04x", r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}
func writeLibraryJSON(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		writeLibraryString(b, x)
	case json.Number:
		b.WriteString(string(x))
	case []any:
		b.WriteByte('[')
		for i, v := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeLibraryJSON(b, v); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeLibraryString(b, k)
			b.WriteByte(':')
			if err := writeLibraryJSON(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("invalid_json_value")
	}
	return nil
}
