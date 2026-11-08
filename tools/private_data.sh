#!/bin/sh
# Separate, private git history for the personal files this repo's .gitignore
# keeps out of the public fork (profile overlays, documents, tracker, generated
# CVs). It lives in .private-data.git next to the main .git and shares the same
# working tree, so nothing moves and the main repo never sees these files.
# Credential-like files (.env, keys, tokens) are never included.
#
#   tools/private_data.sh init            create the private history
#   tools/private_data.sh save [message]  snapshot every personal file
#   tools/private_data.sh status | log    inspect it
#   tools/private_data.sh remote <url>    attach a PRIVATE remote (e.g. a private GitHub repo)
#   tools/private_data.sh push --confirm-private   push to that remote (refuses a public GitHub repo)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PRIVATE_GIT="$ROOT/.private-data.git"

PATHS="documents job_search_tracker.csv job_scraper cv cover_letters company_research reports upskill gmail_sync salary_data.json"
# Tracked framework files inside those folders: the main repo already versions them.
FRAMEWORK="cv/main_example.tex cover_letters/cover_example.tex cover_letters/cover.cls cover_letters/OpenFonts"
# Never back up anything that looks like a credential, wherever it sits.
SECRETS=":(glob)**/.env :(glob)**/.env.* :(glob)**/*.pem :(glob)**/*.key :(glob)**/*.p12 :(glob)**/id_rsa* :(glob)**/id_ed25519* :(glob)**/.netrc :(glob)**/credentials*.json :(glob)**/client_secret*.json :(glob)**/token*.json"
JUNK=":(glob)**/.DS_Store :(glob)**/build/** :(glob)**/node_modules/**"

pgit() {
  git --git-dir="$PRIVATE_GIT" --work-tree="$ROOT" "$@"
}

# A path is in scope if it exists now or was in an earlier snapshot, so that
# deleting a whole folder or a top-level file is recorded as a deletion.
selection() {
  for p in $PATHS; do
    if [ -e "$ROOT/$p" ] || [ -n "$(pgit ls-files -- "$p" | head -n 1)" ]; then
      printf '%s\n' "$p"
    fi
  done
}

require_init() {
  [ -d "$PRIVATE_GIT" ] || { echo "Run 'tools/private_data.sh init' first." >&2; exit 1; }
}

github_visibility() {
  slug=$(printf '%s\n' "$1" | sed -n -E 's#^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\2#p' | sed 's/\.git$//')
  [ -n "$slug" ] || { echo unknown; return; }
  code=$(curl -s -o /tmp/private_data_repo.$$ -w '%{http_code}' "https://api.github.com/repos/$slug" || echo 000)
  if [ "$code" = 200 ] && grep -q '"private": *false' /tmp/private_data_repo.$$; then
    echo public
  else
    echo unknown
  fi
  rm -f /tmp/private_data_repo.$$
}

cmd=${1:-help}
case "$cmd" in
  init)
    if [ -d "$PRIVATE_GIT" ]; then
      echo "Already initialized: $PRIVATE_GIT"
      exit 0
    fi
    git init -q --bare "$PRIVATE_GIT"
    pgit config core.bare false
    pgit config status.showUntrackedFiles no
    echo "Initialized private history in $PRIVATE_GIT"
    ;;
  save)
    require_init
    cd "$ROOT"
    sel=$(selection)
    if [ -z "$sel" ]; then
      echo "No personal files yet - nothing to snapshot."
      exit 0
    fi
    # -f: these paths are ignored by the main repo's .gitignore on purpose.
    # shellcheck disable=SC2086
    pgit add -A -f -- $sel
    # shellcheck disable=SC2086
    secrets=$(pgit ls-files -- $SECRETS)
    if [ -n "$secrets" ]; then
      echo "Excluded (looks like a credential, never backed up):"
      printf '  %s\n' $secrets
    fi
    # shellcheck disable=SC2086
    pgit rm -r -q --cached --ignore-unmatch -- $FRAMEWORK $SECRETS $JUNK >/dev/null
    if pgit diff --cached --quiet 2>/dev/null; then
      echo "Nothing changed since the last snapshot."
      exit 0
    fi
    pgit commit -q -m "${2:-snapshot $(date '+%Y-%m-%d %H:%M')}"
    pgit log --oneline -1
    ;;
  status)
    require_init
    cd "$ROOT"
    sel=$(selection)
    [ -n "$sel" ] || { echo "No personal files yet."; exit 0; }
    # shellcheck disable=SC2086
    pgit status --short --ignored=no -- $sel
    ;;
  log)
    require_init
    pgit log --oneline --stat -n "${2:-10}"
    ;;
  remote)
    require_init
    [ -n "${2:-}" ] || { echo "usage: tools/private_data.sh remote <url-of-a-PRIVATE-repo>" >&2; exit 1; }
    if pgit remote get-url origin >/dev/null 2>&1; then
      pgit remote set-url origin "$2"
    else
      pgit remote add origin "$2"
    fi
    echo "Private remote set to $2 - make sure that repository is private."
    ;;
  push)
    require_init
    pgit remote get-url origin >/dev/null 2>&1 || { echo "No remote yet: tools/private_data.sh remote <url>" >&2; exit 1; }
    # Check every URL git will actually push to (remote.origin.pushurl overrides url).
    urls=$(pgit remote get-url --push --all origin)
    unverified=""
    for url in $urls; do
      case "$(github_visibility "$url")" in
        public)
          echo "Refusing to push: $url is a PUBLIC GitHub repository." >&2
          exit 1
          ;;
        *) unverified="$unverified $url" ;;
      esac
    done
    # An anonymous check can prove a repo public but never private (a private
    # repo and a missing one both answer 404), so the user confirms explicitly.
    if [ -n "$unverified" ] && [ "${2:-}" != "--confirm-private" ]; then
      echo "Cannot verify that these push destinations are private:$unverified" >&2
      echo "If they are, run: tools/private_data.sh push --confirm-private" >&2
      exit 1
    fi
    pgit push -u origin HEAD
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
