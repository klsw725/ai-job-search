# /reset - Reset Candidate Profile Data

You are resetting parts of the job search framework back to a blank state so the user can start fresh with `/setup`.

**This command is destructive.** Nothing is deleted until the user explicitly confirms. Follow these steps exactly in order.

---

## Step 0: Parse Scope from Arguments

Check `$ARGUMENTS` for a scope keyword:

- `profile` — deletes the candidate profile in `documents/profile/` (and cleans legacy personal data out of tracked skill files, if any)
- `documents` — deletes user-provided files from the `documents/` folder only
- `all` — both of the above

If `$ARGUMENTS` is empty or does not contain a recognized scope keyword, ask:

> **What would you like to reset?**
>
> - **`profile`** — Deletes your profile in `documents/profile/` (profile, behavioral, STAR examples, profile statements, personalized evaluation criteria, search queries, master CV). The framework files are not changed. Use this to re-run `/setup` from scratch.
>
> - **`documents`** — Deletes all files you've placed in the `documents/` folder (CV PDFs, LinkedIn export, diplomas, references, project summaries, pasted job postings, past applications). The folder structure and `README.md` are preserved, and so is your profile in `documents/profile/`.
>
> - **`all`** — Both of the above.
>
> Reply with `profile`, `documents`, or `all`.

Wait for the user's response before continuing.

---

## Step 1: Show Exactly What Will Be Cleared

Before doing anything, show the user precisely what will be wiped.

### If scope includes `profile`:

The profile lives in `documents/profile/` (CLAUDE.md, "Personal Data Storage"). List every entry in that folder - `candidate.md`, the `0N-*.md` overlays, `search-queries.md`, `master-cv.*` and anything else there - and present:

```
## Profile reset will delete (documents/profile/):

- candidate.md
- 01-candidate-profile.md
- [every other entry, or "(empty - nothing to delete)"]

Tracked framework files are not changed.
```

Then check the tracked files for **legacy personal data**: data an older `/setup` wrote into them before profiles moved to `documents/profile/`. A missing sentinel placeholder is a reliable sign of legacy data; a present one is **not** proof the file is clean, because a partial edit can add a real name or job history and leave the sentinel in place:

| Tracked file | Sentinel that must be present |
|---|---|
| `CLAUDE.md` | `[YOUR_NAME]` |
| `01-candidate-profile.md` | `[YOUR_EMAIL]` |
| `02-behavioral-profile.md` | `[PROFILE_TYPE]` |
| `04-job-evaluation.md` | `[YOUR_PRIMARY_SKILLS]` |
| `05-cv-templates.md` | `[YOUR_PROFILE_STATEMENT_TEMPLATE_1]` and `[YOUR_EMAIL]` |
| `06-cover-letter-templates.md` | `[YOUR_EMAIL]` |
| `07-interview-prep.md` | `[PROJECT_NAME]` |
| `job-scraper/search-queries.md` | `[YOUR_CITY]` |
| `cv/main_example.tex` | `[your.email@example.com]` |

Flag a file when its sentinel is missing. Also run `git diff --stat HEAD -- <file>` (and, if the repo has an `upstream` remote, compare with it) for each file in the table, and read any file that differs from the shipped version for names, contact details, employers or other candidate facts; flag it if you find any. Name each flagged file and why, and apply the legacy cleanup to those files only. If nothing is flagged, say "No legacy personal data found in tracked files (checked sentinels and diffs)" rather than claiming the files are certainly clean, and skip everything under **Legacy tracked-file cleanup** in this step and in Step 3.

#### Legacy tracked-file cleanup (flagged files only)

Read the current state of these files and report whether each has content or is already empty:

- `.claude/skills/job-application-assistant/01-candidate-profile.md`
- `.claude/skills/job-application-assistant/02-behavioral-profile.md`
- `.claude/skills/job-application-assistant/04-job-evaluation.md` *(personalized match areas, career goals, and life-situation constraints only — the scoring framework is preserved)*
- `.claude/skills/job-application-assistant/05-cv-templates.md` *(profile statements section and the contact block inside the LaTeX template only — framework structure is preserved)*
- `.claude/skills/job-application-assistant/06-cover-letter-templates.md` *(contact line and signature inside the LaTeX template only — framework structure is preserved)*
- `.claude/skills/job-application-assistant/07-interview-prep.md` *(STAR examples and STAR candidates sections only — framework structure is preserved)*
- `.claude/skills/job-scraper/search-queries.md` *(role titles, domain keywords, and location terms only — query structure is preserved)*

