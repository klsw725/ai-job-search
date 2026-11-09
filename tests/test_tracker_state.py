"""Tests for tools/tracker_state.py - the web UI's direct status transition.

The tool performs the mechanical part of /outcome without an agent, so these
pin it to /outcome's rules: canonical spellings, a comma-free dated note, the
submission date replacing the draft date, the header migration, archive copies
that never overwrite what was submitted, outcome.md in the documents/README.md
format, and a refused write when the row changed since the caller looked.
"""
import csv
import fcntl
import hashlib
import io
import json
import os
import runpy
import shutil
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "tracker_state.py"
TODAY = "2026-11-10"
HEADER = "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline"


class TrackerStateCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.tracker = self.root / "job_search_tracker.csv"

    def write_tracker(self, *rows, header=HEADER):
        self.tracker.write_text("\n".join([header, *rows]) + "\n", encoding="utf-8")

    def rows(self):
        return list(csv.DictReader(io.StringIO(self.tracker.read_text(encoding="utf-8"))))

    def run_tool(self, *, company, role, date, expect, status, note="", code=0):
        args = [sys.executable, str(TOOL), "transition", "--company", company, "--role", role, "--date", date,
                "--expect", expect, "--status", status, "--today", TODAY, "--root", str(self.root)]
        if note:
            args += ["--note", note]
        proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, code, proc.stdout + proc.stderr)
        return json.loads(proc.stdout)

    def make(self, rel, text="x"):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path


