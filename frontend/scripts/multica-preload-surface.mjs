import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const preloadRelative = "apps/desktop/src/preload/index.ts";
const declarationsRelative = "apps/desktop/src/preload/index.d.ts";
const outboundMethods = new Set(["send", "sendSync", "invoke", "postMessage", "sendToHost"]);
const inboundMethods = new Set(["on", "once", "addListener"]);
const bookkeepingMethods = new Set(["removeListener", "off", "removeAllListeners"]);

function unwrapExpression(node) {
	let current = node;
	while (current && (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isTypeAssertionExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	)) current = current.expression;
	return current;
}

function staticString(node) {
	if (!node) return undefined;
	node = unwrapExpression(node);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function propertyNameText(name) {
	if (!name) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	if (ts.isComputedPropertyName(name)) return staticString(name.expression);
	return undefined;
}

function isRelativeSpecifier(specifier) {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

function isRuntimeDependency(statement) {
	if (ts.isImportDeclaration(statement)) {
		const clause = statement.importClause;
		if (!clause) return true;
		if (clause.isTypeOnly) return false;
		if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
		return clause.namedBindings.elements.some((specifier) => !specifier.isTypeOnly);
	}
	if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) return false;
	if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
	return statement.exportClause.elements.some((specifier) => !specifier.isTypeOnly);
}

function hasExportModifier(node) {
	return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function variableName(node) {
	return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function getLine(sourceFile, nodeOrStart) {
	const start = typeof nodeOrStart === "number" ? nodeOrStart : nodeOrStart.getStart(sourceFile);
	return sourceFile.getLineAndCharacterOfPosition(start).line + 1;
}

function sourceText(sourceFile, node) {
	return node?.getText(sourceFile) ?? "<missing>";
}

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function getFunctionName(node) {
	if (node.name && ts.isIdentifier(node.name)) return node.name.text;
	if (node.name && !ts.isComputedPropertyName(node.name)) return propertyNameText(node.name);

	const parent = node.parent;
	if (ts.isVariableDeclaration(parent)) return variableName(parent);
	if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
	return undefined;
}

function isFunctionLike(node) {
	return ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node);
}

function enclosingFunctions(node) {
	const functions = [];
	for (let current = node.parent; current; current = current.parent) {
		if (isFunctionLike(current)) functions.push(current);
	}
	return functions;
}

function addUniqueIssue(issues, issue) {
	const key = `${issue.code}\0${issue.file}\0${issue.line}\0${issue.message}`;
	if (!issues.some((item) => item._key === key)) issues.push({ ...issue, _key: key });
}

function issueFor(issues, code, message, file, sourceFile, nodeOrStart) {
	addUniqueIssue(issues, {
		code,
		message,
		file,
		line: sourceFile ? getLine(sourceFile, nodeOrStart ?? 0) : 1,
	});
}

function parseSource(absPath, text, issues, relativeFile) {
	const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	for (const diagnostic of sourceFile.parseDiagnostics) {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		issueFor(issues, "parse-error", message, relativeFile, sourceFile, diagnostic.start ?? 0);
	}
	return sourceFile;
}

function moduleImports(sourceFile) {
	const imports = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const clause = statement.importClause;
		if (!clause || clause.isTypeOnly) continue;
		if (clause.name) imports.set(clause.name.text, { importedName: "default", statement });
		if (!clause.namedBindings) continue;
		if (ts.isNamespaceImport(clause.namedBindings)) {
			imports.set(clause.namedBindings.name.text, { importedName: "*", statement });
			continue;
		}
		for (const specifier of clause.namedBindings.elements) {
			if (specifier.isTypeOnly) continue;
			imports.set(specifier.name.text, {
				importedName: specifier.propertyName?.text ?? specifier.name.text,
				statement,
			});
		}
	}
	return imports;
}

function moduleConstants(sourceFile) {
	const constants = new Map();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
		for (const declaration of statement.declarationList.declarations) {
			const name = variableName(declaration);
			if (name) constants.set(name, { declaration, exported: hasExportModifier(statement) });
		}
	}
	return constants;
}

function constInitializerValue(declaration) {
	return declaration.initializer ? staticString(declaration.initializer) : undefined;
}

function bindingNames(name, result = []) {
	if (ts.isIdentifier(name)) result.push(name.text);
	else if (ts.isArrayBindingPattern(name) || ts.isObjectBindingPattern(name)) {
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) bindingNames(element.name, result);
		}
	}
	return result;
}