This list must stay in step with what `/setup` Step 3 populates: every skill file it writes candidate data into is cleared here.

Present as:

```
## Profile reset will clear:

- 01-candidate-profile.md — [has content / already empty]
  Full file will be replaced with a blank template.

- 02-behavioral-profile.md — [has content / already empty]
  Full file will be replaced with a blank template.

- 04-job-evaluation.md — [has personalized criteria / already blank]
  Your match areas, career goals, energizing/draining tasks, and life-situation
  constraints will be restored to placeholders. The scoring framework (dimensions,
  score bands, weights, Language Gate, Company Research Checklist) is preserved.

- 05-cv-templates.md — [has profile statements or contact details / already blank]
  Profile statement templates will be cleared and the contact block in the LaTeX template restored to placeholders. LaTeX structure and tailoring guidelines are preserved.

- 06-cover-letter-templates.md — [has contact details / already blank]
  The contact line and signature in the LaTeX template will be restored to placeholders. Letter structure, opening patterns, and closing formulations are preserved.

- 07-interview-prep.md — [has STAR examples / already blank]
  STAR examples and any STAR candidate stubs will be cleared. Framework, tough questions, and roleplay guidelines are preserved.

- job-scraper/search-queries.md — [has personalized queries / already blank]
  Your job boards, role titles, domain keywords, city, and commute tiers will be
  restored to placeholders. The query structure and filter sections are preserved.

The following files are NOT touched (they contain framework rules, not candidate data):
  - 03-writing-style.md

Outside the profile scope, still holding your personal data: CLAUDE.md and
cv/main_example.tex. This scope covers skill files only.
```

### If scope includes `documents`:

Use Glob to list all files present in `documents/cv/`, `documents/linkedin/`, `documents/diplomas/`, `documents/references/`, `documents/projects/`, `documents/postings/`, and `documents/applications/`.

Include nested and hidden user entries in the inventory. Each subfolder's tracked `.gitkeep` is a scaffold placeholder: exclude it from the deletion list and from the empty/non-empty decision, and preserve it.

Present as:

```
## Documents reset will delete:

documents/cv/
  - [filename] or "(empty)"

documents/linkedin/
  - [filename] or "(empty)"

documents/diplomas/
  - [filename] or "(empty)"

documents/references/
  - [filename] or "(empty)"

documents/projects/
  - [filename] or "(empty)"

documents/postings/
  - [filename] or "(empty)"

documents/applications/
  - [subfolder/filename] or "(empty)"

documents/README.md — NOT deleted (instructions file)
```

If all document subfolders are already empty, state "All document subfolders are already empty — nothing to delete." and skip the confirmation step for this scope.

---

## Step 2: Require Explicit Confirmation

Present the confirmation prompt:

> **This cannot be undone.**
>
> Type **`RESET`** (all caps) to confirm, or anything else to cancel.

Wait for the user's response.

- If the user types exactly `RESET`: proceed to Step 3.
- If the user types anything else: abort and tell them "Reset cancelled. Nothing was changed."

---

## Step 3: Execute the Reset

### Profile reset

Delete every entry in `documents/profile/` and keep the folder itself. Run this only after the confirmation above. If `documents` or `documents/profile` is a symbolic link, stop and ask the user to replace it with a local folder, so nothing outside the repo is deleted:

```sh
if [ -L documents ] || [ -L documents/profile ]; then
  echo "documents or documents/profile is a symbolic link - not deleting anything" >&2
else
  [ -d documents/profile ] && find documents/profile -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
```

#### Legacy tracked-file cleanup (only files flagged in Step 1)

Every skill file under `.claude/skills/job-application-assistant/` opens with a `---` frontmatter block carrying its `framework_version` marker. That marker is framework data, not candidate data: `tools/check_framework_version.py` fails a file without it, and `tools/check_upstream_updates.py` cannot compare the file against upstream. Never remove or rewrite it - the two full-file replacements below keep it and replace only what follows.

**For `01-candidate-profile.md`**, keep the file's `---` frontmatter block exactly as it is and replace everything below it with:

```markdown
# Candidate Profile

<!-- Run /setup to populate this file -->

## Identity

### Languages

| Language | Level | Notes |
|----------|-------|-------|

## Education

## Professional Experience

## Independent Projects

## Technical Skills

## Publications

## Awards

## References
```

