// =====================================================================
// kr-resume: 국문/영문 겸용 이력서 템플릿 (Typst)
//
// Compile: typst compile <file>.typ <file>.pdf
// Single column on purpose: ATS parsers read the text layer in order.
// Self-contained: the style block below travels with every generated CV,
// so cv/main_<company>_<role>.typ compiles on its own.
// =====================================================================

// ---------- settings ----------
#let doc-lang = "ko" // "ko" = 국문 이력서, "en" = English resume
#let candidate = "[YOUR_NAME]" // also used for the PDF title/author metadata
#let accent = rgb("#1F5F8B")
#let muted = luma(95)

#let labels = (
  ko: (
    doc: "이력서",
    summary: "소개",
    experience: "경력",
    projects: "프로젝트",
    skills: "기술 스택",
    education: "학력",
    activities: "경험 · 활동",
    certs: "자격증 · 어학",
    awards: "수상",
    military: "병역",
  ),
  en: (
    doc: "Resume",
    summary: "Summary",
    experience: "Experience",
    projects: "Projects",
    skills: "Skills",
    education: "Education",
    activities: "Activities",
    certs: "Certifications & Languages",
    awards: "Awards",
    military: "Military Service",
  ),
)
#let L = labels.at(doc-lang)

// ---------- page and type ----------
#set document(title: candidate + " " + L.doc, author: candidate)
#set page(
  paper: "a4",
  margin: (x: 1.7cm, top: 1.5cm, bottom: 1.6cm),
  footer: context align(right, text(size: 7.5pt, fill: luma(150), counter(page).display("1 / 1", both: true))),
)
// Same typeface under its macOS/Google Fonts name, its Debian (Docker) name, then the macOS system font.
#set text(font: ("Noto Sans KR", "Noto Sans CJK KR", "Apple SD Gothic Neo"), size: 9.5pt, lang: doc-lang, fill: luma(25))
#set par(leading: 0.6em, spacing: 0.8em, justify: false)
#set list(indent: 1pt, body-indent: 5pt, spacing: 0.5em, marker: text(fill: accent, size: 8pt, baseline: -0.5pt)[●])
#show link: set text(fill: accent)

#show heading.where(level: 1): it => block(above: 1.25em, below: 0.7em, sticky: true, {
  text(size: 11.5pt, weight: "bold", fill: accent, it.body)
  v(-0.45em)
  line(length: 100%, stroke: 0.6pt + accent)
})

// ---------- building blocks ----------
// Header line of an entry. sticky keeps it on the same page as its bullets.
#let entry-head(title, org, period, meta: none) = block(above: 0.95em, below: 0.45em, sticky: true, {
  grid(
    columns: (1fr, auto),
    column-gutter: 10pt,
    [#text(weight: "bold", size: 10.2pt, title)#if org != none [ #h(3pt) #text(fill: muted, org)]],
    align(right + bottom, text(size: 8.8pt, fill: muted, period)),
  )
  if meta != none {
    v(-0.35em)
    text(size: 8.8pt, fill: muted, meta)
  }
})

// Experience / education / activity entry.
#let entry(title, org, period, meta: none, body) = {
  entry-head(title, org, period, meta: meta)
  body
}

// 경력기술서-style project entry: name, period, org/role, stack, bullets.
#let project(name, period, org: none, role: none, stack: none, body) = {
  let meta-parts = (org, role).filter(x => x != none)
  entry-head(name, none, period, meta: if meta-parts.len() > 0 { meta-parts.join(" · ") } else { none })
  if stack != none {
    block(above: 0.3em, below: 0.5em, text(size: 8.6pt, fill: accent, stack))
  }
  body
}

// Skills: (("Language", "Java, Kotlin"), ...)
#let skill-table(rows) = grid(
  columns: (auto, 1fr),
  column-gutter: 12pt,
  row-gutter: 0.65em,
  ..rows.map(r => (text(weight: "bold", r.at(0)), r.at(1))).flatten(),
)

// One-line items (certs, awards): (("TOEIC 905", "2025.06"), ...)
#let line-items(rows) = grid(
  columns: (1fr, auto),
  column-gutter: 10pt,
  row-gutter: 0.6em,
  ..rows.map(r => (r.at(0), align(right, text(fill: muted, size: 8.8pt, r.at(1))))).flatten(),
)

// =====================================================================
// CONTENT
// =====================================================================

// ---------- header ----------
#block(below: 0.9em, {
  text(size: 21pt, weight: "bold", candidate)
  h(8pt)
  text(size: 11pt, fill: muted, "[YOUR_TARGET_TITLE]")
  v(0.1em)
  // Contact details as literal text: ATS cannot read icons or link targets.
  // Strings, not markup: an "@" in markup starts a Typst reference.
  text(size: 9pt, fill: muted, (
    "[YOUR_EMAIL]",
    "[YOUR_PHONE]",
    "[YOUR_CITY]",
    "[YOUR_GITHUB_URL]",
    "[YOUR_LINKEDIN_URL]",
  ).join("  ·  "))
})

// ---------- summary ----------
= #L.summary
[YOUR_PROFILE_STATEMENT]

// ---------- experience ----------
= #L.experience

#entry("[COMPANY]", "[TEAM] · [JOB_TITLE]", "[YYYY.MM] - [YYYY.MM]")[
  - [KEY_ACHIEVEMENT_WITH_NUMBER]
  - [KEY_RESPONSIBILITY_1]
  - [KEY_RESPONSIBILITY_2]
]

// ---------- projects (경력기술서) ----------
= #L.projects

#project(
  "[PROJECT_NAME]",
  "[YYYY.MM] - [YYYY.MM]",
  org: "[COMPANY]",
  role: "[YOUR_ROLE_ON_PROJECT]",
  stack: "[TECH_STACK]",
)[
  - [PROBLEM]
  - [ACTION]
  - [RESULT_WITH_NUMBER]
]

// ---------- skills ----------
= #L.skills
#skill-table((
  ("[SKILL_CATEGORY_1]", "[SKILLS_1]"),
  ("[SKILL_CATEGORY_2]", "[SKILLS_2]"),
))

// ---------- education ----------
= #L.education
#entry("[INSTITUTION]", "[DEGREE] · [FIELD]", "[YYYY.MM] - [YYYY.MM]")[]

// ---------- certifications & languages ----------
= #L.certs
#line-items((
  ("[CERTIFICATION_OR_TEST_SCORE]", "[YYYY.MM]"),
))

// ---------- awards ----------
= #L.awards
#line-items((
  ("[AWARD_NAME] · [EVENT]", "[YYYY.MM]"),
))

// ---------- military (optional; remove unless the user wants it) ----------
// = #L.military
// [MILITARY_SERVICE]
