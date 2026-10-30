"""The shared model of the cell, read from cell_model.json (exported from source/src/cell-model.js
by source/export_model.js), and the guard expression language of its state machines.

Grammar (the same as in cell-model.js):
    or    := and ('|' and)*
    and   := unary ('&' unary)*
    unary := '!' unary | '(' or ')' | name [rel value]
    rel   := = | != | < | <= | > | >=
Names may contain letters, digits, '.', '_' and '-'. A name with a `def` in SIGNALS is a derived
signal and is replaced by its definition. Values are numbers, constants of CONST or plain words
(state ids, job names).
"""
import json
import os
import re

_TOKEN = re.compile(r"!=|<=|>=|[!&|()=<>]|[A-Za-z0-9_.-]+|\S")
_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
_RELS = ("=", "!=", "<", "<=", ">", ">=")
_NEGATE = {"=": "!=", "!=": "=", "<": ">=", "<=": ">", ">": "<=", ">=": "<"}
_SYMBOL = {"=": "=", "!=": "≠", "<": "<", "<=": "≤", ">": ">", ">=": "≥"}

DEFAULT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cell_model.json")


class Model:
    """Model data plus parsed and compiled guards (cached by their source text)."""

    def __init__(self, data):
        self.data = data
        for key in ("T", "RULES", "CHECKPOINTS", "SLOTS", "SIGNALS", "CONST", "RUNGS", "PROPERTIES",
                    "OUTPUTS", "JOBS", "MACHINES", "SETUP_MACHINES", "KPI", "BASELINE"):
            setattr(self, key, data[key])
        self._parsed = {}
        self._compiled = {}

    # ------------------------------------------------------------------ parsing
    def parse(self, src):
        if src in self._parsed:
            return self._parsed[src]
        toks = _TOKEN.findall(src)
        pos = [0]

        def fail(msg):
            raise ValueError(f'guard "{src}": {msg}')

        def peek():
            return toks[pos[0]] if pos[0] < len(toks) else None

        def take(expected=None):
            tok = peek()
            if expected is not None and tok != expected:
                fail(f"expected {expected} at token {pos[0]}")
            pos[0] += 1
            return tok

        def p_or():
            args = [p_and()]
            while peek() == "|":
                take()
                args.append(p_and())
            return {"op": "or", "args": args} if len(args) > 1 else args[0]

        def p_and():
            args = [p_unary()]
            while peek() == "&":
                take()
                args.append(p_unary())
            return {"op": "and", "args": args} if len(args) > 1 else args[0]

        def p_unary():
            tok = take()
            if tok is None:
                fail("unexpected end")
            if tok == "!":
                return {"op": "not", "arg": p_unary()}
            if tok == "(":
                e = p_or()
                take(")")
                return e
            if not _NAME.match(tok):
                fail(f'unexpected "{tok}"')
            if peek() in _RELS:
                rel = take()
                return {"op": "cmp", "name": tok, "rel": rel, "value": take()}
            return {"op": "sig", "name": tok}

        e = p_or()
        if pos[0] != len(toks):
            fail(f'unexpected "{toks[pos[0]]}"')
        self._parsed[src] = e
        return e

    def const_val(self, v):
        if v in self.CONST:
            return self.CONST[v]
        if _NUMBER.match(v):
            return float(v) if "." in v else int(v)
        return v

    # ------------------------------------------------------------------ evaluation
    def compile(self, src):
        """Guard source -> function(read) -> bool, where read(name) gives the value of a name."""
        if src in self._compiled:
            return self._compiled[src]
        fn = self._compile_node(self.parse(src))
        self._compiled[src] = fn
        return fn

    def _compile_node(self, e):
        op = e["op"]
        if op == "and":
            parts = [self._compile_node(a) for a in e["args"]]
            return lambda read: all(p(read) for p in parts)
        if op == "or":
            parts = [self._compile_node(a) for a in e["args"]]
            return lambda read: any(p(read) for p in parts)
        if op == "not":
            inner = self._compile_node(e["arg"])
            return lambda read: not inner(read)
        name = e["name"]
        sig = self.SIGNALS.get(name)
        if op == "sig":
            if sig and sig.get("def"):
                return self.compile(sig["def"])
            return lambda read: bool(read(name))
        # comparison
        b = self.const_val(e["value"])
        if sig and sig.get("def"):
            get = self.compile(sig["def"])
        else:
            def get(read):
                return read(name)
        rel = e["rel"]
        if rel == "=":
            return lambda read: _same(get(read), b)
        if rel == "!=":
            return lambda read: not _same(get(read), b)
        if rel == "<":
            return lambda read: get(read) < b
        if rel == "<=":
            return lambda read: get(read) <= b
        if rel == ">":
            return lambda read: get(read) > b
        return lambda read: get(read) >= b

    def evaluate(self, src, read):
        return self.compile(src)(read)

    def names(self, src, deep=False, out=None):
        """Names an expression reads (derived signals expanded when deep)."""
        out = set() if out is None else out
        e = self.parse(src) if isinstance(src, str) else src
        if e["op"] in ("and", "or"):
            for a in e["args"]:
                self.names(a, deep, out)
        elif e["op"] == "not":
            self.names(e["arg"], deep, out)
        else:
            out.add(e["name"])
            sig = self.SIGNALS.get(e["name"])
            if deep and sig and sig.get("def"):
                self.names(sig["def"], deep, out)
        return out

    # ------------------------------------------------------------------ texts (log and fault messages)
    def phrase(self, e, neg=False):
        op = e["op"]
        if op == "not":
            return self.phrase(e["arg"], not neg)
        if op == "sig":
            sig = self.SIGNALS.get(e["name"])
            if not sig:
                return ("NOT " if neg else "") + e["name"]
            return (sig.get("off") or "not " + sig["on"]) if neg else sig["on"]
        if op == "cmp":
            rel = _NEGATE[e["rel"]] if neg else e["rel"]
            if e["name"] in self.SLOTS:
                return f'{self.SLOTS[e["name"]]["ref"]} {"in" if rel == "=" else "not in"} {e["value"]}'
            sig = self.SIGNALS.get(e["name"], {})
            phrases = sig.get("phrases") or {}
            if rel + e["value"] in phrases:
                return phrases[rel + e["value"]]
            return f'{sig.get("text") or e["name"]} {_SYMBOL[rel]} {self.const_val(e["value"])}'
        parts = [self.phrase(a, neg) for a in e["args"]]
        return (" · " if (op == "and") != neg else " or ").join(parts)

    def terms(self, src):
        """Guard as alternatives of conjunct phrases: [[a, b], [c]] reads "a · b, or c"."""
        e = self.parse(src) if isinstance(src, str) else src

        def conj(x):
            return [self.phrase(a) for a in x["args"]] if x["op"] == "and" else [self.phrase(x)]
        return [conj(a) for a in e["args"]] if e["op"] == "or" else [conj(e)]

    def label(self, src):
        return plain(" or ".join(" · ".join(t) for t in self.terms(src)))

    # ------------------------------------------------------------------ derived data
    def job_time(self, job):
        return sum(self.T[k] for k in self.JOBS[job]["time"])


def _same(a, b):
    # JavaScript === semantics for the values of the model: numbers compare by value, other values
    # only to the same value of the same kind (a state id never equals a number)
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    return type(a) is type(b) and a == b


def plain(s):
    """Drop the diagram markup ({TAG}, [CP-n], *bold*)."""
    return re.sub(r"[{}\[\]*]", "", s)


def load(path=None):
    with open(path or DEFAULT_PATH, encoding="utf-8") as f:
        return Model(json.load(f))
