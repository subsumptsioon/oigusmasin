#!/usr/bin/env python3
"""
css_audit.py — compare CSS across the Õigusmasin pages.

Extracts every rule from each page's inline <style> block (and optionally
noir.css), groups by the top-level selector ("families"), and reports:
  - selectors that appear on >1 page (potential near-duplicates)
  - for each, the full rule body on every page it appears in

Usage:
  python3 css_audit.py [--all] [--family <selector>]

  --family  show every page's version of one selector family
  --all     print ALL families with 2+ matches (not just names)
"""
import re
import sys
import html

PAGES = [
    "index.html",
    "isikukood.html",
    "karistuste-liitmine.html",
    "ennetahtaegne-vabastamine.html",
    "rehkendaja-test.html",
    "narkonimekirjad.html",
]


def inline_css(path):
    """Return the joined text of every <style>...</style> block in a file."""
    src = open(path, encoding="utf-8").read()
    blocks = re.findall(r"<style>(.*?)</style>", src, flags=re.S | re.I)
    return "\n".join(blocks)


def parse_rules(css):
    """Parse CSS into a list of (selector, body) at top level.

    Strips comments. Handles braces inside bodies (e.g. keyframes/media) by
    tracking depth, so a top-level rule is one whose '{' closes at depth 1.
    Returns dict selector -> list of body strings (a selector may repeat).
    """
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    rules = {}
    i, n = 0, len(css)
    while i < n:
        # skip whitespace
        while i < n and css[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        # find the opening brace of a rule; selector = everything before it
        open_b = css.find("{", i)
        if open_b == -1:
            break
        sel = css[i:open_b].strip().replace("\n", " ")
        # find matching close brace accounting for nesting
        depth = 1
        j = open_b + 1
        while j < n and depth > 0:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        body = css[open_b + 1 : j - 1].strip()
        if sel:
            rules.setdefault(sel, []).append(body)
        i = j
    return rules


def norm_body(body):
    """Normalise a rule body for comparison (collapse whitespace)."""
    return re.sub(r"\s+", " ", body).strip()


def collect():
    families = {}  # selector -> {page: [bodies]}
    for p in PAGES:
        rules = parse_rules(inline_css(p))
        for sel, bodies in rules.items():
            fam = families.setdefault(sel, {})
            fam.setdefault(p, []).extend(bodies)
    return families


def main():
    args = sys.argv[1:]
    show_all = "--all" in args
    only = None
    for a in args:
        if a.startswith("--family="):
            only = a.split("=", 1)[1]

    families = collect()

    if only is not None:
        fam = families.get(only)
        if not fam:
            print(f"selector '{only}' not found inline in any page")
            return
        print(f"### {only}  (pages: {len(fam)})\n")
        for page, bodies in fam.items():
            for body in bodies:
                print(f"--- {page} ---")
                print(f"{html.unescape(only)} {{")
                for line in body.splitlines():
                    print("  " + line)
                print("}\n")
        return

    # report selectors that appear on multiple pages
    multi = {s: fam for s, fam in families.items() if len(fam) > 1}
    if not multi:
        print("No selector appears on more than one page.")
        return

    # group into identical vs differing
    identical = []
    differing = []
    for sel, fam in sorted(multi.items()):
        pages = sorted(fam)
        n_unique = {norm_body(b) for bs in fam.values() for b in bs}
        if all(norm_body(b) == next(iter([norm_body(x) for x in fam[pages[0]]])) for p in fam for b in fam[p]):
            identical.append(sel)
        else:
            differing.append(sel)

    print(f"=== {len(multi)} selector families appear on 2+ pages ===\n")
    print("IDENTICAL across all pages (safe to hoist into noir.css as-is):")
    for s in sorted(identical):
        pag = ",".join(sorted(multi[s]))
        print(f"  {s}   <{pag}>")
    print("\nDIFFERING between pages (need review before unifying):")
    for s in sorted(differing):
        pag = ",".join(sorted(multi[s]))
        print(f"  {s}   <{pag}>")

    if show_all:
        print("\n" + "=" * 60)
        for sel, fam in sorted(multi.items()):
            print(f"\n### {sel}  (pages: {','.join(sorted(fam))})")
            for page in sorted(fam):
                for body in fam[page]:
                    print(f"  -- {page}: {html.unescape(sel)} {{ {norm_body(body)} }}")


if __name__ == "__main__":
    main()
