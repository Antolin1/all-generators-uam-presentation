class OclError(Exception):
    """Base class for OCL-related errors."""


class OclParseError(OclError):
    def __init__(self, message: str, line: int | None = None, column: int | None = None):
        self.line = line
        self.column = column
        super().__init__(message)


class OclEvalError(OclError):
    pass
