// =====================================================================
// kr-letter: 국문/영문 겸용 1페이지 커버레터 · 자유양식 자기소개서 (Typst)
//
// Compile: typst compile <file>.typ <file>.pdf
// Self-contained: the style block travels with every generated letter.
// Numbered 자기소개서 questions are NOT this file: they go to a character-
// counted .txt per 10-korea-market.md section 4.
// =====================================================================

// ---------- settings ----------
#let doc-lang = "ko" // "ko" = 국문, "en" = English
#let candidate = "[YOUR_NAME]" // also used for the PDF metadata
#let company = "[COMPANY]"
#let accent = rgb("#1F5F8B")
#let muted = luma(95)

// ---------- page and type ----------
#set document(title: candidate + " - " + company, author: candidate)
#set page(paper: "a4", margin: (x: 2.2cm, top: 1.9cm, bottom: 1.9cm))
// Same typeface under its macOS/Google Fonts name, its Debian (Docker) name, then the macOS system font.
#set text(font: ("Noto Sans KR", "Noto Sans CJK KR", "Apple SD Gothic Neo"), size: 10pt, lang: doc-lang, fill: luma(25))
#set par(leading: 0.78em, spacing: 1.15em, justify: true)
#set list(indent: 2pt, body-indent: 6pt, spacing: 0.75em, marker: text(fill: accent, size: 8pt, baseline: -0.5pt)[●])
#show strong: set text(weight: "bold")

// =====================================================================
// CONTENT
// =====================================================================

// ---------- header ----------
#block(below: 0.4em, text(size: 19pt, weight: "bold", candidate))
// Strings, not markup: an "@" in markup starts a Typst reference.
#block(below: 0.8em, text(size: 9pt, fill: muted, (
  "[YOUR_EMAIL]",
  "[YOUR_PHONE]",
  "[YOUR_LINKEDIN_OR_GITHUB_URL]",
).join("  ·  ")))
#line(length: 100%, stroke: 0.6pt + accent)

// ---------- date and recipient ----------
#grid(
  columns: (1fr, auto),
  [*#company* \ #text(fill: muted, "[RECIPIENT_OR_TEAM]")],
  align(right + top, text(fill: muted, "[DATE]")), // ko: 2026년 11월 8일 · en: 8 November 2026
)

// ---------- headline (03-writing-style.md: specialty + posting keyword) ----------
#block(above: 1.2em, below: 1.1em, text(size: 12pt, weight: "bold", fill: accent, "[HEADLINE]"))

// ---------- body ----------
// ko: "[COMPANY] 채용 담당자님께," · en: "Dear [Hiring Manager / Team],"
[SALUTATION]

[OPENING_PARAGRAPH]

[MOTIVATION_PARAGRAPH]

[TASK_SOLVING_PARAGRAPH]

- *[ACHIEVEMENT_1]:* [EVIDENCE_1]
- *[ACHIEVEMENT_2]:* [EVIDENCE_2]
- *[ACHIEVEMENT_3]:* [EVIDENCE_3]

[WORKING_STYLE_PARAGRAPH]

[CLOSING_SENTENCE]

// ---------- signature ----------
// Markup, not a string: ko "[YOUR_NAME] 드림" · en "Kind regards, \ [YOUR_NAME]" (\ is a line break)
#block(above: 1.6em, width: 100%, align(right)[
  [SIGNATURE]
])
