"""
Volt Symbol Table

Tracks every declared name in the program: what it is, what type it has,
and where it was declared. Supports nested scopes (global → function → block).
"""

from __future__ import annotations
from dataclasses import dataclass, field
from ast_nodes import Region


@dataclass
class Symbol:
    """A named thing in the program."""
    name: str
    kind: str           # "pin", "sensor", "bus", "func", "task", "param",
                        # "var", "struct", "machine", "storage", "builtin"
    type_name: str      # "int", "float", "Output", "BME280", "func", etc.
    region: Region      # where declared (for error messages)
    mutable: bool = False
    params: list = field(default_factory=list)       # for functions: [(name, type)]
    return_type: str | None = None                   # for functions


class Scope:
    """A lexical scope containing symbol declarations."""

    def __init__(self, parent: Scope | None = None, name: str = "global"):
        self.parent = parent
        self.name = name
        self._symbols: dict[str, Symbol] = {}

    def declare(self, symbol: Symbol) -> Symbol | None:
        """Declare a symbol in this scope. Returns existing symbol if duplicate."""
        existing = self._symbols.get(symbol.name)
        if existing is not None:
            return existing  # caller decides how to report the error
        self._symbols[symbol.name] = symbol
        return None

    def lookup(self, name: str) -> Symbol | None:
        """Look up a name, walking up to parent scopes."""
        sym = self._symbols.get(name)
        if sym is not None:
            return sym
        if self.parent is not None:
            return self.parent.lookup(name)
        return None

    def lookup_local(self, name: str) -> Symbol | None:
        """Look up a name in THIS scope only, not parents."""
        return self._symbols.get(name)

    def all_names(self) -> list[str]:
        """All names visible from this scope (for 'did you mean?' suggestions)."""
        names = list(self._symbols.keys())
        if self.parent:
            names.extend(self.parent.all_names())
        return names

    def child(self, name: str) -> Scope:
        """Create a child scope."""
        return Scope(parent=self, name=name)
