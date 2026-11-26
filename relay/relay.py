#!/usr/bin/env python3
"""야심한 남자 문자 중계 서버 (AWS 라이트세일, 고정 IP)

솔라피는 등록된 고정 IP에서 온 요청만 받는다. Apps Script는 IP가 바뀌므로
Apps Script → 이 서버(고정 IP) → api.solapi.com 으로 그대로 전달한다.
- 솔라피 키는 여기 두지 않는다. Apps Script가 서명한 Authorization 헤더를 그대로 넘길 뿐.
- 허용 경로만 전달(문자 발송), 그 외는 404. 요청 크기 제한.
"""
import http.server, ssl, urllib.request, urllib.error, json, time

ALLOW = {"/messages/v4/send", "/messages/v4/send-many/detail"}
MAX = 64 * 1024

class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self._send(200, b'{"ok":true}') if self.path == "/health" else self._send(404, b"{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        auth = self.headers.get("Authorization") or ""
        if self.path not in ALLOW or n > MAX or not auth.startswith("HMAC-SHA256 "):
            return self._send(404, b"{}")
        data = self.rfile.read(n)
        req = urllib.request.Request("https://api.solapi.com" + self.path, data=data, method="POST",
                                     headers={"Authorization": auth, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                self._send(r.status, r.read())
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read())
        except Exception as e:
            self._send(502, json.dumps({"error": str(e)[:200]}).encode())

    def log_message(self, fmt, *a):  # 전화번호·내용은 남기지 않음
        print(time.strftime("%F %T"), self.command, self.path, flush=True)

srv = http.server.ThreadingHTTPServer(("0.0.0.0", 443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/opt/relay/cert.pem", "/opt/relay/key.pem")
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
