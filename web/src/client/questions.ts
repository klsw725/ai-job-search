import type { CountMode, SelfIntroQuestion } from "../server/selfIntro.ts";

// A numbered question starts a block: "1.", "1)", "Q1", "문항 1", "[1]".
const MARKER = /^\s*(?:\d{1,2}\s*[.)]|Q\s*\d{1,2}\s*[.):]?|문항\s*\d{1,2}\s*[.):]?|\[\s*\d{1,2}\s*\])\s*/i;
const LIMIT = /(\d{1,2}(?:,\d{3})|\d{2,5})\s*(자|byte|bytes|바이트)/i;

export function countModeOf(text: string): CountMode {
  if (/byte|바이트/i.test(text)) return "bytes";
  if (/공백\s*(?:제외|미포함)/.test(text)) return "without_spaces";
  return "with_spaces";
}

// Questions copied from an application form. Numbered blocks become one
// question each; unnumbered text splits on blank lines. A limit such as
// "(700자 이내)" or "1000 bytes" and "공백 제외" are read from the block.
export function parsePastedQuestions(raw: string): SelfIntroQuestion[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const numbered = lines.some((l) => MARKER.test(l));
  const blocks: string[][] = [];
  for (const line of lines) {
    if (numbered ? MARKER.test(line) : !line.trim()) blocks.push([]);
    if (!blocks.length) blocks.push([]);
    if (line.trim()) blocks[blocks.length - 1]!.push(numbered ? line.replace(MARKER, "") : line);
  }
  return blocks
    .map((b) => b.join("\n").trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((question) => {
      const m = LIMIT.exec(question);
      const limit = m ? Number(m[1]!.replace(",", "")) : undefined;
      return { question, ...(limit && limit >= 50 && limit <= 10_000 ? { limit } : {}), count: countModeOf(question) };
    });
}
