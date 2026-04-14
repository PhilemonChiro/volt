"""
Volt Compiler Error Infrastructure

Structured errors with source context, colored output, and suggestions.
Errors are accumulated (not thrown) so the compiler can report multiple
problems in one run.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from .ast_nodes import Region


@dataclass
class CompilerError:
    """A single error or warning."""
    region: Region
    category: str       # "SYNTAX ERROR", "NAME ERROR", "TYPE MISMATCH", etc.
    message: str        # human-readable description
    hint: str | None = None
    severity: str = "error"  # "error" or "warning"


class CompilerErrors:
    """Accumulates errors across all compiler passes."""

    def __init__(self):
        self.errors: list[CompilerError] = []
        self._source_lines: list[str] = []

    def set_source(self, source: str):
        """Store source lines for error context display."""
        self._source_lines = source.splitlines()

    def error(self, region: Region, category: str, message: str, hint: str = None):
        """Add an error."""
        self.errors.append(CompilerError(region, category, message, hint, "error"))

    def warning(self, region: Region, category: str, message: str, hint: str = None):
        """Add a warning."""
        self.errors.append(CompilerError(region, category, message, hint, "warning"))

    @property
    def has_errors(self) -> bool:
        """True if any error (not just warnings) was reported."""
        return any(e.severity == "error" for e in self.errors)

    @property
    def count(self) -> int:
        return len(self.errors)

    def report(self, filename: str = "<stdin>") -> str:
        """Format all errors with source context, sorted by line."""
        parts = []
        for err in sorted(self.errors, key=lambda e: e.region.start_line if e.region else 0):
            parts.append(self._format_one(err, filename))
        return "\n".join(parts)

    def _format_one(self, err: CompilerError, filename: str) -> str:
        """Format a single error with source context and pointer.
        Uses Rich markup for colors — rendered by Rich console in CLI."""
        lines = []

        # Rich color tags
        if err.severity == "error":
            color_tag = "red"
        else:
            color_tag = "yellow"

        # Header
        line_ref = err.region.start_line if err.region else 0
        lines.append(f"\n[{color_tag} bold]-- {err.category} -- {filename}:{line_ref}[/{color_tag} bold]\n")

        # Message
        lines.append(f"{err.message}\n")

        # Source context (1 line before, error line, pointer)
        line_num = err.region.start_line if err.region else 0
        if line_num > 0 and line_num <= len(self._source_lines):
            gutter = len(str(line_num))

            # Line before (context)
            if line_num > 1:
                prev = self._source_lines[line_num - 2]
                lines.append(f" [dim]{line_num - 1:>{gutter}} |[/dim] {prev}")

            # Error line
            error_line = self._source_lines[line_num - 1]
            lines.append(f" [dim]{line_num:>{gutter}} |[/dim] {error_line}")

            # Pointer
            col_start = max(0, err.region.start_col - 1)
            col_end = err.region.end_col - 1 if err.region.end_col > 0 else col_start + 1
            pointer_len = max(1, col_end - col_start)
            pointer = " " * col_start + "^" * pointer_len
            lines.append(f" [dim]{' ' * gutter} |[/dim] [{color_tag}]{pointer}[/{color_tag}]")

        # Hint
        if err.hint:
            lines.append(f"\n[cyan]Hint: {err.hint}[/cyan]")

        lines.append("")
        return "\n".join(lines)


def levenshtein(s1: str, s2: str) -> int:
    """Edit distance between two strings (for 'did you mean?' suggestions)."""
    if len(s1) < len(s2):
        return levenshtein(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            cost = 0 if c1 == c2 else 1
            curr_row.append(min(
                curr_row[j] + 1,
                prev_row[j + 1] + 1,
                prev_row[j] + cost,
            ))
        prev_row = curr_row
    return prev_row[-1]


def suggest_similar(name: str, known_names: list[str], max_distance: int = 2) -> str | None:
    """Find the closest known name within max_distance edits."""
    best = None
    best_dist = max_distance + 1
    for candidate in known_names:
        if abs(len(candidate) - len(name)) > max_distance:
            continue
        dist = levenshtein(name, candidate)
        if dist < best_dist:
            best = candidate
            best_dist = dist
    return best if best_dist <= max_distance else None
