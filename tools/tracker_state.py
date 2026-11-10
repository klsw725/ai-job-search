#!/usr/bin/env python3
"""State helper for job_search_tracker.csv: one validated status transition.

The web UI moves an application between pipeline columns without starting an
agent. A bare edit of the `status` cell would skip what /outcome does around
it, so `transition` performs the mechanical part of /outcome itself:

  - Step 4: write the canonical status spelling and append a dated note that
    contains no commas, double quotes or line breaks
  - Step 4: moving a row off `drafted` overwrites `date` with the submission
    date, because readers take `date` as "applied on"
  - Step 1.1: a header that does not end in `,deadline` gains it
  - Step 3, for final statuses and interview progress: copy (never move) the
    files named in `cv_file` / `cover_letter_file` into the archive as
    `cv_draft.tex` / `cover_letter.tex` unless already there, and write or
    update `outcome.md` in the documents/README.md format

What needs judgement stays with /outcome: fetching a missing posting,
interview stage details, feedback, follow-up drafts.

Concurrency: an advisory lock on a sibling lock file is held for the whole
transition, archive included, so two callers of this tool never interleave.
The archive is written first and the tracker last, both by atomic replace; a
failed archive leaves the tracker unchanged, and a retry with the new status
already in place repairs a missing archive instead of returning early.
`--expect` refuses a row whose status already differs when the file is read.
It cannot stop a writer that ignores the lock (an agent's plain text edit)
from changing the file between that read and the replace.

Paths: sources are .tex/.typ drafts under cv/ or cover_letters/, or a Korean
`self_intro.txt` (apply.md Step 5a) there or under documents/applications/.
Sources and the archive are both reached from the repo's directory handle one
component at a time with no symlink allowed at any step, and a source is read
through the same handle that was checked, so neither a planted link nor a
swap between check and read can pull in or write to anything outside.

`write-self-intro` saves the web UI's 문항형 자기소개서 answers (read from
stdin) as the archive's self_intro.txt, under the same lock and the same
no-symlink directory handling. It writes only while the row is `drafted`,
since a submitted application's archived answers are what the employer
received, and it never replaces a self_intro.txt this application did not
write (`--owner` names the hashes it did): a re-application to the same
company and role shares the folder with the earlier one. With
`--record-cover`, an empty `cover_letter_file` becomes the saved path
(apply.md Step 5a: the answers replace the cover letter).

`append-note` and `write-steps` keep the web UI's per-application memo
(notes.md, dated bullets) and steps such as a coding test (steps.json) in the
archive folder, under the same lock and no-symlink handling, at any status: a
memo about a submitted application is normal. Both need exactly one row for
the application. `write-steps` replaces the file only when it still has the
sha256 the caller read (`--expect-sha256 none` when it had none), so a
change made in between is refused with exit 3 instead of overwritten.

Usage:
  python3 tools/tracker_state.py transition --company C --role R --date YYYY-MM-DD
      --expect STATUS --status STATUS [--note TEXT] [--today YYYY-MM-DD]
  python3 tools/tracker_state.py write-self-intro --company C --role R --date YYYY-MM-DD
      [--owner SHA256 ...] [--record-cover] < answers.txt
  python3 tools/tracker_state.py append-note --company C --role R --date YYYY-MM-DD
      [--source web|ai] [--now "YYYY-MM-DD HH:MM"] < note.txt
  python3 tools/tracker_state.py write-steps --company C --role R --date YYYY-MM-DD
      --expect-sha256 SHA256|none < steps.json

Prints JSON on stdout. Exit 0 on success, 1 on a usage or state error, 3 when
the row's current status is not the expected one, or steps.json changed.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: no advisory locks; --expect still refuses stale writes.
    fcntl = None

ROOT = Path(__file__).resolve().parent.parent
HEADER = [
    "date", "company", "sector", "role", "role_type", "channel", "status", "contact_person",
    "fit_rating", "notes", "cv_file", "cover_letter_file", "source", "deadline",
]

# outcome.md "Tracker status vocabulary". Legacy space spellings are read, never written.
STATUSES = ("drafted", "applied", "interview", "offer", "hired", "rejected", "no_response", "offer_declined", "withdrawn")
FINAL = {"hired", "rejected", "no_response", "offer_declined", "withdrawn"}
LEGACY = {"no response": "no_response", "offer declined": "offer_declined"}

# The archive `Status:` enum (documents/README.md) has no `withdrawn`; a
# withdrawn application stays `in_progress` there with a dated note.
ARCHIVE_STATUS = {"hired": "hired", "rejected": "rejected", "no_response": "no_response", "offer_declined": "offer_declined"}

STATUS_WORD = {
    "drafted": "drafted", "applied": "applied", "interview": "interview", "offer": "offer received",
    "hired": "hired", "rejected": "rejected", "no_response": "no response", "offer_declined": "offer declined",
    "withdrawn": "withdrawn",
}

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EXIT_CONFLICT = 3


class StateError(Exception):
    pass


def canonical(status: str) -> str:
    s = status.strip().lower()
    return LEGACY.get(s, s)


def safe_note(text: str) -> str:
    """outcome.md Step 4: a tracker note never carries a comma, quote or line break."""
    return re.sub(r"\s+", " ", re.sub(r'[,"\r\n]', " ", text)).strip()


def archive_name(company: str, role: str) -> str:
    """documents/README.md "Subfolder naming"."""
    raw = f"{company}_{role}".lower()
    raw = re.sub(r"\s+", "_", raw)
    raw = re.sub(r"[^\w]", "", raw)
    return re.sub(r"_+", "_", raw).strip("_")


@contextmanager
def locked(tracker: Path):
    lock_path = tracker.with_name(f".{tracker.name}.lock")
    with open(lock_path, "a", encoding="utf-8") as fh:
        if fcntl:
            fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl:
                fcntl.flock(fh, fcntl.LOCK_UN)


def read_rows(tracker: Path) -> tuple[list[str], list[list[str]]]:
    if not tracker.is_file():
        raise StateError(f"{tracker.name} not found")
    rows = list(csv.reader(io.StringIO(tracker.read_text(encoding="utf-8"), newline="")))
    if not rows:
        raise StateError(f"{tracker.name} is empty")
    header, body = rows[0], [r for r in rows[1:] if any(cell.strip() for cell in r)]
    if "status" not in header or "company" not in header or "role" not in header or "date" not in header:
        raise StateError(f"{tracker.name} header lacks date/company/role/status")
    return header, body


def write_rows(tracker: Path, header: list[str], body: list[list[str]]) -> None:
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(body)
    fd, tmp = tempfile.mkstemp(dir=str(tracker.parent), prefix=f".{tracker.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as fh:
            fh.write(buf.getvalue())
        os.replace(tmp, tracker)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


SOURCE_ROOTS = (("cv",), ("cover_letters",), ("documents", "applications"))
DRAFT_EXT = (".tex", ".typ")
SELF_INTRO = "self_intro.txt"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def source_parts(rel: str, drafts_only: bool) -> list[str] | None:
    """The path components of a document a tracker cell may name, or None."""
    parts = rel.strip().split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    name = parts[-1]
    is_draft = name.lower().endswith(DRAFT_EXT) and parts[0] in ("cv", "cover_letters")
    is_intro = not drafts_only and name == SELF_INTRO
    if not (is_draft or is_intro):
        return None
    if not any(tuple(parts[: len(r)]) == r and len(parts) > len(r) for r in SOURCE_ROOTS):
        return None
    return parts


def read_source(root_fd: int, parts: list[str]) -> bytes | None:
    """Reads a regular file under the repo handle; any symlink on the way, a
    missing step or a non-regular file reads as None."""
    opened: list[int] = []
    fd = root_fd
    try:
        for name in parts[:-1]:
            fd = os.open(name, DIR_FLAGS, dir_fd=fd)
            opened.append(fd)
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except OSError:
        return None
    finally:
        for d in reversed(opened):
            os.close(d)
    with os.fdopen(file_fd, "rb") as fh:
        if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
            return None
        return fh.read()


def open_dir(parent_fd: int, name: str, create: bool) -> int:
    if create:
        try:
            os.mkdir(name, 0o755, dir_fd=parent_fd)
        except FileExistsError:
            pass
    try:
        return os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    except OSError as exc:
        raise StateError(f"archive path {name!r} is not a plain directory ({exc.strerror})") from exc


def exists_at(dir_fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def read_at(dir_fd: int, name: str) -> str | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "r", encoding="utf-8") as fh:
        return fh.read()


def write_at(dir_fd: int, name: str, data: bytes) -> None:
    """Atomic replace inside an already opened directory."""
    tmp = f".{name}.{os.getpid()}.{os.urandom(4).hex()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.rename(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        raise


def first_line_at(dir_fd: int, child: str) -> str:
    try:
        fd = os.open(child, DIR_FLAGS, dir_fd=dir_fd)
    except OSError:
        return ""
    try:
        text = read_at(fd, "outcome.md")
    except OSError:
        return ""
    finally:
        os.close(fd)
    return (text or "").splitlines()[0].strip() if text else ""


def find_archive(apps_fd: int, company: str, role: str) -> str | None:
    """The folder /outcome derives, or an existing one whose outcome.md names
    this exact application (folders written before the naming rule settled)."""
    name = archive_name(company, role)
    if not name or exists_at(apps_fd, name):
        return name or None
    title = f"# Outcome: {company} — {role}".casefold()
    for child in sorted(os.listdir(apps_fd)):
        if first_line_at(apps_fd, child).casefold() == title:
            return child
    return name


def outcome_text(company: str, role: str, archive_status: str, today: str, note: str) -> str:
    resolved = "" if archive_status == "in_progress" else f"**Date resolved:** {today}\n\n"
    return (
        f"# Outcome: {company} — {role}\n\n"
        f"**Status:** {archive_status}\n\n"
        f"{resolved}"
        "## Interview stages reached\n"
        "- [ ] Phone screen\n"
        "- [ ] Technical interview\n"
        "- [ ] Case interview\n"
        "- [ ] Final round\n"
        "- [ ] Offer received\n\n"
        "## Notes\n"
        f"- {today}: {note}\n"
    )


def update_outcome(text: str, archive_status: str, today: str, note: str, tick_offer: bool) -> str:
    """Append-only update: Status moves only from in_progress to a final value."""
    status_line = re.search(r"^\*\*Status:\*\*\s*(\S+)", text, re.MULTILINE)
    current = status_line.group(1) if status_line else "in_progress"
    if archive_status != "in_progress" and current == "in_progress":
        if status_line:
            text = text[: status_line.start(1)] + archive_status + text[status_line.end(1):]
        if not re.search(r"^\*\*Date resolved:\*\*", text, re.MULTILINE):
            text = re.sub(r"^(\*\*Status:\*\*[^\n]*\n)", rf"\1\n**Date resolved:** {today}\n", text, count=1, flags=re.MULTILINE)
    if tick_offer:
        text = re.sub(r"^- \[ \] Offer received\s*$", f"- [x] Offer received ({today})", text, count=1, flags=re.MULTILINE)
    entry = f"- {today}: {note}"
    if entry in text:
        return text
    if re.search(r"^## Notes\s*$", text, re.MULTILINE):
        return text.rstrip("\n") + f"\n{entry}\n"
    return text.rstrip("\n") + f"\n\n## Notes\n{entry}\n"


def needs_archive(status: str) -> bool:
    return status in FINAL or status in ("interview", "offer")


def archive(root: Path, row: dict[str, str], status: str, today: str, repair: bool = False) -> dict[str, object]:
    """Step 3 for one transition. With repair, an existing outcome.md is left
    alone and only what is missing is written."""
    copied: list[str] = []
    skipped: list[str] = []
    name = archive_name(row["company"], row["role"])
    if not name:
        skipped.append("archive: company and role have no letters or digits")
        return {"folder": None, "copied": copied, "skipped": skipped, "outcome": "unchanged"}

    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    opened = [root_fd]
    try:
        docs_fd = open_dir(root_fd, "documents", True)
        opened.append(docs_fd)
        apps_fd = open_dir(docs_fd, "applications", True)
        opened.append(apps_fd)
        folder = find_archive(apps_fd, row["company"], row["role"]) or name
        dir_fd = open_dir(apps_fd, folder, True)
        opened.append(dir_fd)

        for column, default in (("cv_file", "cv_draft.tex"), ("cover_letter_file", "cover_letter.tex")):
            parts = source_parts(row.get(column, ""), drafts_only=column == "cv_file")
            target = SELF_INTRO if parts and parts[-1] == SELF_INTRO else default
            if exists_at(dir_fd, target):
                skipped.append(f"{target}: already archived")
                continue
            data = read_source(root_fd, parts) if parts else None
            if data is None:
                skipped.append(f"{target}: no generated {column} on the row")
                continue
            write_at(dir_fd, target, data)
            copied.append(target)

        archive_status = ARCHIVE_STATUS.get(status, "in_progress")
        note = f"status → {STATUS_WORD[status]} (recorded in the web UI)"
        before = read_at(dir_fd, "outcome.md")
        result = "unchanged"
        if before is None:
            text = outcome_text(row["company"], row["role"], archive_status, today, note)
            if status == "offer":
                text = update_outcome(text, archive_status, today, note, True)
            write_at(dir_fd, "outcome.md", text.encode("utf-8"))
            result = "created"
        elif not repair:
            after = update_outcome(before, archive_status, today, note, status == "offer")
            if after != before:
                write_at(dir_fd, "outcome.md", after.encode("utf-8"))
                result = "updated"
    finally:
        for fd in reversed(opened):
            os.close(fd)
    return {"folder": f"documents/applications/{folder}", "copied": copied, "skipped": skipped, "outcome": result}


def archive_or_fail(root: Path, row: dict[str, str], status: str, today: str, repair: bool = False) -> dict[str, object]:
    try:
        return archive(root, row, status, today, repair)
    except OSError as exc:
        raise StateError(f"archive failed, tracker left unchanged: {exc}") from exc


def transition(args: argparse.Namespace) -> dict[str, object]:
    status = canonical(args.status)
    expect = canonical(args.expect)
    if status not in STATUSES:
        raise StateError(f"unknown status {args.status!r}; use one of {', '.join(STATUSES)}")
    if not ISO.match(args.today):
        raise StateError("--today must be YYYY-MM-DD")
    root = Path(args.root).resolve()
    tracker = root / "job_search_tracker.csv"

    with locked(tracker):
        header, body = read_rows(tracker)
        if header[-1] != "deadline" and "deadline" not in header:
            header.append("deadline")
        col = {name: i for i, name in enumerate(header)}

        def cell(r: list[str], name: str) -> str:
            i = col.get(name)
            return r[i] if i is not None and i < len(r) else ""

        matches = [
            r for r in body
            if cell(r, "company").strip().casefold() == args.company.strip().casefold()
            and cell(r, "role").strip().casefold() == args.role.strip().casefold()
            and cell(r, "date").strip() == args.date.strip()
        ]
        if not matches:
            raise StateError("no tracker row matches that company, role and date")
        if len(matches) > 1:
            raise StateError("several tracker rows match that company, role and date")
        r = matches[0]
        r.extend([""] * (len(header) - len(r)))

        current = canonical(cell(r, "status"))
        if current != expect:
            return {"ok": False, "error": "conflict", "current": current}

        row = {name: cell(r, name) for name in header}
        if current == status:
            report = archive_or_fail(root, row, status, args.today, repair=True) if needs_archive(status) else None
            return {"ok": True, "changed": False, "row": row, "archive": report}

        report = archive_or_fail(root, row, status, args.today) if needs_archive(status) else None
        if current == "drafted":
            r[col["date"]] = args.today
        r[col["status"]] = status
        note = safe_note(f"{args.today} {STATUS_WORD[status]}" + (f" - {args.note}" if args.note else ""))
        existing = cell(r, "notes").strip()
        r[col["notes"]] = f"{existing}; {note}" if existing else note
        write_rows(tracker, header, body)
        row = {name: cell(r, name) for name in header}

    return {"ok": True, "changed": True, "row": row, "archive": report}


def write_self_intro(args: argparse.Namespace, data: bytes) -> dict[str, object]:
    root = Path(args.root).resolve()
    tracker = root / "job_search_tracker.csv"
    digest = hashlib.sha256(data).hexdigest()
    with locked(tracker):
        header, body = read_rows(tracker)
        col = {name: i for i, name in enumerate(header)}

        def cell(r: list[str], name: str) -> str:
            i = col.get(name)
            return r[i] if i is not None and i < len(r) else ""

        matches = [
            r for r in body
            if cell(r, "company").strip().casefold() == args.company.strip().casefold()
            and cell(r, "role").strip().casefold() == args.role.strip().casefold()
            and cell(r, "date").strip() == args.date.strip()
        ]
        if len(matches) != 1:
            raise StateError("no single tracker row matches that company, role and date")
        r = matches[0]
        current = canonical(cell(r, "status"))
        if current != "drafted":
            return {"ok": False, "error": "not_drafted", "current": current}
        name = archive_name(cell(r, "company"), cell(r, "role"))
        if not name:
            raise StateError("company and role have no letters or digits")

        root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        opened = [root_fd]
        try:
            docs_fd = open_dir(root_fd, "documents", True)
            opened.append(docs_fd)
            apps_fd = open_dir(docs_fd, "applications", True)
            opened.append(apps_fd)
            folder = find_archive(apps_fd, cell(r, "company"), cell(r, "role")) or name
            dir_fd = open_dir(apps_fd, folder, True)
            opened.append(dir_fd)
            try:
                existing = read_at(dir_fd, SELF_INTRO)
            except (OSError, UnicodeDecodeError) as exc:
                raise StateError(f"{SELF_INTRO} in the archive is not a plain text file") from exc
            path = f"documents/applications/{folder}/{SELF_INTRO}"
            # Even identical bytes need an owner: writing them would hand this
            # application the hash, and with it the right to replace the file later.
            if existing is not None and hashlib.sha256(existing.encode("utf-8")).hexdigest() not in set(args.owner or []):
                return {"ok": True, "written": False, "reason": "owned_by_other", "path": path, "sha256": digest}
            write_at(dir_fd, SELF_INTRO, data)
        except OSError as exc:
            raise StateError(f"could not save {SELF_INTRO}: {exc}") from exc
        finally:
            for fd in reversed(opened):
                os.close(fd)

        cover_recorded = False
        if args.record_cover and "cover_letter_file" in col and not cell(r, "cover_letter_file").strip():
            r.extend([""] * (len(header) - len(r)))
            r[col["cover_letter_file"]] = path
            write_rows(tracker, header, body)
            cover_recorded = True
    return {"ok": True, "written": True, "path": path, "sha256": digest, "cover_recorded": cover_recorded}


NOTES = "notes.md"
STEPS = "steps.json"
NOTE_SOURCES = {"web": "직접 입력", "ai": "AI 답변 저장"}
MAX_NOTE = 8000
STEP_KINDS = {"coding_test", "assignment", "interview", "document", "other"}
STEP_STATUSES = {"todo", "done", "skipped"}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def single_row(args: argparse.Namespace, header: list[str], body: list[list[str]]) -> dict[str, str]:
    col = {name: i for i, name in enumerate(header)}

    def cell(r: list[str], name: str) -> str:
        i = col.get(name)
        return r[i] if i is not None and i < len(r) else ""

    matches = [
        r for r in body
        if cell(r, "company").strip().casefold() == args.company.strip().casefold()
        and cell(r, "role").strip().casefold() == args.role.strip().casefold()
        and cell(r, "date").strip() == args.date.strip()
    ]
    if len(matches) != 1:
        raise StateError("no single tracker row matches that company, role and date")
    return {name: cell(matches[0], name) for name in col}


@contextmanager
def archive_dir(root: Path, company: str, role: str):
    """The application's archive folder, created if missing, reached one
    component at a time from the repo's handle with no symlink allowed."""
    if not archive_name(company, role):
        raise StateError("company and role have no letters or digits")
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    opened = [root_fd]
    try:
        docs_fd = open_dir(root_fd, "documents", True)
        opened.append(docs_fd)
        apps_fd = open_dir(docs_fd, "applications", True)
        opened.append(apps_fd)
        folder = find_archive(apps_fd, company, role) or archive_name(company, role)
        dir_fd = open_dir(apps_fd, folder, True)
        opened.append(dir_fd)
        yield dir_fd, folder
    finally:
        for fd in reversed(opened):
            os.close(fd)


