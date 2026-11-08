import { Marked, type Tokens } from "marked";

// Assistant replies quote job postings, which are untrusted third-party text.
// Raw HTML is escaped and only http(s)/mailto links survive, so a posting
// cannot inject markup or script into the UI.
const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function safeHref(href: string): string | null {
  try {
    const u = new URL(href, "https://invalid.local/");
    if (u.origin === "https://invalid.local") return null;
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    },
    image(token: Tokens.Image) {
      return escapeHtml(token.text || token.href);
    },
  },
});

export function renderMarkdown(text: string): string {
  return md.parse(text, { async: false }) as string;
}
