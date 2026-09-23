from app.llm.analysis import analyze

CLASSES = ["A", "B"]


def categories(code):
    return [(i.category, i.line) for i in analyze(code, CLASSES)]


def test_valid_script_has_no_issues():
    assert analyze("from models import A\nimport random\nmodel = A()\n", CLASSES) == []


def test_syntax_error_has_line_and_source():
    [issue] = analyze("model = A(\n", CLASSES)
    assert issue.category == "syntax" and issue.line == 1 and "model" in issue.code


def test_disallowed_and_unknown_imports():
    result = categories("import os\nfrom models import Nope\nfrom . import x\nmodel = 1\n")
    assert result == [("import", 1), ("import", 2), ("import", 3)]


def test_forbidden_constructs():
    code = "model = eval('1')\nx = model.__class__\ny = getattr(model, '__dict__')\nopen('f')\n"
    assert [c for c, _ in categories(code)].count("forbidden") == 4


def test_model_must_be_assigned_at_module_level():
    assert ("contract", None) in categories("x = 1\n")
    assert analyze("if True:\n    model = 1\n", CLASSES) == []
    assert ("contract", None) in categories("def f():\n    model = 1\n")