class Transitions(TrackerStateCase):
    def test_moving_off_drafted_sets_the_submission_date_and_keeps_every_other_cell(self):
        self.write_tracker(
            '2026-11-01,Acme,,"Engineer, Platform",,portal,drafted,,77,redrafted,cv/main_acme.typ,cover_letters/cover_acme.typ,https://x.io/1,2026-12-01',
            "2026-11-02,Beta,,ML Engineer,,portal,applied,,60,,,,https://x.io/2,",
        )
        out = self.run_tool(company="acme", role="engineer, platform", date="2026-11-01", expect="drafted", status="applied")
        self.assertTrue(out["changed"])
        self.assertIsNone(out["archive"])
        acme, beta = self.rows()
        self.assertEqual(acme["status"], "applied")
        self.assertEqual(acme["date"], TODAY)
        self.assertEqual(acme["role"], "Engineer, Platform")
        self.assertEqual(acme["notes"], f"redrafted; {TODAY} applied")
        self.assertEqual(acme["cv_file"], "cv/main_acme.typ")
        self.assertEqual(acme["deadline"], "2026-12-01")
        self.assertEqual(beta["date"], "2026-11-02")
        self.assertEqual(self.tracker.read_text(encoding="utf-8").splitlines()[0], HEADER)

    def test_a_stale_expected_status_is_refused_and_nothing_is_written(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,interview,,77,,,,,")
        before = self.tracker.read_text(encoding="utf-8")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected", code=3)
        self.assertEqual(out, {"ok": False, "error": "conflict", "current": "interview"})
        self.assertEqual(self.tracker.read_text(encoding="utf-8"), before)
        self.assertFalse((self.root / "documents").exists())

    def test_the_same_status_is_a_no_op(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        before = self.tracker.read_text(encoding="utf-8")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="applied")
        self.assertFalse(out["changed"])
        self.assertEqual(self.tracker.read_text(encoding="utf-8"), before)

    def test_legacy_space_spelling_matches_and_canonical_spelling_is_written(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,no response,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="no_response", status="offer declined")
        self.assertEqual(self.rows()[0]["status"], "offer_declined")

    def test_the_note_never_carries_commas_quotes_or_line_breaks(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="interview",
                      note='phone screen, "Friday"\nwith CTO')
        notes = self.rows()[0]["notes"]
        self.assertEqual(notes, f"{TODAY} interview - phone screen Friday with CTO")
        self.assertNotIn('"', self.tracker.read_text(encoding="utf-8").splitlines()[1])

    def test_a_header_without_deadline_gains_it(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,", header=HEADER.removesuffix(",deadline"))
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="interview")
        self.assertEqual(self.tracker.read_text(encoding="utf-8").splitlines()[0], HEADER)
        self.assertEqual(self.rows()[0]["deadline"], "")

    def test_unknown_and_ambiguous_rows_and_bad_statuses_fail(self):
        self.write_tracker(
            "2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,",
            "2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,",
        )
        self.assertIn("no tracker row", self.run_tool(company="Acme", role="Other", date="2026-11-01", expect="applied", status="rejected", code=1)["error"])
        self.assertIn("several", self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected", code=1)["error"])
        self.assertIn("unknown status", self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="ghosted", code=1)["error"])


class Archive(TrackerStateCase):
    def test_a_final_status_archives_the_submitted_files_and_writes_outcome(self):
        self.make("cv/main_acme.typ", "cv source")
        self.make("cover_letters/cover_acme.typ", "letter source")
        self.write_tracker("2026-11-01,Acme A/S,,ML Engineer,,portal,applied,,77,,cv/main_acme.typ,cover_letters/cover_acme.typ,,")
        out = self.run_tool(company="Acme A/S", role="ML Engineer", date="2026-11-01", expect="applied", status="rejected")
        folder = self.root / "documents" / "applications" / "acme_as_ml_engineer"
        self.assertEqual(out["archive"]["folder"], "documents/applications/acme_as_ml_engineer")
        self.assertEqual(sorted(out["archive"]["copied"]), ["cover_letter.tex", "cv_draft.tex"])
        self.assertEqual((folder / "cv_draft.tex").read_text(encoding="utf-8"), "cv source")
        self.assertTrue((self.root / "cv" / "main_acme.typ").exists(), "the source is copied, never moved")
        outcome = (folder / "outcome.md").read_text(encoding="utf-8")
        self.assertTrue(outcome.startswith("# Outcome: Acme A/S — ML Engineer\n"))
        self.assertIn("**Status:** rejected", outcome)
        self.assertIn(f"**Date resolved:** {TODAY}", outcome)
        self.assertIn("## Interview stages reached", outcome)
        self.assertIn(f"- {TODAY}: status → rejected", outcome)

    def test_an_existing_archive_is_found_by_its_outcome_title_and_never_overwritten(self):
        self.make("cv/main_acme.typ", "newer draft")
        folder = self.root / "documents" / "applications" / "acme_short"
        self.make("documents/applications/acme_short/cv_draft.tex", "what was submitted")
        self.make(
            "documents/applications/acme_short/outcome.md",
            "# Outcome: Acme — ML Engineer (Platform)\n\n**Status:** in_progress\n\n## Interview stages reached\n- [ ] Offer received\n\n## Notes\n- 2026-11-03: phone screen\n",
        )
        self.write_tracker('2026-11-01,Acme,,ML Engineer (Platform),,portal,interview,,77,,cv/main_acme.typ,,,')
        out = self.run_tool(company="Acme", role="ML Engineer (Platform)", date="2026-11-01", expect="interview", status="hired")
        self.assertEqual(out["archive"]["folder"], "documents/applications/acme_short")
        self.assertEqual((folder / "cv_draft.tex").read_text(encoding="utf-8"), "what was submitted")
        outcome = (folder / "outcome.md").read_text(encoding="utf-8")
        self.assertIn("**Status:** hired", outcome)
        self.assertIn(f"**Date resolved:** {TODAY}", outcome)
        self.assertIn("- 2026-11-03: phone screen", outcome)
        self.assertTrue(outcome.rstrip().endswith(f"- {TODAY}: status → hired (recorded in the web UI)"))
        self.assertFalse((self.root / "documents" / "applications" / "acme_ml_engineer_platform").exists())

    def test_a_resolved_outcome_keeps_its_status(self):
        self.make(
            "documents/applications/acme_engineer/outcome.md",
            "# Outcome: Acme — Engineer\n\n**Status:** rejected\n\n**Date resolved:** 2026-10-01\n\n## Notes\n",
        )
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="no_response")
        outcome = (self.root / "documents/applications/acme_engineer/outcome.md").read_text(encoding="utf-8")
        self.assertIn("**Status:** rejected", outcome)
        self.assertEqual(outcome.count("**Date resolved:**"), 1)

    def test_withdrawn_stays_in_progress_in_the_archive(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="withdrawn")
        outcome = (self.root / "documents/applications/acme_engineer/outcome.md").read_text(encoding="utf-8")
        self.assertIn("**Status:** in_progress", outcome)
        self.assertNotIn("**Date resolved:**", outcome)

    def test_an_offer_ticks_the_offer_stage(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,interview,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="interview", status="offer")
        outcome = (self.root / "documents/applications/acme_engineer/outcome.md").read_text(encoding="utf-8")
        self.assertIn(f"- [x] Offer received ({TODAY})", outcome)
        self.assertIn("**Status:** in_progress", outcome)

    def test_a_file_path_leaving_the_repo_is_not_copied(self):
        outside = self.root.parent / f"{self.root.name}-secret.txt"
        outside.write_text("secret", encoding="utf-8")
        self.addCleanup(outside.unlink)
        self.write_tracker(f"2026-11-01,Acme,,Engineer,,portal,applied,,77,,../{outside.name},,,")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected")
        self.assertEqual(out["archive"]["copied"], [])
        self.assertFalse((self.root / "documents/applications/acme_engineer/cv_draft.tex").exists())

    def test_a_draft_moved_to_applied_writes_no_archive(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="drafted", status="applied")
        self.assertFalse((self.root / "documents").exists())



