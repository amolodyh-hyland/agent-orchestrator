package daemon

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Run starts the whole daemon and blocks, so a unit test cannot execute it. The
// Session Manager and the agent service are built after the Chat service, and the
// hooks that write the effective permission mode and the chosen model onto session
// records, and that report Codex account events, reach them only if Run hands each
// one to the matching bind function newChatServiceOptions returns. A Run that forgets
// to, discards the bindings, binds nil, or tucks the call into a closure or branch
// leaves those hooks quietly doing nothing while every other test passes, so the calls
// are checked in Run's source.
func TestRunBindsTheLateServicesToTheChatHooks(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "daemon.go", nil, 0)
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

	// The names Run gives the bindings, the Session Manager and the agent service.
	var bindings, manager, agents string
	defined := map[string]int{} // statement index at which Run defines each of those
	for i, stmt := range run.Body.List {
		assign, ok := stmt.(*ast.AssignStmt)
		if !ok || len(assign.Rhs) != 1 {
			continue
		}
		call, ok := assign.Rhs[0].(*ast.CallExpr)
		if !ok {
			continue
		}
		switch calledName(call) {
		case "newChatServiceOptions":
			bindings = identName(assign.Lhs, 1)
			defined[bindings] = i
		case "startSession":
			manager = identName(assign.Lhs, 2)
			defined[manager] = i
		case "agentsvc.NewWithDeps":
			agents = identName(assign.Lhs, 0)
			defined[agents] = i
		}
	}
	for what, name := range map[string]string{
		"the bindings newChatServiceOptions returns": bindings,
		"the Session Manager startSession returns":   manager,
		"the agent service agentsvc.NewWithDeps":     agents,
	} {
		if name == "" || name == "_" {
			t.Fatalf("Run does not keep %s as a top-level variable (got %q)", what, name)
		}
	}

	// Only a statement of Run's own body runs on every boot; a call tucked inside a
	// closure or a branch might never.
	want := map[string]string{
		bindings + ".Sessions": manager,
		bindings + ".Agents":   agents,
	}
	calls := map[string]int{}
	for i, stmt := range run.Body.List {
		exprStmt, ok := stmt.(*ast.ExprStmt)
		if !ok {
			continue
		}
		call, ok := exprStmt.X.(*ast.CallExpr)
		if !ok {
			continue
		}
		name := calledName(call)
		wantArg, bound := want[name]
		if !bound {
			continue
		}
		calls[name]++
		// Binding before the value exists would hand the hooks nothing.
		if i <= defined[wantArg] {
			t.Errorf("Run calls %s before it has built %q", name, wantArg)
		}
		// Binding after the value is first put to use leaves the hooks dead for as long
		// as whatever came first keeps running: a bind moved to the end of Run, past the
		// startup reconcile and the server, would pass every other check. So the bind has
		// to be the first thing Run does with the value once it exists.
		if first := firstStatementUsing(run.Body.List, defined[wantArg]+1, wantArg); first != i {
			t.Errorf("Run uses %q at statement %d before binding it to the chat hooks at statement %d (line %d)",
				wantArg, first, i, fset.Position(run.Body.List[first].Pos()).Line)
		}
		if len(call.Args) != 1 {
			t.Errorf("Run calls %s with %d arguments, want exactly %q", name, len(call.Args), wantArg)
		} else if arg, ok := call.Args[0].(*ast.Ident); !ok || arg.Name != wantArg {
			t.Errorf("Run calls %s with %v, want %q", name, call.Args[0], wantArg)
		}
	}
	for name := range want {
		if calls[name] != 1 {
			t.Errorf("Run calls %s %d times, want exactly once", name, calls[name])
		}
	}
}

// calledName names a call's target: a plain function as "f", a selector as "x.f".
func calledName(call *ast.CallExpr) string {
	switch fun := call.Fun.(type) {
	case *ast.Ident:
		return fun.Name
	case *ast.SelectorExpr:
		if x, ok := fun.X.(*ast.Ident); ok {
			return x.Name + "." + fun.Sel.Name
		}
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

// firstStatementUsing is the index of the first of stmts, from start on, that mentions
// the identifier name anywhere inside it, closures included. It is len(stmts) if none does.
func firstStatementUsing(stmts []ast.Stmt, start int, name string) int {
	for i := start; i < len(stmts); i++ {
		used := false
		ast.Inspect(stmts[i], func(n ast.Node) bool {
			if ident, ok := n.(*ast.Ident); ok && ident.Name == name {
				used = true
			}
			return !used
		})
		if used {
			return i
		}
	}
	return len(stmts)
}
