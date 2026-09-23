import keyword
import re

_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])(?<![0-9])")


def to_snake_case(name: str) -> str:
    """`outgoingTransitions` -> `outgoing_transitions`. Idempotent on already-snake names."""
    s = _CAMEL_BOUNDARY.sub("_", name)
    s = s.replace("-", "_").replace(" ", "_")
    s = s.lower()
    if keyword.iskeyword(s):
        s += "_"
    return s