def read_text_at(dir_fd: int, name: str) -> str | None:
    try:
        return read_at(dir_fd, name)
    except (OSError, UnicodeDecodeError) as exc:
        raise StateError(f"{name} in the archive is not a plain text file") from exc


def read_bytes_at(dir_fd: int, name: str) -> bytes | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise StateError(f"{name} in the archive is not a plain file") from exc
    with os.fdopen(fd, "rb") as fh:
        return fh.read()


def note_entry(text: str, stamp: str, app_date: str, source: str) -> str:
    """One dated bullet; later lines are indented so the bullet stays one item."""
    lines = [line.rstrip() for line in text.strip().replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    out = [f"- {stamp} (지원 {app_date}, {NOTE_SOURCES[source]}): {lines[0]}"]
    out += [f"  {line}" if line else "" for line in lines[1:]]
    return "\n".join(out) + "\n"


def append_note(args: argparse.Namespace, data: bytes) -> dict[str, object]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise StateError("the note is not UTF-8 text") from exc
    if not text.strip():
        raise StateError("the note is empty")
    if len(text) > MAX_NOTE:
        raise StateError(f"the note is longer than {MAX_NOTE} characters")
    stamp = args.now or datetime.now().strftime("%Y-%m-%d %H:%M")
    if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", stamp):
        raise StateError("--now must be YYYY-MM-DD HH:MM")
    root = Path(args.root).resolve()
    tracker = root / "job_search_tracker.csv"
    with locked(tracker):
        header, body = read_rows(tracker)
        row = single_row(args, header, body)
        try:
            with archive_dir(root, row["company"], row["role"]) as (dir_fd, folder):
                existing = read_text_at(dir_fd, NOTES)
                head = existing if existing is not None else f"# 메모 · {row['company']} / {row['role']}\n\n"
                if head and not head.endswith("\n"):
                    head += "\n"
                write_at(dir_fd, NOTES, (head + note_entry(text, stamp, row["date"].strip(), args.source)).encode("utf-8"))
        except OSError as exc:
            raise StateError(f"could not save {NOTES}: {exc}") from exc
    return {"ok": True, "path": f"documents/applications/{folder}/{NOTES}"}


def check_steps(doc: object) -> list[dict[str, object]]:
    if not isinstance(doc, dict) or not isinstance(doc.get("steps"), list):
        raise StateError('steps must be a JSON object {"steps": [...]}')
    out = []
    seen = set()
    for i, s in enumerate(doc["steps"]):
        where = f"step {i + 1}"
        if not isinstance(s, dict):
            raise StateError(f"{where} is not an object")
        sid, title = s.get("id"), s.get("title")
        if not isinstance(sid, str) or not re.match(r"^[\w-]{1,40}$", sid) or sid in seen:
            raise StateError(f"{where}: id must be a unique short identifier")
        seen.add(sid)
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise StateError(f"{where}: title is required (at most 200 characters)")
        if s.get("kind") not in STEP_KINDS or s.get("status") not in STEP_STATUSES:
            raise StateError(f"{where}: unknown kind or status")
        app = s.get("application")
        if not isinstance(app, str) or not ISO_DATE.match(app):
            raise StateError(f"{where}: application must be the tracker date")
        due, link, note = s.get("due"), s.get("link"), s.get("note")
        if due is not None and (not isinstance(due, str) or not ISO_DATE.match(due)):
            raise StateError(f"{where}: due must be YYYY-MM-DD")
        if link is not None and (not isinstance(link, str) or not re.match(r"^https?://\S+$", link) or len(link) > 2000):
            raise StateError(f"{where}: link must be an http(s) URL")
        if note is not None and (not isinstance(note, str) or len(note) > 1000):
            raise StateError(f"{where}: note is at most 1000 characters")
        keep = {"id": sid, "kind": s["kind"], "title": title.strip(), "status": s["status"], "application": app}
        for key in ("due", "link", "note"):
            if s.get(key):
                keep[key] = s[key]
        if isinstance(s.get("from"), dict):
            src = s["from"]
            keep["from"] = {k: v for k, v in src.items() if k in ("thread", "proposal") and isinstance(v, str) and len(v) <= 64}
            if isinstance(src.get("item"), int) and not isinstance(src.get("item"), bool) and 0 <= src["item"] < 100:
                keep["from"]["item"] = src["item"]
        out.append(keep)
    return out


def write_steps(args: argparse.Namespace, data: bytes) -> dict[str, object]:
    try:
        steps = check_steps(json.loads(data.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StateError(f"steps are not JSON: {exc}") from exc
    payload = (json.dumps({"version": 1, "steps": steps}, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    root = Path(args.root).resolve()
    tracker = root / "job_search_tracker.csv"
    with locked(tracker):
        header, body = read_rows(tracker)
        row = single_row(args, header, body)
        try:
            with archive_dir(root, row["company"], row["role"]) as (dir_fd, folder):
                existing = read_bytes_at(dir_fd, STEPS)
                # The bytes on disk, as the server hashed them: a text read would
                # turn CRLF into LF and never match.
                current = hashlib.sha256(existing).hexdigest() if existing is not None else "none"
                if current != args.expect_sha256:
                    return {"ok": False, "error": "changed", "current_sha256": current}
                write_at(dir_fd, STEPS, payload)
        except OSError as exc:
            raise StateError(f"could not save {STEPS}: {exc}") from exc
    return {"ok": True, "path": f"documents/applications/{folder}/{STEPS}", "sha256": hashlib.sha256(payload).hexdigest()}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    t = sub.add_parser("transition", help="move one application to another status")
    t.add_argument("--company", required=True)
    t.add_argument("--role", required=True)
    t.add_argument("--date", required=True, help="the row's current date column, part of its identity")
    t.add_argument("--expect", required=True, help="the status the caller saw; a different current status is refused")
    t.add_argument("--status", required=True)
    t.add_argument("--note", default="")
    t.add_argument("--today", default=date.today().isoformat())
    t.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    w = sub.add_parser("write-self-intro", help="save 자기소개서 answers from stdin as the archive's self_intro.txt")
    w.add_argument("--company", required=True)
    w.add_argument("--role", required=True)
    w.add_argument("--date", required=True)
    w.add_argument("--owner", action="append", help="sha256 of a self_intro.txt this application wrote earlier")
    w.add_argument("--record-cover", action="store_true")
    w.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    for name, helptext in (("append-note", "append a dated memo from stdin to the archive's notes.md"), ("write-steps", "replace the archive's steps.json from stdin")):
        n = sub.add_parser(name, help=helptext)
        n.add_argument("--company", required=True)
        n.add_argument("--role", required=True)
        n.add_argument("--date", required=True)
        n.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
        if name == "append-note":
            n.add_argument("--source", choices=sorted(NOTE_SOURCES), default="web")
            n.add_argument("--now", default="", help="timestamp to record, YYYY-MM-DD HH:MM (default: now)")
        else:
            n.add_argument("--expect-sha256", required=True, help="sha256 of the steps.json the caller read, or none")
    args = parser.parse_args(argv)

    commands = {
        "transition": lambda: transition(args),
        "write-self-intro": lambda: write_self_intro(args, sys.stdin.buffer.read()),
        "append-note": lambda: append_note(args, sys.stdin.buffer.read()),
        "write-steps": lambda: write_steps(args, sys.stdin.buffer.read()),
    }
    try:
        result = commands[args.command]()
    except StateError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else EXIT_CONFLICT


if __name__ == "__main__":
    sys.exit(main())