**For `02-behavioral-profile.md`**, keep the file's `---` frontmatter block exactly as it is and replace everything below it with:

```markdown
# Behavioral Profile

<!-- Run /setup to populate this file -->

## Overview

## Core Behavioral Drives

## Strongest Behaviors

## How You Work Best

## Growth Areas (frame positively in applications)

## Mapping to Job Posting Language

## Management Style Preferences

## Using This in Applications
```

**For `04-job-evaluation.md`**, restore the values `/setup` Step 3.4 personalized back to their placeholder tokens, leaving every surrounding line untouched:

| Line to restore | Token |
|---|---|
| `**Strong match areas:**` | `[YOUR_PRIMARY_SKILLS]` |
| `**Moderate match areas:**` | `[YOUR_SECONDARY_SKILLS]` |
| `**Weak match areas:**` | `[SKILLS_YOU_LACK]` |
| `**Strong:**` (Experience Match) | `[YOUR_DIRECT_EXPERIENCE_DOMAINS]` |
| `**Moderate:**` (Experience Match) | `[YOUR_ADJACENT_EXPERIENCE]` |
| `**Entry-level:**` (Experience Match) | `[ROLES_WITH_LIMITED_EXPERIENCE]` |
| the three `**Career goals:**` bullets | `[YOUR_CAREER_GOAL_1]`, `[YOUR_CAREER_GOAL_2]`, `[YOUR_CAREER_GOAL_3]` |
| `- Tasks that energize:` | `[YOUR_ENERGIZING_TASKS]` |
| `- Tasks that drain:` | `[YOUR_DRAINING_TASKS]` |
| `- **Security**:` | `[YOUR_FINANCIAL_SITUATION_CONTEXT]` |
| `- **Flexibility**:` | `[YOUR_SCHEDULE_CONSTRAINTS]` |
| `- **Professional development**:` | `[YOUR_GROWTH_PRIORITIES]` |

Also remove any `## Calibration from Past Applications` section, which `/setup` Path A writes from the user's own application outcomes.

Leave the rest of `04-job-evaluation.md` intact: the five scoring dimensions and their score bands, the weighting, the Language Gate, the red-flag guidance, the Company Research Checklist and cache schema, and the salary benchmark section. If `/setup` Step 3.4 ever personalizes a value not in the table above, add it here too.

**For `05-cv-templates.md`**, locate the section that begins with the line `**Create 2-3 profile statement templates for your main role types:**` and extends through the role-specific template blocks, including any statements labeled *[Used for: <company>_<role>]* that `/setup` Path A extracted from archived applications. Stop before the paragraph that begins "Statements labeled" - that is framework guidance, not candidate data. Replace only that section with:

```markdown
**Create 2-3 profile statement templates for your main role types:**

<!-- SETUP: These are populated based on your background -->
```

Then restore the contact block inside the file's LaTeX template to its placeholder tokens: `\name{[FIRST_NAME]}{[LAST_NAME]}`, `\address{[YOUR_ADDRESS]}{}{}`, `\phone[mobile]{[YOUR_PHONE]}`, `\email{[YOUR_EMAIL]}`, the `\extrainfo{...}` line's `[YOUR_LINKEDIN_URL]` and `[YOUR_GITHUB_URL]`, and `[YOUR_NAME]` in the `pdftitle`. Leave all other content in `05-cv-templates.md` intact.

**For `06-cover-letter-templates.md`**, restore the contact line and the signature inside the file's LaTeX template to their placeholder tokens: the `\namesection{}` line becomes `\namesection{}{\Huge{[YOUR_NAME]}}{  \href{mailto:[YOUR_EMAIL]}{[YOUR_EMAIL]} | [YOUR_PHONE] |  \urlstyle{same}\href{[YOUR_LINKEDIN_URL]}{LinkedIn}` and `\signature{...}` becomes `\signature{[YOUR_NAME]}`. Leave all other content in `06-cover-letter-templates.md` intact - the letter structure, opening patterns, and closing formulations are framework, not candidate data. If `/setup` Step 3.6 ever personalizes anything beyond these two lines, add it here too.

**For `07-interview-prep.md`**, locate and remove:
- The entire `## Ready-Made STAR Examples` section and all numbered STAR examples under it
- Any `## STAR Candidates (Complete Manually)` section added by `/setup` Path A

Replace with:

```markdown
## Ready-Made STAR Examples

<!-- Run /setup to populate STAR examples from your actual experience -->
```

