#!/usr/bin/env python3
"""HTML 수정 후 자동 검사 (정적 페이지용, 가볍게).

- 훅으로 실행(--hook): stdin에 Claude Code 훅 JSON이 오면 수정된 .html 파일 하나만 검사.
- 직접 실행: `python3 .claude/hooks/check_html.py [파일...]` (인자 없으면 저장소 전체 .html).
실패하면 stderr에 이유를 쓰고 exit 2 → Claude가 읽고 스스로 고친다.

검사 항목
1. 태그 짝: 열고 안 닫은/잘못 닫은 태그
2. 내부 링크: href/src가 가리키는 저장소 안 파일이 실제로 있는지
3. src 파라미터: ?src= 값이 비었거나 영문 소문자·숫자·_ 외 문자를 쓰는지
4. 인라인 <script> JS 문법 (node가 있을 때만)
"""
import json, os, re, subprocess, sys, tempfile
from html.parser import HTMLParser
from urllib.parse import urlsplit, parse_qs, unquote

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
# 브라우저가 닫는 태그를 생략해도 되는 것들(오탐 방지)
OPTIONAL_END = {"p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th",
                "thead", "tbody", "tfoot", "colgroup", "rt", "rp", "html", "head", "body"}
SRC_RE = re.compile(r"^[a-z0-9_]+$")


class Checker(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.errors, self.links, self.scripts = [], [], [], []
        self._in_script = None

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        a = dict(attrs)
        for k in ("href", "src", "action"):
            if a.get(k):
                self.links.append((line, a[k]))
        if tag == "script" and not a.get("src") and a.get("type", "text/javascript") in (
                "text/javascript", "module", "application/javascript"):
            self._in_script = [line, []]
        if tag not in VOID:
            self.stack.append((tag, line))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self.stack.pop()

    def handle_data(self, data):
        if self._in_script is not None:
            self._in_script[1].append(data)

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag == "script" and self._in_script is not None:
            self.scripts.append((self._in_script[0], "".join(self._in_script[1])))
            self._in_script = None
        if tag in VOID:
            return
        if not any(t == tag for t, _ in self.stack):
            self.errors.append(f"{line}행: 열지 않은 </{tag}>를 닫음")
            return
        while self.stack:
            t, l = self.stack.pop()
            if t == tag:
                break
            if t not in OPTIONAL_END:
                self.errors.append(f"{l}행: <{t}>가 닫히지 않음 (</{tag}> {line}행에서 끝남)")


def check_file(path):
    rel = os.path.relpath(path, ROOT)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    p = Checker()
    p.feed(text)
    p.close()
    errs = list(p.errors)
    for t, l in p.stack:
        if t not in OPTIONAL_END:
            errs.append(f"{l}행: <{t}>가 파일 끝까지 닫히지 않음")

    base = os.path.dirname(path)
    for line, url in p.links:
        u = urlsplit(url)
        if "${" in url or "{{" in url:
            continue  # JS 템플릿
        for v in parse_qs(u.query, keep_blank_values=True).get("src", []):
            if not SRC_RE.match(v) and v != "shorts_YYMMDD":
                errs.append(f"{line}행: src 파라미터 '{v}' 형식 오류 (영문 소문자·숫자·_ 만, 예 shorts_1127)")
        if u.scheme or url.startswith(("//", "#", "data:", "mailto:", "tel:", "javascript:")):
            continue
        if not u.path:
            continue
        target = os.path.normpath(os.path.join(ROOT if u.path.startswith("/") else base,
                                               unquote(u.path).lstrip("/")))
        if u.path.endswith("/"):
            target = os.path.join(target, "index.html")
        if not os.path.exists(target):
            errs.append(f"{line}행: 깨진 링크 '{url}' (파일 없음)")

    node = shutil_which("node")
    if node:
        for line, code in p.scripts:
            if not code.strip():
                continue
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
                tf.write(code)
            r = subprocess.run([node, "--check", tf.name], capture_output=True, text=True)
            os.unlink(tf.name)
            if r.returncode != 0:
                msg = next((x for x in r.stderr.splitlines() if "Error" in x), r.stderr.strip()[:200])
                m = re.search(r":(\d+)\n", r.stderr)
                at = f"(스크립트 {int(m.group(1))}번째 줄 → 파일 약 {line + int(m.group(1)) - 1}행)" if m else ""
                errs.append(f"{line}행 <script> JS 문법 오류 {at}: {msg}")
    return [f"{rel} {e}" for e in errs]


def shutil_which(cmd):
    from shutil import which
    return which(cmd)


def all_html():
    out = []
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"]
        out += [os.path.join(d, f) for f in files if f.endswith(".html")]
    return sorted(out)


def main():
    args = sys.argv[1:]
    hook = "--hook" in args
    files = [os.path.abspath(a) for a in args if a != "--hook"]
    if hook:
        raw = sys.stdin.read()
        if raw.strip():
            try:
                fp = (json.loads(raw).get("tool_input") or {}).get("file_path", "")
            except ValueError:
                fp = ""
            if not fp.endswith(".html") or not os.path.abspath(fp).startswith(ROOT):
                return 0  # HTML이 아니면 조용히 통과
            files = [os.path.abspath(fp)]
    if not files:
        files = all_html()
    errs = []
    for f in files:
        if os.path.exists(f):
            errs += check_file(f)
    if errs:
        print("HTML 검사 실패. 아래를 고친 뒤 다시 저장하세요:\n- " + "\n- ".join(errs[:30]), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
