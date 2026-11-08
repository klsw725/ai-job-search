# Template: kr-resume

- **Type:** CV
- **Source extension:** .typ
- **Engine/toolchain:** typst
- **Page limit:** 2 page(s)
- **Fonts:** Noto Sans KR (system font - must be installed; `Noto Sans CJK KR` from Debian's fonts-noto-cjk in the Docker image; Apple SD Gothic Neo is the macOS fallback)
- **Class/packages:** standard (no imports; the style block is inline so each CV compiles on its own)

## Compile command

    cd cv && typst compile <file>.typ <file>.pdf

## Style rules

- Set `#let doc-lang` to `"ko"` for a 국문 이력서 or `"en"` for an English resume. Section headings come from the `labels` dictionary; never hardcode a heading in the other language.
- Above the `CONTENT` banner, set only `doc-lang` and `candidate` (the name, also written into the PDF title/author metadata); leave the rest unchanged. Generated CVs copy the whole file and replace the content section.
- Single column. Do not introduce side-by-side columns: ATS parsers read the text layer in order.
- Contact details stay as a list of **strings** joined with `"  ·  "`, written as literal text (email, phone, city, GitHub/LinkedIn as bare `github.com/...`). No icons.
- Experience: `#entry("회사", "팀 · 직급", "YYYY.MM - YYYY.MM")[ - bullets ]`. Current role ends with `재직 중` (ko) or `Present` (en).
- Projects (경력기술서): `#project("이름", "기간", org: ..., role: ..., stack: "A · B · C")[ - 문제 - 행동 - 결과 ]`.
- Skills: `#skill-table((("Category", "a, b, c"), ...))`. Certificates, test scores and awards: `#line-items(((label, "YYYY.MM"), ...))`.
- Korean bullets end in noun / 명사형 forms; English bullets start with a past-tense verb. Conventions in `10-korea-market.md` section 2.
- Section order for 경력직: 소개, 경력, 프로젝트, 기술 스택, 학력, 자격증 · 어학, 수상. For 신입: 소개, 기술 스택, 프로젝트, 학력, 경험 · 활동, 자격증 · 어학, 수상. Remove an empty section rather than leaving a heading with nothing under it.
- 병역 section is commented out by default. Enable it only when the user asks or the posting requires it.

## Known pitfalls

- `warning: unknown font family` for one of the three font names is expected: macOS has `Noto Sans KR`, the Docker image has `Noto Sans CJK KR`. Only a warning naming all three is a real problem.
- `@` in Typst markup starts a reference (`@label`) and fails the compile. Keep email addresses inside strings (`"name@example.com"`), never bare in `[...]` content.
- `#`, `$`, `*`, `_`, `<`, `` ` `` and `\` are markup in Typst content blocks. Escape them with `\` when they appear in literal text (`C\#`, `\$100`, `snake\_case`), or put the text in a string.
- `entry-head` is `sticky`, so a heading never sits alone at the bottom of a page. If page 2 overflows into page 3, cut by relevance per `05-cv-templates.md`, do not shrink the font below 9pt.
- Hangul inside `justify: true` paragraphs breaks between syllables, which is normal Korean typesetting. The CV keeps `justify: false`.
- Typst writes only the PDF (no aux files), so `/apply`'s cleanup step has nothing extra to delete.
