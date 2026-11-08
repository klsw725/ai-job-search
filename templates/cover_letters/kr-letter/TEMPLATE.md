# Template: kr-letter

- **Type:** Cover letter
- **Source extension:** .typ
- **Engine/toolchain:** typst
- **Page limit:** 1 page(s)
- **Fonts:** Noto Sans KR (system font - must be installed; `Noto Sans CJK KR` from Debian's fonts-noto-cjk in the Docker image; Apple SD Gothic Neo is the macOS fallback)
- **Class/packages:** standard (no imports; the style block is inline so each letter compiles on its own)

## Compile command

    cd cover_letters && typst compile <file>.typ <file>.pdf

## Style rules

- Above the `CONTENT` banner, set only `doc-lang` (`"ko"` or `"en"`, matching the posting), `candidate` and `company` (both also written into the PDF metadata); leave the rest unchanged.
- Korean letters: `[회사명] 채용 담당자님께,` salutation, 합쇼체 throughout, closing `검토해 주셔서 감사합니다.` style sentence, signature `[이름] 드림`. Date as `2026년 11월 8일`. Rules in `10-korea-market.md` section 3.
- English letters: `Dear [Hiring Manager / Team],`, signature `Kind regards, \ Name` - `[SIGNATURE]` sits in a markup block, so the Typst `\` gives the name its own line. Date as `8 November 2026`.
- Headline line follows `03-writing-style.md` "Application Headline": specialty + posting keyword. Not "지원서" or "Application for ...".
- 3-5 bullets in the task-solving section, each `*Label:* evidence`. Bullets sit directly in the body; no wrapper needed (unlike the stock cover.cls).
- Contact details stay as a list of **strings** joined with `"  ·  "`.
- This template is for a free-form letter or 자유양식 자기소개서. Numbered 자기소개서 questions go to a character-counted `.txt`, not this file (`10-korea-market.md` section 4).

## Known pitfalls

- `warning: unknown font family` for one of the three font names is expected: macOS has `Noto Sans KR`, the Docker image has `Noto Sans CJK KR`. Only a warning naming all three is a real problem.
- `@` in Typst markup starts a reference and fails the compile. Keep email addresses inside strings.
- `#`, `$`, `*`, `_`, `<`, `` ` `` and `\` are markup in content. Escape them with `\` in literal text.
- Body paragraphs use `justify: true`; Hangul breaking between syllables at line ends is normal Korean typesetting.
- `align(right, ...)` inside a `block` needs `width: 100%` on the block, otherwise the block shrinks to its content and the signature renders left-aligned.
- Typst writes only the PDF, so `/apply`'s cleanup step has nothing extra to delete.