function namesInVariableStatement(statement) {
	const names = [];
	for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
	return names;
}

function namesInFunctionVars(functionNode) {
	const names = [];
	const visit = (node) => {
		if (node !== functionNode && isFunctionLike(node)) return;
		if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
			for (const declaration of node.declarations) bindingNames(declaration.name, names);
		}
		ts.forEachChild(node, visit);
	};
	if (functionNode.body) visit(functionNode.body);
	return names;
}

function namesDeclaredInScope(scope) {
	const names = [];
	if (ts.isBlock(scope)) {
		for (const statement of scope.statements) {
			if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.BlockScoped)) {
				names.push(...namesInVariableStatement(statement));
			} else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
				names.push(statement.name.text);
			}
		}
	} else if (isFunctionLike(scope)) {
		for (const parameter of scope.parameters) bindingNames(parameter.name, names);
		if (scope.name && ts.isIdentifier(scope.name) && !ts.isFunctionDeclaration(scope)) names.push(scope.name.text);
		names.push(...namesInFunctionVars(scope));
	} else if (ts.isCatchClause(scope)) {
		if (scope.variableDeclaration) bindingNames(scope.variableDeclaration.name, names);
	} else if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
		const initializer = scope.initializer;
		if (initializer && ts.isVariableDeclarationList(initializer)) {
			for (const declaration of initializer.declarations) bindingNames(declaration.name, names);
		}
	}
	return names;
}

function hasEnclosingBinding(node, name, stopAt) {
	for (let current = node.parent; current && current !== stopAt; current = current.parent) {
		if (namesDeclaredInScope(current).includes(name)) return true;
	}
	return false;
}

function isTypeOnlyPosition(node) {
	for (let current = node; current; current = current.parent) {
		if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
		if (ts.isImportDeclaration(current)) return Boolean(current.importClause?.isTypeOnly);
		if (ts.isImportSpecifier(current) && current.isTypeOnly) return true;
		if (ts.isExportDeclaration(current) && current.isTypeOnly) return true;
		if (ts.isExportSpecifier(current) && current.isTypeOnly) return true;
	}
	return false;
}

function isRuntimeElectronModuleReference(statement) {
	if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
		!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "electron") return false;
	if (ts.isImportDeclaration(statement)) {
		const clause = statement.importClause;
		if (!clause) return true;
		if (clause.isTypeOnly) return false;
		if (clause.name || !clause.namedBindings) return true;
		if (ts.isNamespaceImport(clause.namedBindings)) return true;
		return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
	}
	if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) return false;
	if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
	return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

