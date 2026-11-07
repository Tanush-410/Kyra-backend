"""Builds the undertone benchmark workbook from the CSV written by undertone_benchmark.py.

Raw measurements are values; everything derived (errors, correctness, accuracy, confusion matrix,
breakdowns) is an Excel formula over the Results sheet, so the workbook recalculates if rows change.

Usage: python3 scripts/benchmark_to_excel.py [reports/undertone-benchmark.csv] [reports/undertone-benchmark.xlsx]
Needs openpyxl.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "reports" / "undertone-benchmark.csv"
TARGET = Path(sys.argv[2]) if len(sys.argv) > 2 else SOURCE.with_suffix(".xlsx")

FONT = "Arial"
BASE = Font(name=FONT, size=10)
BOLD = Font(name=FONT, size=10, bold=True)
TITLE = Font(name=FONT, size=14, bold=True)
SUBTITLE = Font(name=FONT, size=11, bold=True)
NOTE = Font(name=FONT, size=9, italic=True, color="595959")
INPUT = Font(name=FONT, size=10, color="0000FF")
HEADER_FILL = PatternFill("solid", fgColor="1F3864")
HEADER_FONT = Font(name=FONT, size=10, bold=True, color="FFFFFF")
SECTION_FILL = PatternFill("solid", fgColor="D9E1F2")
INPUT_FILL = PatternFill("solid", fgColor="FFFF00")
THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
PCT, NUM1, NUM2, NUM3, INT = "0.0%", "0.0", "0.00", "0.000", "#,##0"

BOOL = {"True": True, "False": False}
TEXT_COLUMNS = {"test_id", "person_id", "condition_id", "condition", "mode", "light", "wall", "distance", "true_depth",
                "true_undertone", "measured_depth", "measured_undertone", "measured_subtype", "confidence",
                "lighting_method", "light_detected", "quality_failures", "stable"}


def parse(name: str, value: str):
    if value in BOOL and name != "stable":
        return BOOL[value]
    if name == "stable":
        return BOOL.get(value, value)  # True / False / "unknown"
    if name in TEXT_COLUMNS:
        return value
    if value == "":
        return None
    try:
        number = float(value)
        return int(number) if number.is_integer() and name in {"frames_used", "frames_passed"} else number
    except ValueError:
        return value


rows = [{k: parse(k, v) for k, v in r.items()} for r in csv.DictReader(SOURCE.open())]
RAW = list(rows[0].keys())
N = len(rows)
LAST = N + 1  # last data row on Results

# Formula columns added after the raw ones: name -> (header note, formula template using {col_name} and {r})
DERIVED = {
    "hue_error": ("Measured minus true hue angle (degrees).", '=IF({measured_hue}{r}="","",{measured_hue}{r}-{true_hue}{r})'),
    "abs_hue_error": ("Size of the hue error (degrees).", '=IF({hue_error}{r}="","",ABS({hue_error}{r}))'),
    "L_error": ("Measured minus true lightness L*.", '=IF({measured_L}{r}="","",{measured_L}{r}-{true_L}{r})'),
    "abs_L_error": ("Size of the lightness error.", '=IF({L_error}{r}="","",ABS({L_error}{r}))'),
    "undertone_correct": ("1 when the reported undertone (cool/neutral/warm) matches the truth.", '=IF({measured_undertone}{r}={true_undertone}{r},1,0)'),
    "depth_correct": ("1 when the reported depth group matches the truth.", '=IF({measured_depth}{r}={true_depth}{r},1,0)'),
    "olive_correct": ("1 when the olive flag matches the truth.", '=IF({measured_olive}{r}={true_olive}{r},1,0)'),
    "opposite_error": ("1 when warm was reported as cool or the reverse (the worst kind of miss).",
                       '=IF(OR(AND({true_undertone}{r}="warm",{measured_undertone}{r}="cool"),AND({true_undertone}{r}="cool",{measured_undertone}{r}="warm")),1,0)'),
    "near_boundary": ("1 when the true warm/cool score is within the boundary margin of a label edge (Summary inputs): hard cases.",
                      "=IF(ABS(ABS({true_score}{r})-Summary!$C$6)<Summary!$C$7,1,0)"),
    "sure_but_wrong": ("1 when the mirror would not ask the visitor to confirm (confidence high) or called the label stable, yet it was wrong.",
                       '=IF(AND(OR({confidence}{r}="high",{stable}{r}=TRUE),{undertone_correct}{r}=0),1,0)'),
}
COLUMNS = RAW + list(DERIVED)
LETTER = {name: get_column_letter(i + 1) for i, name in enumerate(COLUMNS)}


def rng(name: str) -> str:
    return f"Results!${LETTER[name]}$2:${LETTER[name]}${LAST}"


def style_header(ws, row: int, first: int, last: int) -> None:
    for col in range(first, last + 1):
        cell = ws.cell(row=row, column=col)
        cell.font, cell.fill, cell.border = HEADER_FONT, HEADER_FILL, BOX
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def write_table(ws, top: int, left: int, headers: list[str], body: list[list], formats: list[str | None], widths=None) -> int:
    for j, header in enumerate(headers):
        ws.cell(row=top, column=left + j, value=header)
    style_header(ws, top, left, left + len(headers) - 1)
    for i, values in enumerate(body, start=1):
        for j, value in enumerate(values):
            cell = ws.cell(row=top + i, column=left + j, value=value)
            cell.font, cell.border = (BOLD if j == 0 else BASE), BOX
            if formats[j]:
                cell.number_format = formats[j]
    return top + len(body)


wb = Workbook()

# ---- Summary ------------------------------------------------------------------------------------------
summary = wb.active
summary.title = "Summary"
summary["A1"], summary["A1"].font = "Undertone detection: confidence benchmark", TITLE
summary["A2"] = ("Synthetic people with known skin colour, measured through the real KYRA sidecar pipeline "
                 "(lighting compensation + undertone detector + visit aggregation). One test = one visit.")
summary["A2"].font = NOTE
summary["A4"], summary["A4"].font = "Inputs (edit the yellow cells)", SUBTITLE
inputs = [
    ("Neutral band", 0.25, "Detector default: |score| <= 0.25 is neutral (vendored detector AnalysisConfig.neutral_band)."),
    ("Boundary margin", 0.10, "A person counts as 'near a label edge' when |true score| is within this of the neutral band. Chosen for this report."),
]
for i, (label, value, note) in enumerate(inputs):
    r = 6 + i
    summary.cell(row=r, column=2, value=label).font = BOLD
    cell = summary.cell(row=r, column=3, value=value)
    cell.font, cell.fill, cell.number_format = INPUT, INPUT_FILL, NUM2
    cell.comment = Comment(note, "benchmark")
    summary.cell(row=r, column=4, value=note).font = NOTE

summary["A9"], summary["A9"].font = "Headline results", SUBTITLE
headline = [
    ("Tests (visits)", f"=COUNTA({rng('test_id')})", INT),
    ("Synthetic people", "=COUNTA(People!$A$4:$A$1000)", INT),
    ("Conditions", "=COUNTA(Conditions!$A$4:$A$100)", INT),
    ("Camera frames measured", f"=SUM({rng('frames_used')})", INT),
    ("Undertone correct", f"=AVERAGE({rng('undertone_correct')})", PCT),
    ("Warm reported as cool, or cool as warm", f"=AVERAGE({rng('opposite_error')})", PCT),
    ("Depth group correct", f"=AVERAGE({rng('depth_correct')})", PCT),
    ("Olive flag correct", f"=AVERAGE({rng('olive_correct')})", PCT),
    ("Mean hue error (degrees)", f"=AVERAGE({rng('abs_hue_error')})", NUM2),
    ("Median hue error (degrees)", f"=MEDIAN({rng('abs_hue_error')})", NUM2),
    ("Mean lightness error (L*)", f"=AVERAGE({rng('abs_L_error')})", NUM2),
    ("Sure but wrong (no confirmation asked, or 'stable', yet wrong)", f"=SUM({rng('sure_but_wrong')})", INT),
    ("Undertone correct, away from label edges", f'=IFERROR(AVERAGEIFS({rng("undertone_correct")},{rng("near_boundary")},0),"-")', PCT),
    ("Undertone correct, near a label edge", f'=IFERROR(AVERAGEIFS({rng("undertone_correct")},{rng("near_boundary")},1),"-")', PCT),
]
end = write_table(summary, 10, 2, ["Measure", "Value"], [[m, f] for m, f, _ in headline], [None, None])
for i, (_, _, fmt) in enumerate(headline, start=1):
    summary.cell(row=10 + i, column=3).number_format = fmt

top = end + 2
summary.cell(row=top, column=1, value="Does the confidence mean something?").font = SUBTITLE
summary.cell(row=top + 1, column=2, value="Confidence is what the mirror reports: high = no confirmation needed (grey card, 5+ clean frames, label stable); "
             "medium = shown but the visitor is asked 'looks right?'; low = falls back to the neutral palette.").font = NOTE


def confidence_rows(column: str, values: list) -> list[list]:
    out = []
    for value in values:
        crit = f'"{value}"' if isinstance(value, str) else ("TRUE" if value else "FALSE")
        label = value if isinstance(value, str) else ("stable" if value else "not stable")
        out.append([
            label,
            f"=COUNTIF({rng(column)},{crit})",
            f"=IFERROR(COUNTIF({rng(column)},{crit})/COUNTA({rng('test_id')}),0)",
            f'=IFERROR(AVERAGEIFS({rng("undertone_correct")},{rng(column)},{crit}),"-")',
            f'=IFERROR(AVERAGEIFS({rng("opposite_error")},{rng(column)},{crit}),"-")',
            f'=IFERROR(AVERAGEIFS({rng("abs_hue_error")},{rng(column)},{crit}),"-")',
        ])
    return out


headers = ["Group", "Tests", "Share", "Undertone correct", "Opposite errors", "Mean hue error (°)"]
fmts = [None, INT, PCT, PCT, PCT, NUM2]
end = write_table(summary, top + 3, 2, ["Confidence"] + headers[1:], confidence_rows("confidence", ["high", "medium", "low"]), fmts)
end = write_table(summary, end + 2, 2, ["Label stability"] + headers[1:], confidence_rows("stable", [True, False, "unknown"]), fmts)
end = write_table(summary, end + 2, 2, ["Lighting measured"] + headers[1:], [
    ["light measured well", *confidence_rows("lighting_uncertain", [False])[0][1:]],
    ["light was a guess", *confidence_rows("lighting_uncertain", [True])[0][1:]],
], fmts)
end = write_table(summary, end + 2, 2, ["Grey card"] + headers[1:], [
    ["with grey card", *confidence_rows("grey_card", [True])[0][1:]],
    ["without", *confidence_rows("grey_card", [False])[0][1:]],
], fmts)
summary.column_dimensions["A"].width = 3
summary.column_dimensions["B"].width = 58
for col in "CDEFG":
    summary.column_dimensions[col].width = 18
summary.column_dimensions["D"].width = 20

# ---- By Condition -------------------------------------------------------------------------------------
by_condition = wb.create_sheet("By Condition")
by_condition["A1"], by_condition["A1"].font = "Results by lighting and camera condition", TITLE
conditions = []
for row in rows:
    if row["condition_id"] not in [c["condition_id"] for c in conditions]:
        conditions.append(row)
headers = ["Condition", "Description", "Tests", "Undertone correct", "Opposite errors", "Mean hue error (°)", "Mean L* error",
           "Confidence high", "Confidence medium", "Confidence low", "Label stable", "Correct when stable", "Light was a guess",
           "Mean lighting confidence", "Mean detector score", "Sure but wrong"]
body = []
for c in conditions:
    cid = f'"{c["condition_id"]}"'
    cnt = f"COUNTIF({rng('condition_id')},{cid})"
    body.append([
        c["condition_id"], c["condition"], f"={cnt}",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('undertone_correct')})",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('opposite_error')})",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('abs_hue_error')})",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('abs_L_error')})",
        f'=COUNTIFS({rng("condition_id")},{cid},{rng("confidence")},"high")/{cnt}',
        f'=COUNTIFS({rng("condition_id")},{cid},{rng("confidence")},"medium")/{cnt}',
        f'=COUNTIFS({rng("condition_id")},{cid},{rng("confidence")},"low")/{cnt}',
        f"=COUNTIFS({rng('condition_id')},{cid},{rng('stable')},TRUE)/{cnt}",
        f'=IFERROR(AVERAGEIFS({rng("undertone_correct")},{rng("condition_id")},{cid},{rng("stable")},TRUE),"-")',
        f"=COUNTIFS({rng('condition_id')},{cid},{rng('lighting_uncertain')},TRUE)/{cnt}",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('lighting_confidence')})",
        f"=AVERAGEIF({rng('condition_id')},{cid},{rng('detector_score')})",
        f"=SUMIF({rng('condition_id')},{cid},{rng('sure_but_wrong')})",
    ])
last = write_table(by_condition, 3, 1, headers, body, [None, None, INT, PCT, PCT, NUM2, NUM2, PCT, PCT, PCT, PCT, PCT, PCT, NUM2, NUM2, INT])
total = last + 1
by_condition.cell(row=total, column=1, value="All").font = BOLD
by_condition.cell(row=total, column=2, value="All conditions").font = BOLD
for col, formula, fmt in [(3, f"=SUM(C4:C{last})", INT), (4, f"=AVERAGE({rng('undertone_correct')})", PCT),
                          (5, f"=AVERAGE({rng('opposite_error')})", PCT), (6, f"=AVERAGE({rng('abs_hue_error')})", NUM2),
                          (7, f"=AVERAGE({rng('abs_L_error')})", NUM2), (16, f"=SUM(P4:P{last})", INT)]:
    cell = by_condition.cell(row=total, column=col, value=formula)
    cell.font, cell.number_format, cell.border = BOLD, fmt, BOX
by_condition.column_dimensions["A"].width = 11
by_condition.column_dimensions["B"].width = 50
for col in range(3, len(headers) + 1):
    by_condition.column_dimensions[get_column_letter(col)].width = 13
by_condition.row_dimensions[3].height = 42
by_condition.freeze_panes = "C4"
green_red = ColorScaleRule(start_type="num", start_value=0.5, start_color="F8696B", mid_type="num", mid_value=0.8, mid_color="FFEB84", end_type="num", end_value=1, end_color="63BE7B")
by_condition.conditional_formatting.add(f"D4:D{last}", green_red)
by_condition.conditional_formatting.add(f"L4:L{last}", green_red)
by_condition.conditional_formatting.add(f"P4:P{last}", CellIsRule(operator="greaterThan", formula=["0"], fill=PatternFill("solid", fgColor="F8CBAD")))

# ---- By Skin Tone -------------------------------------------------------------------------------------
by_skin = wb.create_sheet("By Skin Tone")
by_skin["A1"], by_skin["A1"].font = "Results by the person's true skin", TITLE
headers = ["Group", "Tests", "Undertone correct", "Opposite errors", "Mean hue error (°)", "Mean L* error", "Depth correct",
           "Confidence high", "Sure but wrong"]
fmts = [None, INT, PCT, PCT, NUM2, NUM2, PCT, PCT, INT]


def group_row(label: str, column: str, value) -> list:
    crit = f'"{value}"' if isinstance(value, str) else ("TRUE" if value is True else "FALSE" if value is False else value)
    cnt = f"COUNTIF({rng(column)},{crit})"
    return [label, f"={cnt}",
            f'=IFERROR(AVERAGEIF({rng(column)},{crit},{rng("undertone_correct")}),"-")',
            f'=IFERROR(AVERAGEIF({rng(column)},{crit},{rng("opposite_error")}),"-")',
            f'=IFERROR(AVERAGEIF({rng(column)},{crit},{rng("abs_hue_error")}),"-")',
            f'=IFERROR(AVERAGEIF({rng(column)},{crit},{rng("abs_L_error")}),"-")',
            f'=IFERROR(AVERAGEIF({rng(column)},{crit},{rng("depth_correct")}),"-")',
            f'=IFERROR(COUNTIFS({rng(column)},{crit},{rng("confidence")},"high")/{cnt},"-")',
            f"=SUMIF({rng(column)},{crit},{rng('sure_but_wrong')})"]


row = 3
for title, column, values in [
    ("By true depth (ITA groups)", "true_depth", ["fair", "light", "medium", "tan", "deep"]),
    ("By true undertone", "true_undertone", ["cool", "neutral", "warm"]),
    ("Olive skin", "true_olive", [True, False]),
    ("Flushed cheeks", "flushed_cheeks", [True, False]),
    ("Near a label edge (Summary inputs)", "near_boundary", [1, 0]),
]:
    by_skin.cell(row=row, column=1, value=title).font = SUBTITLE
    labels = {True: "yes", False: "no", 1: "yes", 0: "no"}
    body = [group_row(labels.get(v, v) if not isinstance(v, str) else v, column, v) for v in values]
    row = write_table(by_skin, row + 1, 1, headers, body, fmts) + 2
by_skin.column_dimensions["A"].width = 34
for col in range(2, len(headers) + 1):
    by_skin.column_dimensions[get_column_letter(col)].width = 15

# ---- Confusion ----------------------------------------------------------------------------------------
confusion = wb.create_sheet("Confusion")
confusion["A1"], confusion["A1"].font = "Confusion matrix: true undertone (rows) vs reported (columns)", TITLE
labels = ["cool", "neutral", "warm"]
reported = labels + ["none"]


def matrix(top: int, title: str, extra: str = "") -> int:
    confusion.cell(row=top, column=1, value=title).font = SUBTITLE
    headers = ["True \\ Reported", *reported, "Total", "Recall (correct share)"]
    body = []
    for i, truth in enumerate(labels):
        r = top + 2 + i
        cells = [f'=COUNTIFS({rng("true_undertone")},"{truth}",{rng("measured_undertone")},"{rep}"{extra})' for rep in reported]
        body.append([truth, *cells, f"=SUM(B{r}:E{r})", f'=IFERROR({get_column_letter(2 + i)}{r}/F{r},"-")'])
    end = write_table(confusion, top + 1, 1, headers, body, [None, INT, INT, INT, INT, INT, PCT])
    precision_row = end + 1
    confusion.cell(row=precision_row, column=1, value="Precision (reported label right)").font = BOLD
    for j in range(3):
        col = get_column_letter(2 + j)
        cell = confusion.cell(row=precision_row, column=2 + j, value=f'=IFERROR({col}{top + 2 + j}/SUM({col}{top + 2}:{col}{top + 4}),"-")')
        cell.number_format, cell.font, cell.border = PCT, BASE, BOX
    return precision_row + 2


nxt = matrix(3, "All tests")
nxt = matrix(nxt, "Grey card in view", f',{rng("grey_card")},TRUE')
nxt = matrix(nxt, "Live mirror without a card", f',{rng("grey_card")},FALSE,{rng("mode")},"live"')
nxt = matrix(nxt, "Photo uploads", f',{rng("mode")},"photo"')
confusion.column_dimensions["A"].width = 32
for col in "BCDEFG":
    confusion.column_dimensions[col].width = 14
confusion.column_dimensions["G"].width = 22

# ---- Results ------------------------------------------------------------------------------------------
results = wb.create_sheet("Results")
for j, name in enumerate(COLUMNS, start=1):
    cell = results.cell(row=1, column=j, value=name)
    if name in DERIVED:
        cell.comment = Comment(DERIVED[name][0], "benchmark")
style_header(results, 1, 1, len(COLUMNS))
templates = {name: template for name, (_, template) in DERIVED.items()}
for i, row in enumerate(rows, start=2):
    for j, name in enumerate(RAW, start=1):
        results.cell(row=i, column=j, value=row[name]).font = BASE
    for name, template in templates.items():
        formula = template.format(r=i, **LETTER)
        results.cell(row=i, column=COLUMNS.index(name) + 1, value=formula).font = BASE
number_formats = {"true_score": NUM3, "score": NUM3, "ci95_low": NUM3, "ci95_high": NUM3, "detector_score": NUM3,
                  "lighting_confidence": NUM3, "hue_error": NUM2, "abs_hue_error": NUM2, "L_error": NUM2, "abs_L_error": NUM2}
for name, fmt in number_formats.items():
    col = LETTER[name]
    for i in range(2, LAST + 1):
        results[f"{col}{i}"].number_format = fmt
table = Table(displayName="Results", ref=f"A1:{get_column_letter(len(COLUMNS))}{LAST}")
table.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
results.add_table(table)
results.freeze_panes = "D2"
for j, name in enumerate(COLUMNS, start=1):
    results.column_dimensions[get_column_letter(j)].width = max(10, min(44, len(name) + 3))
results.column_dimensions[LETTER["condition"]].width = 46
correct = LETTER["undertone_correct"]
results.conditional_formatting.add(f"{correct}2:{correct}{LAST}", CellIsRule(operator="equal", formula=["0"], fill=PatternFill("solid", fgColor="F8CBAD")))
results.conditional_formatting.add(f"{correct}2:{correct}{LAST}", CellIsRule(operator="equal", formula=["1"], fill=PatternFill("solid", fgColor="C6EFCE")))

# ---- People -------------------------------------------------------------------------------------------
people = wb.create_sheet("People")
people["A1"], people["A1"].font = "The synthetic people (true skin colour) and how often each was read correctly", TITLE
seen, person_rows = set(), []
for row in rows:
    if row["person_id"] not in seen:
        seen.add(row["person_id"])
        person_rows.append(row)
person_rows.sort(key=lambda r: r["person_id"])
headers = ["Person", "True L*", "True a*", "True b*", "Hue (°)", "Chroma", "ITA (°)", "Depth", "Undertone", "Olive",
           "Flushed cheeks", "Tests", "Undertone correct", "Mean hue error (°)", "Sure but wrong"]
body = []
for p in person_rows:
    pid = f'"{p["person_id"]}"'
    body.append([p["person_id"], p["true_L"], p["true_a"], p["true_b"], p["true_hue"], p["true_chroma"], p["true_ita"],
                 p["true_depth"], p["true_undertone"], p["true_olive"], p["flushed_cheeks"],
                 f"=COUNTIF({rng('person_id')},{pid})",
                 f"=AVERAGEIF({rng('person_id')},{pid},{rng('undertone_correct')})",
                 f"=AVERAGEIF({rng('person_id')},{pid},{rng('abs_hue_error')})",
                 f"=SUMIF({rng('person_id')},{pid},{rng('sure_but_wrong')})"])
last = write_table(people, 3, 1, headers, body, [None, NUM1, NUM1, NUM1, NUM1, NUM1, NUM1, None, None, None, None, INT, PCT, NUM2, INT])
people.freeze_panes = "B4"
people.auto_filter.ref = f"A3:{get_column_letter(len(headers))}{last}"
for col in range(1, len(headers) + 1):
    people.column_dimensions[get_column_letter(col)].width = 13
people.conditional_formatting.add(f"M4:M{last}", green_red)
# Swatch: each person's true skin colour as a cell fill.
people.cell(row=3, column=len(headers) + 1, value="Skin swatch")
style_header(people, 3, len(headers) + 1, len(headers) + 1)


def lab_hex(L: float, a: float, b: float) -> str:
    fy = (L + 16) / 116
    f = lambda t: t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787  # noqa: E731
    X, Y, Z = 0.95047 * f(fy + a / 500), f(fy), 1.08883 * f(fy - b / 200)
    lin = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z]
    srgb = [min(1, max(0, 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055)) for c in lin]
    return "".join(f"{round(255 * c):02X}" for c in srgb)


for i, p in enumerate(person_rows, start=4):
    people.cell(row=i, column=len(headers) + 1).fill = PatternFill("solid", fgColor=lab_hex(p["true_L"], p["true_a"], p["true_b"]))

# ---- Conditions ---------------------------------------------------------------------------------------
cond_sheet = wb.create_sheet("Conditions")
cond_sheet["A1"], cond_sheet["A1"].font = "Test conditions", TITLE
headers = ["Condition", "Description", "Mode", "Light (R/G/B gains)", "Exposure", "Wall", "Grey card", "Eyes open", "Distance"]
body = [[c["condition_id"], c["condition"], c["mode"], c["light"], c["exposure"], c["wall"], c["grey_card"], c["eyes_open"], c["distance"]] for c in conditions]
write_table(cond_sheet, 3, 1, headers, body, [None, None, None, None, NUM2, None, None, None, None])
cond_sheet.column_dimensions["A"].width = 11
cond_sheet.column_dimensions["B"].width = 52
for col in "CDEFGHI":
    cond_sheet.column_dimensions[col].width = 16

# ---- Method -------------------------------------------------------------------------------------------
method = wb.create_sheet("Method")
method["A1"], method["A1"].font = "How the tests were run", TITLE
notes = [
    ("What one test is", "One visit: 8 camera frames of one person in one condition (1 frame for photo uploads), each measured by "
     "undertone_adapter.measure_frame (lighting compensation, then the vendored undertone detector on face-mesh regions) and "
     "combined by undertone_adapter.aggregate, exactly as the live mirror does."),
    ("The people", "Synthetic faces with a known skin colour, spread over L* 28-78 (deep to fair), hue 40-70 degrees and chroma "
     "13-30, with skin texture; about 1 in 5 have flushed cheeks, and eye whites vary from white to slightly yellow. "
     "Synthetic people are used because their true colour is known; real photos have no ground truth."),
    ("The truth", "The undertone the detector itself reports for the true skin colour under perfect light (its default anchors: "
     "neutral at 55 degrees hue, +/-12 degree span, neutral band 0.25). So this measures how well the pipeline recovers the "
     "skin colour through light, exposure, walls, distance and flushing. It does not test whether those anchors match human "
     "judgement of undertone; that needs real people and their confirmations (npm run tune-thresholds)."),
    ("The conditions", "See the Conditions sheet: neutral, warm, cool, green and magenta light, dim and bright exposure, coloured "
     "walls, distance, closed eyes, with and without a grey card, live mirror (room model learned from the empty room and "
     "from visitors' eyes, carried across the visitors of a condition) and single photo uploads."),
    ("Confidence", "high = grey card, 5+ clean frames and a label clear of the neutral band; medium = shown, but the visitor "
     "is asked 'looks right?'; low = failed checks on a boundary, so the neutral palette is used. Label stable = the 95% "
     "interval of the warm/cool score does not cross the neutral band."),
    ("Derived columns", "Everything after quality_failures on the Results sheet, and every figure on the other sheets, is an "
     "Excel formula over the raw results."),
    ("Reproduce", "cd sidecar && .venv/bin/python scripts/undertone_benchmark.py 150 && "
     "python3 scripts/benchmark_to_excel.py reports/undertone-benchmark.csv"),
    ("Limits", "Faces are flat-shaded renders with texture, not photographs: no 3D shading, hair, makeup, glasses or motion "
     "blur. Lights are uniform colour casts. Results show how the pipeline behaves, not field accuracy on real visitors."),
]
for i, (label, text) in enumerate(notes, start=3):
    method.cell(row=i, column=1, value=label).font = BOLD
    cell = method.cell(row=i, column=2, value=text)
    cell.font, cell.alignment = BASE, Alignment(wrap_text=True, vertical="top")
    method.cell(row=i, column=1).alignment = Alignment(vertical="top")
    method.row_dimensions[i].height = 15 * (1 + len(text) // 110)
method.column_dimensions["A"].width = 20
method.column_dimensions["B"].width = 120

# Fonts everywhere, then save. Excel recalculates every formula on open.
for ws in wb.worksheets:
    for line in ws.iter_rows():
        for cell in line:
            if cell.value is not None and cell.font.name != FONT:
                cell.font = Font(name=FONT, size=cell.font.size or 10, bold=cell.font.bold, italic=cell.font.italic, color=cell.font.color)
wb.calculation.fullCalcOnLoad = True
TARGET.parent.mkdir(parents=True, exist_ok=True)
wb.save(TARGET)
print(f"Wrote {TARGET} ({N} tests, {len(COLUMNS)} columns on Results)")
