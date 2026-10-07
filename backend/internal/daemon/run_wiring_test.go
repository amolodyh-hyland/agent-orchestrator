package daemon

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Run starts the whole daemon and blocks, so a unit test cannot execute it. The
// Session Manager is built after the Chat service, and the hooks that write the
// effective permission mode and the chosen model onto its session records only
// reach it if Run hands it to the bind function newChatServiceOptions returns. A Run
// that forgets to, discards the function, or binds something other than the manager
// startSession returned leaves those hooks quietly doing nothing while every other
// test passes, so the call is checked in Run's source.
func TestRunBindsTheSessionManagerStartSessionReturnsToTheChatHooks(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "daemon.go", nil, 0)
	if err != nil {
		t.Fatalf("parse daemon.go: %v", err)
	}
	var run *ast.FuncDecl
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.Name == "Run" {
			run = fn
		}
	}
	if run == nil {
		t.Fatal("daemon.go has no Run function")
	}

	// The name Run gives the bind function, and the name it gives the manager.
	var bindName, managerName string
	ast.Inspect(run.Body, func(n ast.Node) bool {
		assign, ok := n.(*ast.AssignStmt)
		if !ok || len(assign.Rhs) != 1 {
			return true
		}
		call, ok := assign.Rhs[0].(*ast.CallExpr)
		if !ok {
			return true
		}
		switch calledName(call) {
		case "newChatServiceOptions":
			bindName = identName(assign.Lhs, 1)
		case "startSession":
			managerName = identName(assign.Lhs, 2)
		}
		return true
	})
	if bindName == "" || bindName == "_" {
		t.Fatalf("Run does not keep the bind function newChatServiceOptions returns (got %q)", bindName)
	}
	if managerName == "" || managerName == "_" {
		t.Fatalf("Run does not keep the Session Manager startSession returns (got %q)", managerName)
	}

	// Only a statement of Run's own body runs on every boot; a call tucked inside a
	// closure or a branch might never.
	calls := 0
	for _, stmt := range run.Body.List {
		exprStmt, ok := stmt.(*ast.ExprStmt)
		if !ok {
			continue
		}
		call, ok := exprStmt.X.(*ast.CallExpr)
		if !ok || calledName(call) != bindName {
			continue
		}
		calls++
		if len(call.Args) != 1 {
			t.Errorf("Run calls %s with %d arguments, want the Session Manager", bindName, len(call.Args))
		} else if arg, ok := call.Args[0].(*ast.Ident); !ok || arg.Name != managerName {
			t.Errorf("Run binds %v to the chat hooks, want the Session Manager %q that startSession returned", call.Args[0], managerName)
		}
	}
	if calls != 1 {
		t.Fatalf("Run calls the bind function %d times, want exactly once", calls)
	}
}

func calledName(call *ast.CallExpr) string {
	if ident, ok := call.Fun.(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}

func identName(exprs []ast.Expr, index int) string {
	if index >= len(exprs) {
		return ""
	}
	if ident, ok := exprs[index].(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}
