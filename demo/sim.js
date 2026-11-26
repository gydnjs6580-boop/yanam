/* 체험(시뮬레이션) 모드 — 효원 테스트용. 링크 끝 #sim=1|2|3&k=… 로 켜고, 24시간 유지. 결제 버튼만 데모 결제 완료 화면으로 바꿈 */
(function () {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("sim") && h.get("k")) localStorage.setItem("yanam_sim", JSON.stringify({ m: h.get("sim"), k: h.get("k"), t: Date.now() }));
    if (h.get("sim") === "off") localStorage.removeItem("yanam_sim");
    const s = JSON.parse(localStorage.getItem("yanam_sim") || "null");
    if (!s || Date.now() - s.t > 864e5) return;
    const base = location.pathname.replace(/[^/]*$/, "").replace(/\/demo\/$/, "/");
    const names = { 1: "① 드라이브 권한", 2: "② 번호 새긴 PDF", 3: "③ 사이트에서 읽기" };
    const go = () => {
      const bar = document.createElement("div");
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99;background:#fff3cd;color:#7a5b00;font:600 12.5px/1.4 sans-serif;text-align:center;padding:6px 8px";
      bar.innerHTML = "체험 모드 " + (names[s.m] || "") + " · 실제 결제 안 됨 · <a href='#sim=off' style='color:#7a5b00'>끝내기</a>";
      bar.querySelector("a").onclick = () => { localStorage.removeItem("yanam_sim"); bar.remove(); };
      document.body.appendChild(bar);
      document.querySelectorAll('a[href*="payapp.kr"]').forEach(a => { a.href = base + "demo/ft-pay.html#k=" + s.k + "&m=" + s.m; a.removeAttribute("target"); });
    };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
  } catch (e) {}
})();
