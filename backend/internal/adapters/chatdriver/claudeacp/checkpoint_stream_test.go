package claudeacp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type checkpointFilePlugin struct{ path string }

func (p checkpointFilePlugin) ResolveBinary(context.Context) (string, error) {
	return "", errors.New("provider execution forbidden")
}
func (p checkpointFilePlugin) NativeSessionConfigDir(context.Context, map[string]string) (string, error) {
	return filepath.Dir(p.path), nil
}
func (p checkpointFilePlugin) LocateTranscript(context.Context, ports.NativeSessionRef) (string, bool, error) {
	return p.path, true, nil
}

func TestNativeCheckpointStreamsLargeCompactedTranscript(t *testing.T) {
	if testing.Short() {
		t.Skip("large streaming fixture")
	}
	path := filepath.Join(t.TempDir(), "native.jsonl")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	writer := bufio.NewWriter(file)
	encoder := json.NewEncoder(writer)
	write := func(records ...map[string]any) {
		t.Helper()
		for _, record := range records {
			record["sessionId"] = "native"
			if err := encoder.Encode(record); err != nil {
				t.Fatal(err)
			}
		}
	}
	payload := strings.Repeat("x", 1<<20)
	parent := ""
	var events []domain.NativeCheckpointObservation
	for n := 0; n <= 19; n++ {
		write(compactionPrompt(n, parent, "question")...)
		parent = fmt.Sprintf("submission-attachment-%d", n)
		if n < 19 {
			for j := 0; j < 12; j++ {
				id := fmt.Sprintf("tool-%d-%d", n, j)
				write(map[string]any{"type": "user", "uuid": id, "parentUuid": parent,
					"message": map[string]any{"content": []map[string]string{{"type": "tool_result", "content": payload}}}})
				parent = id
			}
		}
		answer := fmt.Sprintf("assistant-%d", n)
		write(compactionAnswer(answer, parent, "answer", "end_turn"))
		events = append(events, submitObservation(n, "question"), stopObservation(n, "answer"))
		if n < 19 {
			boundary, summary := fmt.Sprintf("boundary-%d", n), fmt.Sprintf("summary-%d", n)
			write(compactionBoundary(boundary, answer, keptMessages(summary, answer)), compactionSummary(summary, boundary, fmt.Sprintf("prompt-%d", n)))
			parent = summary
		}
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil || info.Size() < 213<<20 {
		t.Fatalf("fixture size: %v %v", info, err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	driver := &checkpointDriver{plugin: checkpointFilePlugin{path: path}}
	got, err := driver.VerifyNativeCheckpoint(context.Background(), ports.NativeCheckpointRequest{
		ProviderConversationID: "native", Evidence: checkpointEvidence(events...),
	})
	if err != nil || got.UserMessageID != "user-19" || got.AssistantText != "answer" {
		t.Fatalf("large transcript: boundary=%+v error=%v", got, err)
	}
	t.Logf("streamed %d bytes, 19 boundaries in %s", info.Size(), time.Since(started))
}

type checkpointCancelReader struct{ cancel context.CancelFunc }

func (r checkpointCancelReader) Read([]byte) (int, error) {
	r.cancel()
	return 0, context.Canceled
}

func TestNativeCheckpointStreamingLimitsAndCancellation(t *testing.T) {
	request := ports.NativeCheckpointRequest{ProviderConversationID: "native", Evidence: checkpointEvidence(submitObservation(0, "A"), stopObservation(0, "answer A"))}
	transcript := checkpointFixture(t, []string{"A"}, []string{"answer A"})
	t.Run("total scan bound", func(t *testing.T) {
		old := checkpointTranscriptBytes
		checkpointTranscriptBytes = int64(len(transcript) - 1)
		t.Cleanup(func() { checkpointTranscriptBytes = old })
		if _, err := verifyCheckpointTranscript(context.Background(), strings.NewReader(transcript), request); !errors.Is(err, ports.ErrChatHistoryUnsettled) {
			t.Fatalf("scan bound: %v", err)
		}
	})
	t.Run("cancelled before reading", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := verifyCheckpointTranscript(ctx, strings.NewReader(""), request); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel before read: %v", err)
		}
	})
	t.Run("cancelled during reading", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		if _, err := verifyCheckpointTranscript(ctx, checkpointCancelReader{cancel}, request); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel during read: %v", err)
		}
	})
	for name, suffix := range map[string]string{
		"partial record":   `{"type":"assistant",`,
		"malformed record": `{"type":broken}`,
		"oversized line":   strings.Repeat("x", 4<<20),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := verifyCheckpointTranscript(context.Background(), strings.NewReader(transcript+suffix), request); !errors.Is(err, ports.ErrChatHistoryUnsettled) {
				t.Fatalf("invalid tail admitted: %v", err)
			}
		})
	}
}
