#!/usr/bin/env python3
"""Character counts for 문항형 자기소개서 answers, exactly as
.claude/skills/job-application-assistant/10-korea-market.md section 4 counts
them: the text is stripped, 공백 제외 removes Python whitespace, and the byte
counts are UTF-8 and EUC-KR (characters EUC-KR cannot represent are listed and
not counted, as with encode('euc-kr', 'ignore')).

Reads a JSON array of strings on stdin and prints a JSON array of counts.

Usage:
  python3 tools/self_intro_count.py < texts.json
"""

import json
import sys


def counts(text: str) -> dict[str, object]:
    t = text.strip()
    bad = sorted({c for c in t if not c.encode("euc-kr", "ignore")})
    return {
        "with_spaces": len(t),
        "without_spaces": len("".join(t.split())),
        "utf8_bytes": len(t.encode()),
        "bytes": len(t.encode("euc-kr", "ignore")),
        "unencodable": "".join(bad),
    }


def main() -> int:
    try:
        texts = json.loads(sys.stdin.read())
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"input is not JSON: {exc}"}))
        return 1
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
        print(json.dumps({"error": "input must be a JSON array of strings"}))
        return 1
    print(json.dumps([counts(t) for t in texts], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
