"""Single-session, in-memory application state.

This tool is meant to be run locally by one person at a time (upload a
metamodel, write some OCL, validate a few models) so a simple process-wide
singleton is enough - no need for real session/user management.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .ecore_service import Metamodel
from .ocl.parser import ParsedConstraint
from .xmi_service import LoadedModel


@dataclass
class AppState:
    metamodel: Metamodel | None = None
    metamodel_filename: str | None = None

    constraints_text: str = ""
    constraints: list[ParsedConstraint] = field(default_factory=list)
    constraints_error: str | None = None

    last_model: LoadedModel | None = None
    last_model_filename: str | None = None


state = AppState()
