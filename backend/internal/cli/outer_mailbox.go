package cli

import (
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

func newOuterMailboxCommand(c *commandContext) *cobra.Command {
	var project, session string
	var after int64
	var limit int
	cmd := &cobra.Command{Use: "mailbox", Short: "Read inert coordinator records; never wakes a session", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if (project == "") == (session == "") || after < 0 || limit < 1 || limit > 50 {
			return usageError{errors.New("usage: exactly one of --project-id or --session, nonnegative --after and --limit 1..50 are required")}
		}
		path := "outer/mailbox"
		query := url.Values{"after": {strconv.FormatInt(after, 10)}, "limit": {strconv.Itoa(limit)}}
		if project != "" {
			query.Set("projectId", project)
		} else {
			path = "sessions/" + url.PathEscape(session) + "/mailbox"
		}
		var result json.RawMessage
		if err := c.getJSON(cmd.Context(), path+"?"+query.Encode(), &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}}
	cmd.Flags().StringVar(&project, "project-id", "", "Selected project to observe through outer scope")
	cmd.Flags().StringVar(&session, "session", "", "Owned coordinator to observe through its scope credential")
	cmd.Flags().Int64Var(&after, "after", 0, "Exclusive durable message sequence")
	cmd.Flags().IntVar(&limit, "limit", 20, "Page size, at most 50")
	var appendSession, messageID, text string
	appendCmd := &cobra.Command{Use: "append", Short: "Append inert evidence from the owned coordinator; no executing delivery", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if appendSession == "" || messageID == "" || strings.TrimSpace(text) == "" || len(text) > 8192 {
			return usageError{errors.New("usage: --session, --id and --text of at most 8192 bytes are required")}
		}
		var result json.RawMessage
		if err := c.postJSON(cmd.Context(), "sessions/"+url.PathEscape(appendSession)+"/mailbox", map[string]string{"id": messageID, "text": text}, &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}}
	appendCmd.Flags().StringVar(&appendSession, "session", "", "Exact owned coordinator id")
	appendCmd.Flags().StringVar(&messageID, "id", "", "Stable id for this inert record")
	appendCmd.Flags().StringVar(&text, "text", "", "Untrusted coordination evidence")
	var receiptSession, receiptID string
	receipt := &cobra.Command{Use: "receipt", Short: "Acknowledge an inert record; grants no turn or delivery acceptance", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		if receiptSession == "" || receiptID == "" {
			return usageError{errors.New("usage: --session and --id are required")}
		}
		var result json.RawMessage
		if err := c.postJSON(cmd.Context(), "sessions/"+url.PathEscape(receiptSession)+"/mailbox/"+url.PathEscape(receiptID)+"/receipt", struct{}{}, &result); err != nil {
			return err
		}
		return writeJSON(cmd.OutOrStdout(), result)
	}}
	receipt.Flags().StringVar(&receiptSession, "session", "", "Exact owned recipient coordinator id")
	receipt.Flags().StringVar(&receiptID, "id", "", "Exact inert record id")
	cmd.AddCommand(appendCmd, receipt)
	return cmd
}