function unsupportedElectronReferences(sourceFile) {
	const references = [];
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "electron") {
			const clause = statement.importClause;
			if (clause?.isTypeOnly) continue;
			if (!clause || clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) {
				references.push(statement);
			}
		} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier?.text === "electron" && !statement.isTypeOnly) {
			references.push(statement);
		} else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly &&
			ts.isExternalModuleReference(statement.moduleReference) &&
			ts.isStringLiteral(statement.moduleReference.expression) && statement.moduleReference.expression.text === "electron") {
			references.push(statement);
		}
	}
	const visit = (node) => {
		if (!isTypeOnlyPosition(node) && ts.isCallExpression(node) && node.arguments.length > 0 && staticString(node.arguments[0]) === "electron") {
			if ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword) {
				references.push(node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return references;
}

function importedModuleIssue(sourceFile, relativeFile) {
	let offendingIdentifier;
	const findIdentifier = (node) => {
		if (!isTypeOnlyPosition(node) && ts.isIdentifier(node) && (node.text === "ipcRenderer" || node.text === "contextBridge")) {
			offendingIdentifier ??= node;
			return;
		}
		ts.forEachChild(node, findIdentifier);
	};
	findIdentifier(sourceFile);
	if (offendingIdentifier) return { node: offendingIdentifier, reason: offendingIdentifier.text };
	for (const statement of sourceFile.statements) {
		if (isRuntimeElectronModuleReference(statement)) return { node: statement, reason: 'runtime import or export from "electron"' };
	}
	return undefined;
}

function isAssignmentOperator(kind) {
	return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function assignmentTargetHasName(target, name) {
	if (ts.isParenthesizedExpression(target)) return assignmentTargetHasName(target.expression, name);
	if (ts.isIdentifier(target)) return target.text === name;
	if (ts.isArrayLiteralExpression(target) || ts.isArrayBindingPattern(target)) {
		return target.elements.some((element) => !ts.isOmittedExpression(element) && assignmentTargetHasName(ts.isBindingElement(element) ? element.name : element, name));
	}
	if (ts.isObjectLiteralExpression(target) || ts.isObjectBindingPattern(target)) {
		return target.properties.some((property) => {
			if (ts.isSpreadAssignment(property) || ts.isSpreadElement(property)) return assignmentTargetHasName(property.expression, name);
			if (ts.isShorthandPropertyAssignment(property)) return property.name.text === name;
			if (ts.isBindingElement(property)) return assignmentTargetHasName(property.name, name);
			if (ts.isPropertyAssignment(property)) return assignmentTargetHasName(property.initializer, name);
			return false;
		});
	}
	return false;
}

function isWithin(node, ancestor) {
	for (let current = node; current; current = current.parent) {
		if (current === ancestor) return true;
	}
	return false;
}

function isParameterWrite(node, name, functionNode) {
	for (let current = node.parent; current && current !== functionNode; current = current.parent) {
		if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind) &&
			isWithin(node, current.left) && assignmentTargetHasName(current.left, name)) return true;
		if ((ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) &&
			(current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken) &&
			isWithin(node, current.operand) && assignmentTargetHasName(current.operand, name)) return true;
		if ((ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
			!ts.isVariableDeclarationList(current.initializer) && isWithin(node, current.initializer) &&
			assignmentTargetHasName(current.initializer, name)) return true;
		if (namesDeclaredInScope(current).includes(name)) return false;
	}
	return false;
}

function shadowingParameterAtUse(call, functionNode, name) {
	if (namesInFunctionVars(functionNode).includes(name)) return functionNode.body;
	for (let current = call.parent; current && current !== functionNode; current = current.parent) {
		if (namesDeclaredInScope(current).includes(name)) return current;
	}
	return undefined;
}

function isIdentifierReference(node) {
	const parent = node.parent;
	if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) ||
		ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)) && parent.name === node) return false;
	if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
		ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === node) return false;
	if (ts.isImportClause(parent) && parent.name === node) return false;
	if (ts.isImportSpecifier(parent) && parent.name === node) return false;
	if (ts.isNamespaceImport(parent) && parent.name === node) return false;
	if (ts.isBindingElement(parent) && parent.name === node) return false;
	if (ts.isCatchClause(parent) && parent.variableDeclaration?.name === node) return false;
	if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
	return true;
}

