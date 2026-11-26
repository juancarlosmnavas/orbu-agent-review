#!/usr/bin/env python3
"""Parse Python with the standard AST only. Never import or execute the inspected project."""
import ast
import re
import json
import sys

SAFE_LITERALS = {"approved", "denied", "EUR", "USD", "eur", "usd"}
PERSONAL_LITERAL = re.compile(r"^(?:users?|clients?|customers?|patients?|contacts?|leads?|employees?|profiles?|persons?|people|members?|candidates?|students?|tenants?)$", re.I)
WEB_LITERAL = re.compile(r"^(?:web_search(?:_preview)?|google_search|web_browser|browse_web)$")
LLM_ENDPOINT = re.compile(r"^https://(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(?:ai|com)|api\.groq\.com|openrouter\.ai/api|api\.deepseek\.com|api\.x\.ai|api\.together\.xyz|api\.perplexity\.ai|[\w-]+\.openai\.azure\.com|bedrock-runtime\.[\w-]+\.amazonaws\.com)(?:[/:?]|$)|^https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|[\w-]+\.(?:local|internal|svc|lan))(?::\d+)?/(?:v1|api/(?:generate|chat))(?:[/?]|$)|^https?://\S+/v1/(?:chat/completions|completions|responses)$")
OPS = {ast.Gt: ">", ast.GtE: ">=", ast.Lt: "<", ast.LtE: "<=", ast.Eq: "==", ast.NotEq: "!=", ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.And: "&&", ast.Or: "||"}