class Confinement(TrackerStateCase):
    """Review findings B1/B2: the archive never leaves the repo, never copies a
    file that is not a generated CV or letter, runs inside the tracker lock,
    and a failed archive leaves the tracker as it was."""

    def test_a_symlinked_applications_folder_is_refused_and_the_tracker_is_unchanged(self):
        outside = Path(self._tmp.name + "-outside")
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside)
        self.make("cv/a.tex", "submitted")
        (self.root / "documents").mkdir()
        os.symlink(outside, self.root / "documents" / "applications")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,cv/a.tex,,,")
        before = self.tracker.read_text(encoding="utf-8")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected", code=1)
        self.assertIn("archive", out["error"])
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.tracker.read_text(encoding="utf-8"), before)

    def test_a_symlinked_outcome_file_is_not_written_through(self):
        target = Path(self._tmp.name + "-target.md")
        target.write_text("untouched", encoding="utf-8")
        self.addCleanup(target.unlink)
        folder = self.root / "documents" / "applications" / "acme_engineer"
        folder.mkdir(parents=True)
        os.symlink(target, folder / "outcome.md")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected", code=1)
        self.assertEqual(target.read_text(encoding="utf-8"), "untouched")

    def test_only_generated_cv_and_letter_sources_are_copied(self):
        self.make(".env", "API_KEY=secret")
        self.make("documents/profile/candidate.md", "private")
        self.make("cv/notes.txt", "not a source")
        outside = Path(self._tmp.name + "-cv.tex")
        outside.write_text("outside", encoding="utf-8")
        self.addCleanup(outside.unlink)
        (self.root / "cover_letters").mkdir()
        os.symlink(outside, self.root / "cover_letters" / "link.tex")
        for cv, cover in ((".env", "documents/profile/candidate.md"), ("cv/notes.txt", "cover_letters/link.tex")):
            with self.subTest(cv=cv, cover=cover):
                self.write_tracker(f"2026-11-01,Acme,,Engineer,,portal,applied,,77,,{cv},{cover},,")
                out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected")
                self.assertEqual(out["archive"]["copied"], [])
                folder = self.root / "documents/applications/acme_engineer"
                self.assertFalse((folder / "cv_draft.tex").exists())
                self.assertFalse((folder / "cover_letter.tex").exists())

    def test_a_symlinked_source_folder_is_not_read(self):
        outside = Path(self._tmp.name + "-cvdir")
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside)
        (outside / "a.tex").write_text("outside", encoding="utf-8")
        os.symlink(outside, self.root / "cv")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,cv/a.tex,,,")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected")
        self.assertEqual(out["archive"]["copied"], [])
        self.assertFalse((self.root / "documents/applications/acme_engineer/cv_draft.tex").exists())

    def test_a_source_is_read_through_the_handle_that_was_checked(self):
        mod = runpy.run_path(str(TOOL))
        self.make("cv/a.tex", "submitted")
        secret = Path(self._tmp.name + "-secret.txt")
        secret.write_text("secret", encoding="utf-8")
        self.addCleanup(secret.unlink)
        root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, root_fd)
        parts = mod["source_parts"]("cv/a.tex", drafts_only=True)
        self.assertEqual(mod["read_source"](root_fd, parts), b"submitted")
        (self.root / "cv" / "a.tex").unlink()
        os.symlink(secret, self.root / "cv" / "a.tex")
        self.assertIsNone(mod["read_source"](root_fd, parts))

    def test_a_korean_self_intro_is_archived_and_other_text_files_are_not(self):
        self.make("cv/main_acme.typ", "cv")
        self.make("documents/applications/acme_drafts/self_intro.txt", "1. 지원 동기")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,cv/main_acme.typ,documents/applications/acme_drafts/self_intro.txt,,")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected")
        self.assertEqual(sorted(out["archive"]["copied"]), ["cv_draft.tex", "self_intro.txt"])
        folder = self.root / "documents/applications/acme_engineer"
        self.assertEqual((folder / "self_intro.txt").read_text(encoding="utf-8"), "1. 지원 동기")
        self.assertFalse((folder / "cover_letter.tex").exists())

        self.make("cover_letters/notes.txt", "x")
        self.write_tracker("2026-11-02,Beta,,ML,,portal,applied,,77,,cv/self_intro.txt,cover_letters/notes.txt,,")
        self.make("cv/self_intro.txt", "not a CV")
        out = self.run_tool(company="Beta", role="ML", date="2026-11-02", expect="applied", status="rejected")
        self.assertEqual(out["archive"]["copied"], [])

    def test_the_archive_is_written_while_the_tracker_lock_is_held(self):
        mod = runpy.run_path(str(TOOL))
        lock_path = self.root / ".job_search_tracker.csv.lock"
        seen = []
        original = mod["update_outcome"]

        def probe(*args):
            with open(lock_path, "a", encoding="utf-8") as fh:
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    seen.append("free")
                    fcntl.flock(fh, fcntl.LOCK_UN)
                except BlockingIOError:
                    seen.append("held")
            return original(*args)

        mod["archive"].__globals__["update_outcome"] = probe
        args = mod["argparse"].Namespace(company="Acme", role="Engineer", date="2026-11-01", expect="interview", status="offer",
                                         note="", today=TODAY, root=str(self.root))
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,interview,,77,,,,,")
        mod["transition"](args)
        self.assertEqual(seen, ["held"])

    def test_a_failed_archive_keeps_the_tracker_and_a_retry_repairs_it(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        (self.root / "documents").write_text("in the way", encoding="utf-8")
        before = self.tracker.read_text(encoding="utf-8")
        self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="applied", status="rejected", code=1)
        self.assertEqual(self.tracker.read_text(encoding="utf-8"), before)

        (self.root / "documents").unlink()
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,rejected,,77,,,,,")
        out = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="rejected", status="rejected")
        self.assertFalse(out["changed"])
        self.assertEqual(out["archive"]["outcome"], "created")
        outcome = self.root / "documents/applications/acme_engineer/outcome.md"
        self.assertIn("**Status:** rejected", outcome.read_text(encoding="utf-8"))
        again = self.run_tool(company="Acme", role="Engineer", date="2026-11-01", expect="rejected", status="rejected")
        self.assertEqual(again["archive"]["outcome"], "unchanged")