export function extractPreloadSurface({ root, readFile, fileExists }) {
	const rootPath = path.resolve(root);
	const read = readFile ?? ((absPath) => fs.readFileSync(absPath, "utf8"));
	const exists = fileExists ?? ((absPath) => fs.existsSync(absPath));
	const issues = [];
	const parsed = new Map();
	const importTargets = new Map();

	const relativeToRoot = (absPath) => path.relative(rootPath, absPath).split(path.sep).join("/");
	const resolveImport = (fromPath, specifier) => {
		const base = path.resolve(path.dirname(fromPath), specifier);
		const candidates = [`${base}.ts`, path.join(base, "index.ts")];
		return candidates.find((candidate) => exists(candidate));
	};

	const loadModule = (absPath, importSite) => {
		const normalizedPath = path.resolve(absPath);
		if (parsed.has(normalizedPath)) return parsed.get(normalizedPath);
		let text;
		try {
			text = read(normalizedPath);
		} catch (error) {
			if (importSite) {
				issueFor(
					issues,
					"missing-import",
					`Could not read relative import ${JSON.stringify(importSite.specifier)}: ${error.message}`,
					importSite.relativeFile,
					importSite.sourceFile,
					importSite.statement,
				);
			} else {
				issueFor(issues, "missing-preload", `Could not read preload file: ${error.message}`, preloadRelative, undefined, 0);
			}
			return undefined;
		}
		const sourceFile = parseSource(normalizedPath, text, issues, relativeToRoot(normalizedPath));
		parsed.set(normalizedPath, sourceFile);

		for (const statement of sourceFile.statements) {
			if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
				!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || !isRuntimeDependency(statement)) continue;
			const specifier = statement.moduleSpecifier.text;
			if (!isRelativeSpecifier(specifier)) continue;
			const resolved = resolveImport(normalizedPath, specifier);
			if (!resolved) {
				issueFor(
					issues,
					"missing-import",
					`Could not resolve relative import ${JSON.stringify(specifier)} (tried ${JSON.stringify(`${path.relative(rootPath, path.resolve(path.dirname(normalizedPath), specifier))}.ts`)} and index.ts)`,
					relativeToRoot(normalizedPath),
					sourceFile,
					statement,
				);
				continue;
			}
			importTargets.set(`${normalizedPath}\0${specifier}`, resolved);
			loadModule(resolved, {
				specifier,
				relativeFile: relativeToRoot(normalizedPath),
				sourceFile,
				statement,
			});
		}
		return sourceFile;
	};

	const preloadPath = path.resolve(rootPath, preloadRelative);
	const preloadSource = loadModule(preloadPath);
	let declarationsSource;
	const declarationsPath = path.resolve(rootPath, declarationsRelative);
	if (exists(declarationsPath)) {
		try {
			declarationsSource = parseSource(declarationsPath, read(declarationsPath), issues, declarationsRelative);
		} catch (error) {
			issueFor(issues, "missing-declarations", `Could not read declarations file: ${error.message}`, declarationsRelative, undefined, 0);
		}
	} else {
		issueFor(issues, "missing-declarations", "Preload declarations file is missing", declarationsRelative, undefined, 0);
	}

	if (!preloadSource) {
		return {
			root,
			preloadFile: preloadRelative,
			globals: [],
			entries: [],
			members: {},
			declaredMembers: {},
			issues: finishIssues(issues),
		};
	}

	const relativeFile = relativeToRoot(preloadPath);
	const constsByFile = new Map([...parsed].map(([absPath, sourceFile]) => [absPath, moduleConstants(sourceFile)]));
	const importsByFile = new Map([...parsed].map(([absPath, sourceFile]) => [absPath, moduleImports(sourceFile)]));
	for (const [absPath, sourceFile] of parsed) {
		for (const reference of unsupportedElectronReferences(sourceFile)) {
			issueFor(
				issues,
				"unsupported-electron-import",
				'Unsupported runtime use of the "electron" module; use named imports',
				relativeToRoot(absPath),
				sourceFile,
				reference,
			);
		}
		if (absPath === preloadPath) continue;
		const issue = importedModuleIssue(sourceFile, relativeToRoot(absPath));
		if (issue) {
			issueFor(
				issues,
				"ipc-in-imported-module",
				`Imported module contains ${issue.reason}`,
				relativeToRoot(absPath),
				sourceFile,
				issue.node,
			);
		}
	}

	function exposedObjectFor(expression, filePath) {
		expression = unwrapExpression(expression);
		if (ts.isObjectLiteralExpression(expression)) return { objectLiteral: expression };
		if (!ts.isIdentifier(expression)) return undefined;
		if (hasEnclosingBinding(expression, expression.text, parsed.get(filePath))) return undefined;
		const binding = constsByFile.get(filePath)?.get(expression.text);
		if (binding) {
			const initializer = unwrapExpression(binding.declaration.initializer);
			return initializer && ts.isObjectLiteralExpression(initializer) ? { objectLiteral: initializer } : undefined;
		}
		const imported = importsByFile.get(filePath)?.get(expression.text);
		if (imported && !isRelativeSpecifier(imported.statement.moduleSpecifier.text)) return { external: true };
		return undefined;
	}

	function directConstValue(filePath, name) {
		const constants = constsByFile.get(filePath);
		const binding = constants?.get(name);
		if (binding) return constInitializerValue(binding.declaration);

		const imported = importsByFile.get(filePath)?.get(name);
		if (!imported) return undefined;
		const specifier = imported.statement.moduleSpecifier.text;
		const importedPath = importTargets.get(`${filePath}\0${specifier}`);
		const importedBinding = constsByFile.get(importedPath)?.get(imported.importedName);
		if (!importedBinding?.exported) return undefined;
		return constInitializerValue(importedBinding.declaration);
	}

	function resolveChannel(expression, filePath) {
		expression = unwrapExpression(expression);
		const literal = staticString(expression);
		if (literal !== undefined) return literal;
		if (!ts.isIdentifier(expression)) return undefined;
		const first = directConstValue(filePath, expression.text);
		if (first !== undefined) {
			if (hasEnclosingBinding(expression, expression.text, parsed.get(filePath))) {
				issueFor(issues, "shadowed-channel", `Module channel ${expression.text} is shadowed at its use site`, relativeToRoot(filePath), parsed.get(filePath), expression);
				return undefined;
			}
			return first;
		}
		const constants = constsByFile.get(filePath);
		const binding = constants?.get(expression.text);
		const imported = importsByFile.get(filePath)?.get(expression.text);
		const declaration = binding?.declaration;
		const initializer = declaration?.initializer;
		if (initializer && ts.isIdentifier(initializer)) {
			const aliased = directConstValue(filePath, initializer.text);
			if (aliased !== undefined) {
				if (hasEnclosingBinding(expression, expression.text, parsed.get(filePath))) {
					issueFor(issues, "shadowed-channel", `Module channel ${expression.text} is shadowed at its use site`, relativeToRoot(filePath), parsed.get(filePath), expression);
					return undefined;
				}
				return aliased;
			}
		}
		if (!imported) return undefined;
		const specifier = imported.statement.moduleSpecifier.text;
		const importedPath = importTargets.get(`${filePath}\0${specifier}`);
		const importedBinding = constsByFile.get(importedPath)?.get(imported.importedName);
		if (importedBinding?.exported && importedBinding.declaration.initializer && ts.isIdentifier(importedBinding.declaration.initializer)) {
			const aliased = directConstValue(importedPath, importedBinding.declaration.initializer.text);
			if (aliased !== undefined) {
				if (hasEnclosingBinding(expression, expression.text, parsed.get(filePath))) {
					issueFor(issues, "shadowed-channel", `Module channel ${expression.text} is shadowed at its use site`, relativeToRoot(filePath), parsed.get(filePath), expression);
					return undefined;
				}
				return aliased;
			}
		}
		return undefined;
	}

	const exposeCalls = [];
	const exposedGlobals = new Set();
	const exposedObjects = [];
	const fallbackAssignments = [];
	const visitPreload = (node) => {
		if (ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) &&
			node.expression.expression.text === "contextBridge" &&
			node.expression.name.text === "exposeInMainWorld") {
			exposeCalls.push(node);
			const name = staticString(node.arguments[0]);
			if (name === undefined) {
				issueFor(issues, "dynamic-global-name", `exposeInMainWorld name is not a literal: ${sourceText(preloadSource, node.arguments[0])}`, relativeFile, preloadSource, node);
			} else {
				exposedGlobals.add(name);
				const exposed = node.arguments[1] ? exposedObjectFor(node.arguments[1], preloadPath) : undefined;
				if (!exposed) {
					issueFor(
						issues,
						"unsupported-exposed-api",
						`Unsupported exposed API value: ${sourceText(preloadSource, node.arguments[1])}`,
						relativeFile,
						preloadSource,
						node.arguments[1] ?? node,
					);
				} else if (exposed.objectLiteral && !exposedObjects.some((item) => item.name === name)) {
					exposedObjects.push({ name, objectLiteral: exposed.objectLiteral });
				}
			}
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) &&
			node.left.expression.text === "window" && ts.isIdentifier(node.right)) {
			fallbackAssignments.push({ name: node.left.name.text, node });
		}
		ts.forEachChild(node, visitPreload);
	};
	visitPreload(preloadSource);

	if (exposeCalls.length === 0) issueFor(issues, "no-exposed-globals", "No exposeInMainWorld call was found", relativeFile, preloadSource, 0);
	const exposedNames = [...exposedGlobals].sort();
	const fallbackNames = [...new Set(fallbackAssignments.map((item) => item.name))].sort();
	if (JSON.stringify(exposedNames) !== JSON.stringify(fallbackNames)) {
		issueFor(
			issues,
			"global-mismatch",
			`Exposed globals ${JSON.stringify(exposedNames)} differ from window fallback globals ${JSON.stringify(fallbackNames)}`,
			relativeFile,
			preloadSource,
			fallbackAssignments[0]?.node ?? 0,
		);
	}

	const members = {};
	const apiPathByCall = new Map();
	const validateObjectMembers = (objectLiteral) => {
		for (const member of objectLiteral.properties) {
			if (ts.isSpreadAssignment(member)) {
				issueFor(issues, "unsupported-exposed-member", "Spread members are not supported in an exposed API object", relativeFile, preloadSource, member);
				continue;
			}
			const name = member.name;
			const key = propertyNameText(name);
			if (!name || key === undefined || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
				issueFor(issues, "unsupported-exposed-member", `Exposed API member name is not statically supported: ${sourceText(preloadSource, name)}`, relativeFile, preloadSource, name ?? member);
			}
		}
	};
	for (const { name, objectLiteral } of exposedObjects) {
		validateObjectMembers(objectLiteral);
		const keys = objectLiteral.properties.map((member) => propertyNameText(member.name)).filter((key) => key !== undefined);
		members[name] = [...new Set(keys)].sort();
		const walkApiObject = (node, currentPath, isRoot = false) => {
			if (ts.isCallExpression(node)) apiPathByCall.set(node, currentPath.join("."));
			if (!isRoot && ts.isObjectLiteralExpression(node)) {
				validateObjectMembers(node);
				for (const member of node.properties) {
					const key = propertyNameText(member.name);
					walkApiObject(member, key === undefined ? currentPath : [...currentPath, key]);
				}
				return;
			}
			ts.forEachChild(node, (child) => walkApiObject(child, currentPath));
		};
		for (const member of objectLiteral.properties) {
			const key = propertyNameText(member.name);
			walkApiObject(member, key === undefined ? [name] : [name, key]);
		}
	}

	for (const [absPath, sourceFile] of parsed) {
		const relativeModule = relativeToRoot(absPath);
		const scanElectronMembers = (node) => {
			if (isTypeOnlyPosition(node)) return;
			if (ts.isPropertyAccessExpression(node) && node.name.text === "ipcRenderer") {
				issueFor(issues, "ipcrenderer-alias", `ipcRenderer is accessed as a property: ${sourceText(sourceFile, node)}`, relativeModule, sourceFile, node);
			}
			if (ts.isElementAccessExpression(node) && staticString(node.argumentExpression) === "ipcRenderer") {
				issueFor(issues, "ipcrenderer-alias", `ipcRenderer is accessed with a computed property: ${sourceText(sourceFile, node)}`, relativeModule, sourceFile, node);
			}
			ts.forEachChild(node, scanElectronMembers);
		};
		scanElectronMembers(sourceFile);
	}

	const ipcNames = new Set(["ipcRenderer"]);
	for (const statement of preloadSource.statements) {
		if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
		for (const specifier of statement.importClause.namedBindings.elements) {
			if (specifier.isTypeOnly) continue;
			if ((specifier.propertyName?.text ?? specifier.name.text) !== "ipcRenderer") continue;
			const localName = specifier.name.text;
			ipcNames.add(localName);
			if (localName !== "ipcRenderer") {
				issueFor(issues, "ipcrenderer-alias", `ipcRenderer is imported as ${localName}`, relativeFile, preloadSource, specifier);
			}
		}
	}

	const ipcCalls = [];
	const scanIpc = (node) => {
		if (isTypeOnlyPosition(node)) return;
		if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && ipcNames.has(node.expression.text)) {
			issueFor(issues, "computed-ipc-access", `Computed ipcRenderer access: ${sourceText(preloadSource, node)}`, relativeFile, preloadSource, node);
		}
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
			ts.isIdentifier(node.expression.expression) && ipcNames.has(node.expression.expression.text)) {
			ipcCalls.push(node);
		}
		if (ts.isIdentifier(node) && ipcNames.has(node.text)) {
			let inImport = false;
			for (let current = node; current; current = current.parent) {
				if (ts.isImportDeclaration(current)) {
					inImport = true;
					break;
				}
			}
			if (!inImport) {
				const parent = node.parent;
				const computed = ts.isElementAccessExpression(parent) && parent.expression === node;
				const receiver = ts.isPropertyAccessExpression(parent) && parent.expression === node &&
					ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
				if (!computed && !receiver) {
					issueFor(issues, "ipcrenderer-alias", `ipcRenderer is used outside a property-access call receiver: ${sourceText(preloadSource, node)}`, relativeFile, preloadSource, node);
				}
			}
		}
		ts.forEachChild(node, scanIpc);
	};
	scanIpc(preloadSource);

	const helpers = new Map();
	const watchedCalls = [];
	const addCallIssue = (code, message, node) => issueFor(issues, code, message, relativeFile, preloadSource, node);
	for (const call of ipcCalls) {
		const method = call.expression.name.text;
		const watched = outboundMethods.has(method) || inboundMethods.has(method);
		const bookkeeping = bookkeepingMethods.has(method);
		if (!watched && !bookkeeping) continue;
		const channelArgument = call.arguments[0];
		if (!channelArgument) {
			addCallIssue("unresolved-channel", `Unresolved channel argument in ${sourceText(preloadSource, call)}`, call);
			continue;
		}
		let parameterFunction;
		let parameterIndex = -1;
		const channelValue = unwrapExpression(channelArgument);
		if (ts.isIdentifier(channelValue)) {
			for (const functionNode of enclosingFunctions(call)) {
				const index = functionNode.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === channelValue.text);
				if (index >= 0) {
					parameterFunction = functionNode;
					parameterIndex = index;
					break;
				}
			}
		}
		if (parameterFunction) {
			const functionName = getFunctionName(parameterFunction);
			if (!functionName) {
				addCallIssue("unresolved-helper-channel", `Helper channel parameter has no function name: ${sourceText(preloadSource, channelArgument)}`, call);
				continue;
			}
			const key = `${functionName}\0${parameterIndex}`;
			const helper = helpers.get(key) ?? { name: functionName, node: parameterFunction, index: parameterIndex, calls: [] };
			helper.calls.push({ call, method, watched });
			helpers.set(key, helper);
		} else {
			const channel = resolveChannel(channelArgument, preloadPath);
			if (channel === undefined) {
				addCallIssue("unresolved-channel", `Unresolved channel ${JSON.stringify(sourceText(preloadSource, channelArgument))} in ${sourceText(preloadSource, call)}`, call);
				continue;
			}
			if (watched) watchedCalls.push({ call, method, channel, filePath: preloadPath });
		}
	}

	const helperFunctions = new Set([...helpers.values()].map((helper) => helper.node));
	const allCalls = [];
	const collectCalls = (node) => {
		if (ts.isCallExpression(node)) allCalls.push(node);
		ts.forEachChild(node, collectCalls);
	};
	collectCalls(preloadSource);

	function fallbackApi(call) {
		const apiPath = apiPathByCall.get(call);
		if (apiPath) return apiPath;
		for (const enclosing of enclosingFunctions(call)) {
			if (helperFunctions.has(enclosing)) return `(helper) ${getFunctionName(enclosing) ?? "<anonymous>"}`;
			const name = getFunctionName(enclosing);
			if (name) return `(module) ${name}`;
		}
		return "(module)";
	}

	const entryCandidates = [];
	const addEntry = (api, channel, method, entryCall) => {
		const kind = inboundMethods.has(method) ? "on" : method;
		const direction = kind === "on" ? "inbound" : "outbound";
		entryCandidates.push({
			api,
			channel,
			kind,
			direction,
			file: relativeFile,
			line: getLine(preloadSource, entryCall),
			start: entryCall.getStart(preloadSource),
		});
	};

	for (const { call, method, channel } of watchedCalls) {
		const helperFunction = enclosingFunctions(call).find((functionNode) => helperFunctions.has(functionNode));
		const api = helperFunction ? `(helper) ${getFunctionName(helperFunction) ?? "<anonymous>"}` : fallbackApi(call);
		addEntry(api, channel, method, call);
	}

	for (const helper of helpers.values()) {
		const helperDeclaration = ts.isIdentifier(helper.node.name) ? helper.node.name :
			ts.isVariableDeclaration(helper.node.parent) && ts.isIdentifier(helper.node.parent.name) ? helper.node.parent.name : undefined;
		const escapedReferences = [];
		const findHelperReferences = (node) => {
			if (ts.isIdentifier(node) && node.text === helper.name && node !== helperDeclaration && isIdentifierReference(node) &&
				!(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
				!hasEnclosingBinding(node, helper.name, preloadSource)) {
				escapedReferences.push(node);
			}
			ts.forEachChild(node, findHelperReferences);
		};
		findHelperReferences(preloadSource);
		for (const reference of escapedReferences) {
			issueFor(issues, "escaped-helper", `Helper ${helper.name} is referenced outside a direct call`, relativeFile, preloadSource, reference);
		}

		const parameter = helper.node.parameters[helper.index];
		if (parameter && ts.isIdentifier(parameter.name)) {
			const parameterName = parameter.name.text;
			for (const { call } of helper.calls) {
				const shadow = shadowingParameterAtUse(call, helper.node, parameterName);
				if (shadow) {
					issueFor(issues, "shadowed-channel-parameter", `Helper channel parameter ${parameterName} is redeclared`, relativeFile, preloadSource, shadow);
				}
			}
			const findVarReinitializations = (node) => {
				if (isTypeOnlyPosition(node)) return;
				if (ts.isVariableDeclaration(node) && node.initializer && bindingNames(node.name).includes(parameterName) &&
					ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped)) {
					issueFor(issues, "reassigned-channel-parameter", `Helper channel parameter ${parameterName} is reassigned`, relativeFile, preloadSource, node);
				}
				ts.forEachChild(node, findVarReinitializations);
			};
			findVarReinitializations(helper.node.body);
			const findParameterWrites = (node) => {
				if (isTypeOnlyPosition(node)) return;
				if (ts.isIdentifier(node) && node.text === parameterName &&
					!hasEnclosingBinding(node, parameterName, helper.node) && isParameterWrite(node, parameterName, helper.node)) {
					issueFor(issues, "reassigned-channel-parameter", `Helper channel parameter ${parameterName} is reassigned`, relativeFile, preloadSource, node);
				}
				if (node !== helper.node && isFunctionLike(node) && node.parameters.some((item) => bindingNames(item.name).includes(parameterName))) return;
				ts.forEachChild(node, findParameterWrites);
			};
			findParameterWrites(helper.node);
		}

		const callsites = allCalls.filter((call) => ts.isIdentifier(call.expression) && call.expression.text === helper.name &&
			!hasEnclosingBinding(call.expression, helper.name, preloadSource));
		if (callsites.length === 0) {
			issueFor(issues, "unresolved-helper-channel", `Helper ${helper.name} has no call sites`, relativeFile, preloadSource, helper.node);
			continue;
		}
		for (const callsite of callsites) {
			const argument = callsite.arguments[helper.index];
			const channel = argument ? resolveChannel(argument, preloadPath) : undefined;
			if (channel === undefined) {
				issueFor(
					issues,
					"unresolved-helper-channel",
					`Unresolved channel at ${helper.name} call site: ${sourceText(preloadSource, argument)}`,
					relativeFile,
					preloadSource,
					callsite,
				);
				continue;
			}
			for (const use of helper.calls) {
				if (!use.watched) continue;
				const api = apiPathByCall.get(callsite) ?? fallbackApi(callsite);
				addEntry(api, channel, use.method, callsite);
			}
		}
	}
	const entries = [];
	const entryKeys = new Set();
	for (const candidate of entryCandidates.sort((left, right) => left.start - right.start)) {
		const key = `${candidate.api}\0${candidate.channel}\0${candidate.kind}`;
		if (entryKeys.has(key)) continue;
		entryKeys.add(key);
		const { start, ...entry } = candidate;
		entries.push(entry);
	}

	const declaredMembers = {};
	if (declarationsSource) {
		const interfaces = new Map();
		const windows = [];
		const scanDeclarations = (node) => {
			if (ts.isInterfaceDeclaration(node)) {
				if (node.name.text === "Window") windows.push(node);
				else interfaces.set(node.name.text, node);
			}
			ts.forEachChild(node, scanDeclarations);
		};
		scanDeclarations(declarationsSource);
		const windowTypes = new Map();
		for (const windowInterface of windows) {
			for (const member of windowInterface.members) {
				if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
				const globalName = propertyNameText(member.name);
				if (!globalName || !ts.isTypeReferenceNode(member.type) || !ts.isIdentifier(member.type.typeName)) continue;
				windowTypes.set(globalName, member.type.typeName.text);
			}
		}
		for (const globalName of exposedNames) {
			const typeName = windowTypes.get(globalName);
			const interfaceNode = typeName ? interfaces.get(typeName) : undefined;
			if (!interfaceNode) continue;
			const names = interfaceNode.members
				.map((member) => propertyNameText(member.name))
				.filter((name) => name !== undefined);
			declaredMembers[globalName] = [...new Set(names)].sort();
		}
	}

	return {
		root,
		preloadFile: preloadRelative,
		globals: exposedNames,
		entries: entries.sort((left, right) => compareText(left.channel, right.channel) || compareText(left.kind, right.kind) || compareText(left.api, right.api)),
		members: sortedObject(members),
		declaredMembers: sortedObject(declaredMembers),
		issues: finishIssues(issues),
	};
}

function sortedObject(object) {
	return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
}

function finishIssues(issues) {
	return issues
		.map(({ _key, ...issue }) => issue)
		.sort((left, right) => compareText(left.file, right.file) || left.line - right.line || compareText(left.code, right.code) || compareText(left.message, right.message));
}