def parse_file(file, source):
    try:
        tree = ast.parse(source, filename=file)
    except (SyntaxError, ValueError, RecursionError):
        return {"file": file, "status": "syntax_error", "functions": [], "imports": {}, "exports": {}, "aliases": []}
    functions, nodes, counts = [], {}, {}
    module = {"id": file + "#module", "file": file, "name": "module", "line": 1, "start": 1, "end": len(source.splitlines()) + 1, "async": False, "params": [], "locals": {}, "body": [], "parent": None}
    functions.append(module)

    def collect(node, parent):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            name = getattr(node, "name", "callback")
            fullname = parent["name"] + "." + name
            ordinal = counts.get(fullname, 0)
            counts[fullname] = ordinal + 1
            parameters = [arg.arg for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs]
            fn = {"id": file + "#" + fullname + ":" + str(ordinal), "file": file, "name": fullname[:120], "line": node.lineno, "start": min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])]), "end": getattr(node, "end_lineno", node.lineno), "async": isinstance(node, ast.AsyncFunctionDef), "params": parameters, "locals": {}, "body": [], "parent": parent["id"]}
            parent["locals"][name] = fn["id"]
            functions.append(fn)
            nodes[id(node)] = fn
            for child in ast.iter_child_nodes(node):
                collect(child, fn)
            return
        for child in ast.iter_child_nodes(node):
            collect(child, parent)

    collect(tree, module)

    def unknown():
        return {"t": "unknown"}

    def expression(node):
        if node is None:
            return unknown()
        if id(node) in nodes:
            return {"t": "function", "id": nodes[id(node)]["id"]}
        if isinstance(node, ast.Name):
            return {"t": "id", "name": node.id}
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool):
                return {"t": "boolean", "value": node.value}
            if isinstance(node.value, (int, float)) and not isinstance(node.value, complex):
                return {"t": "number", "value": node.value} if abs(node.value) <= 1e12 else unknown()
            if isinstance(node.value, str) and node.value in SAFE_LITERALS:
                return {"t": "enum", "value": node.value}
            if isinstance(node.value, str) and LLM_ENDPOINT.match(node.value):
                return {"t": "enum", "value": "llm_endpoint"}
            if isinstance(node.value, str) and PERSONAL_LITERAL.match(node.value):
                return {"t": "enum", "value": "personal_collection"}
            if isinstance(node.value, str) and WEB_LITERAL.match(node.value):
                return {"t": "enum", "value": "web_search"}
            return {"t": "unknown", "key": "literal:" + file + ":" + str(node.lineno) + ":" + str(node.col_offset)}
        if isinstance(node, ast.Attribute):
            return {"t": "property", "base": expression(node.value), "key": node.attr}
        if isinstance(node, ast.Subscript):
            if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str) and node.slice.value.isidentifier():
                return {"t": "property", "base": expression(node.value), "key": node.slice.value}
            return {"t": "dynamic", "base": expression(node.value)}
        if isinstance(node, ast.Await):
            return {"t": "await", "value": expression(node.value)}
        if isinstance(node, ast.Call):
            args = [expression(arg) for arg in node.args]
            if node.keywords:
                args.append({"t": "object", "properties": [[kw.arg or "__unresolved__", expression(kw.value)] for kw in node.keywords]})
            return {"t": "call", "callee": expression(node.func), "args": args, "line": node.lineno, "site": str(node.lineno) + ":" + str(node.col_offset), "construct": isinstance(node.func, ast.Name) and node.func.id[:1].isupper()}
        if isinstance(node, ast.Dict):
            return {"t": "object", "properties": [[key.value if isinstance(key, ast.Constant) and isinstance(key.value, str) and key.value.isidentifier() else "__unresolved__", expression(value)] for key, value in zip(node.keys, node.values)]}
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            return {"t": "array", "values": [expression(value) for value in node.elts]}
        if isinstance(node, ast.UnaryOp):
            return {"t": "unary", "op": "!" if isinstance(node.op, ast.Not) else "-" if isinstance(node.op, ast.USub) else "unsupported", "value": expression(node.operand)}
        if isinstance(node, ast.BinOp):
            return {"t": "binary", "op": OPS.get(type(node.op), "unsupported"), "left": expression(node.left), "right": expression(node.right)}
        if isinstance(node, ast.BoolOp):
            value = expression(node.values[0])
            for right in node.values[1:]:
                value = {"t": "binary", "op": OPS[type(node.op)], "left": value, "right": expression(right)}
            return value
        if isinstance(node, ast.Compare):
            values, left = [], node.left
            for op, right in zip(node.ops, node.comparators):
                values.append({"t": "binary", "op": OPS.get(type(op), "unsupported"), "left": expression(left), "right": expression(right)})
                left = right
            value = values[0]
            for right in values[1:]:
                value = {"t": "binary", "op": "&&", "left": value, "right": right}
            return value
        if isinstance(node, ast.IfExp):
            return {"t": "conditional", "test": expression(node.test), "yes": expression(node.body), "no": expression(node.orelse), "line": node.lineno}
        return {"t": "composite", "values": [expression(child) for child in ast.iter_child_nodes(node) if isinstance(child, ast.expr)], "unsupported": True}

    def body(statements):
        result = []
        for node in statements:
            at = getattr(node, "lineno", 1)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Import, ast.ImportFrom, ast.Pass)):
                continue
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                result.extend({"t": "assign", "name": target.id if isinstance(target, ast.Name) else None, "target": expression(target), "value": expression(node.value), "line": at} for target in targets)
            elif isinstance(node, ast.Expr):
                result.append({"t": "expression", "value": expression(node.value), "line": at})
            elif isinstance(node, ast.If):
                result.append({"t": "if", "test": expression(node.test), "yes": body(node.body), "no": body(node.orelse), "line": at})
            elif isinstance(node, (ast.Return, ast.Raise)):
                result.append({"t": "return" if isinstance(node, ast.Return) else "throw", "value": expression(node.value if isinstance(node, ast.Return) else node.exc), "line": at})
            elif isinstance(node, ast.Assert):
                # Python assertions disappear with -O. Never treat them as a production barrier.
                result.append({"t": "unknown", "reason": "python_assert", "line": at})
            elif isinstance(node, ast.Try):
                handler = body(node.handlers[0].body) if len(node.handlers) == 1 else [{"t": "alternatives", "branches": [body(item.body) for item in node.handlers], "line": at}] if node.handlers else None
                result.append({"t": "try", "body": body(node.body), "handler": handler, "otherwise": body(node.orelse), "final": body(node.finalbody), "line": at})
            elif isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
                result.append({"t": "loop", "body": body(node.body), "line": at})
                result.extend(body(node.orelse))
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                result.append({"t": "unknown", "reason": "context_manager", "line": at})
                result.extend(body(node.body))
            elif isinstance(node, ast.ClassDef):
                methods = [["__constructor" if child.name == "__init__" else child.name, {"t": "function", "id": nodes[id(child)]["id"]}] for child in node.body if id(child) in nodes]
                result.append({"t": "assign", "name": node.name, "value": {"t": "object", "class": True, "properties": methods}, "line": at})
            else:
                result.append({"t": "unknown", "reason": "unsupported_statement", "line": at})
        return result

    module["body"] = body(tree.body)
    for node in ast.walk(tree):
        if id(node) in nodes:
            nodes[id(node)]["body"] = [{"t": "return", "value": expression(node.body), "line": node.lineno}] if isinstance(node, ast.Lambda) else body(node.body)
            positional = node.args.posonlyargs + node.args.args
            defaults = {str(len(positional) - len(node.args.defaults) + i): expression(d) for i, d in enumerate(node.args.defaults)}
            defaults.update({str(len(positional) + i): expression(d) for i, d in enumerate(node.args.kw_defaults) if d is not None})
            nodes[id(node)]["defaults"] = defaults
    imports, exports = {}, {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports[alias.asname or alias.name.split(".")[0]] = {"from": alias.name, "name": "default"}
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imports[alias.asname or alias.name] = {"from": "." * node.level + (node.module or ""), "name": alias.name}
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            exports[node.name] = {"id": nodes[id(node)]["id"], "local": node.name}
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                if isinstance(target, ast.Name):
                    exports[target.id] = {"local": target.id}
        elif isinstance(node, ast.ClassDef):
            exports[node.name] = {"local": node.name}
    return {"file": file, "status": "parsed", "functions": functions, "imports": imports, "exports": exports, "aliases": []}


try:
    request = json.load(sys.stdin)
    result = [parse_file(item["file"], item["source"]) for item in request["files"]]
    json.dump(result, sys.stdout, allow_nan=False, separators=(",", ":"))
except Exception:
    # Never print source, parser excerpts, credentials or a traceback from inspected files.
    sys.stderr.write("python_ast_analysis_failed\n")
    sys.exit(1)