Leave all other content in `07-interview-prep.md` intact (STAR format explanation, tough questions, questions to ask interviewers, phone/video tips, follow-up etiquette, roleplay guidelines).

**For `.claude/skills/job-scraper/search-queries.md`**, restore the values `/setup` Step 3.9 personalized back to their placeholder tokens:

- **Search Sites**: the board names back to `[YOUR_JOB_BOARD]`, `[YOUR_INDUSTRY_JOB_BOARD]`, `[YOUR_ADDITIONAL_JOB_BOARD]`, and the LinkedIn filter back to `[YOUR_COUNTRY]` / `[YOUR_CITY]`.
- **Query Categories**: the four priority headings back to `[YOUR_PRIMARY_ROLE_TYPE]`, `[YOUR_DOMAIN_EXPERTISE]`, `[YOUR_ADJACENT_ROLE_TYPE]`, and `Broader Technical / Consulting`; inside the query blocks, the titles, skills, and domain terms back to `[YOUR_PRIMARY_JOB_TITLE_1]`, `[YOUR_PRIMARY_JOB_TITLE_2]`, `[YOUR_ADJACENT_TITLE_1]`, `[YOUR_ADJACENT_TITLE_2]`, `[YOUR_KEY_SKILL]`, `[YOUR_DOMAIN_KEYWORD_1]`, `[YOUR_DOMAIN_KEYWORD_2]`, `[YOUR_DOMAIN]`, and the location terms back to `[YOUR_CITY]`, `[YOUR_COUNTRY]`, `[YOUR_REGION]`.
- **Location Filter**: the commute tiers back to `[YOUR_CITY]`, `[ACCEPTABLE_AREA_1]`, `[ACCEPTABLE_AREA_2]`, `[BORDERLINE_AREA]`, `[TOO_FAR_AREA]`.
- Remove any extra priority categories or translated query duplicates `/setup` added beyond the four shipped tiers.

Leave the rest of the file intact: the portal-CLI and WebSearch-fallback explanation, the Language scope note, the "organize by function, not job title" guidance, and the Language, Date, and Adapting Queries sections.

### Documents reset

For each non-empty document subfolder, delete all user entries, including nested folders and hidden files. Preserve the seven top-level subfolders, their `.gitkeep` placeholders, and `documents/README.md`. Run the following block only after the confirmation above. It is POSIX shell on purpose: the Bash tool runs whatever shell the user has, which is zsh on macOS, and a bash-only builtin such as `shopt` fails there with `command not found` before anything is deleted. `find` lists hidden entries and nested folders without any glob setting. If `documents/` or any of its seven roots is a symbolic link, stop before deleting anything and ask the user to replace that linked root with a local document folder.

```bash
(
  set -e
  for directory in documents documents/cv documents/linkedin documents/diplomas documents/references documents/projects documents/postings documents/applications; do
    if [ -L "$directory" ]; then
      printf 'Reset stopped: %s is a symbolic link.\n' "$directory" >&2
      exit 1
    fi
  done
  for directory in documents/cv documents/linkedin documents/diplomas documents/references documents/projects documents/postings documents/applications; do
    [ -d "$directory" ] || continue
    find "$directory" -mindepth 1 -maxdepth 1 ! -name .gitkeep -exec rm -rf -- {} +
  done
)
```

---

## Step 4: Confirm What Was Done and Next Steps

After the reset is complete, report:

```
## Reset complete

### Cleared
[List each file/folder that was actually modified or cleared]

### Unchanged
[List anything that was already empty or was intentionally preserved]
```

Then tell the user what to do next based on what was reset:

**If profile was reset:**
> Your profile in `documents/profile/` is deleted. Run `/setup` to rebuild it. The command auto-detects any files in your `documents/` folder and offers to read from there; otherwise it walks you through a CV import or interactive interview. If you keep a private backup (`tools/private_data.sh`), the previous profile is still in that history.
>
> Only if Step 1 flagged legacy data in `CLAUDE.md` or `cv/main_example.tex`: those two are not restored automatically and still hold personal data. If you are handing this fork over or making it public, clear them by hand.

**If documents were reset:**
> Your user documents are now cleared. The folder structure, `.gitkeep` placeholders, and `documents/README.md` are preserved. Add your career documents and run `/setup` to populate your profile.

**If both were reset:**
> Your profile data and user documents are now cleared; the document folders, `.gitkeep` placeholders, and `documents/README.md` are preserved. Add documents to `documents/` (or skip and use the CV import / interview path), then run `/setup`.