class WriteSelfIntro(TrackerStateCase):
    """The web UI's 자기소개서 answers are saved by the tool, never by the agent."""

    def save(self, data="1. 지원 동기\n답변", owners=(), cover=False, company="Acme", role="Engineer", date="2026-11-01", code=0):
        args = [sys.executable, str(TOOL), "write-self-intro", "--company", company, "--role", role, "--date", date, "--root", str(self.root)]
        for o in owners:
            args += ["--owner", o]
        if cover:
            args.append("--record-cover")
        proc = subprocess.run(args, input=data.encode("utf-8"), capture_output=True)
        self.assertEqual(proc.returncode, code, proc.stdout.decode() + proc.stderr.decode())
        return json.loads(proc.stdout)

    def test_a_draft_gets_its_answers_and_an_empty_cover_letter_column_records_them(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,cv/a.typ,,,")
        out = self.save(cover=True)
        self.assertTrue(out["written"])
        self.assertTrue(out["cover_recorded"])
        path = self.root / "documents/applications/acme_engineer/self_intro.txt"
        self.assertEqual(path.read_text(encoding="utf-8"), "1. 지원 동기\n답변")
        self.assertEqual(self.rows()[0]["cover_letter_file"], "documents/applications/acme_engineer/self_intro.txt")

    def test_an_existing_cover_letter_is_kept(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,cv/a.typ,cover_letters/c.typ,,")
        self.assertFalse(self.save(cover=True)["cover_recorded"])
        self.assertEqual(self.rows()[0]["cover_letter_file"], "cover_letters/c.typ")

    def test_a_submitted_application_is_never_rewritten(self):
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,applied,,77,,,,,")
        out = self.save(code=3)
        self.assertEqual(out, {"ok": False, "error": "not_drafted", "current": "applied"})
        self.assertFalse((self.root / "documents").exists())

    def test_answers_another_application_wrote_are_kept_and_its_own_are_replaced(self):
        self.make("documents/applications/acme_engineer/self_intro.txt", "earlier submitted answers")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,,,,")
        out = self.save(data="new answers")
        self.assertFalse(out["written"])
        self.assertEqual(out["reason"], "owned_by_other")
        path = self.root / "documents/applications/acme_engineer/self_intro.txt"
        self.assertEqual(path.read_text(encoding="utf-8"), "earlier submitted answers")
        mine = hashlib.sha256(b"earlier submitted answers").hexdigest()
        self.assertTrue(self.save(data="new answers", owners=[mine])["written"])
        self.assertEqual(path.read_text(encoding="utf-8"), "new answers")

    def test_identical_answers_do_not_make_another_applications_file_this_ones(self):
        self.make("documents/applications/acme_engineer/self_intro.txt", "same answers")
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,,,,")
        self.assertEqual(self.save(data="same answers")["reason"], "owned_by_other")
        mine = hashlib.sha256(b"same answers").hexdigest()
        self.assertTrue(self.save(data="same answers", owners=[mine])["written"])

    def test_a_symlink_on_the_way_or_at_the_file_is_refused(self):
        outside = Path(self._tmp.name + "-intro-outside")
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside)
        self.write_tracker("2026-11-01,Acme,,Engineer,,portal,drafted,,77,,,,,")
        (self.root / "documents/applications").mkdir(parents=True)
        os.symlink(outside, self.root / "documents/applications/acme_engineer")
        self.assertIn("plain directory", self.save(code=1)["error"])
        self.assertEqual(list(outside.iterdir()), [])
        os.unlink(self.root / "documents/applications/acme_engineer")
        (self.root / "documents/applications/acme_engineer").mkdir()
        target = outside / "target.txt"
        target.write_text("untouched", encoding="utf-8")
        os.symlink(target, self.root / "documents/applications/acme_engineer/self_intro.txt")
        self.assertIn("not a plain text file", self.save(code=1)["error"])
        self.assertEqual(target.read_text(encoding="utf-8"), "untouched")


class SelfIntroCount(unittest.TestCase):
    """tools/self_intro_count.py counts as the 10-korea-market.md snippet does."""

    def count(self, texts):
        proc = subprocess.run([sys.executable, str(REPO / "tools" / "self_intro_count.py")], input=json.dumps(texts), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return json.loads(proc.stdout)

    def test_counts_match_the_documented_snippet(self):
        for text in ["  [소제목] 안녕 하세요\nAI 2  ", "힣", "é😀", "a\u0085b\u001cc", "\ufeff가"]:
            with self.subTest(text=repr(text)):
                t = text.strip()
                bad = "".join(sorted({c for c in t if not c.encode("euc-kr", "ignore")}))
                self.assertEqual(self.count([text])[0], {
                    "with_spaces": len(t),
                    "without_spaces": len("".join(t.split())),
                    "utf8_bytes": len(t.encode()),
                    "bytes": len(t.encode("euc-kr", "ignore")),
                    "unencodable": bad,
                })
        self.assertEqual(self.count(["é😀"])[0]["bytes"], 0)
        self.assertEqual(self.count(["é😀"])[0]["unencodable"], "é😀")


if __name__ == "__main__":
    unittest.main()
