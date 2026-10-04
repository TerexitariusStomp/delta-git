// wp-cloud try-it widget — embeddable Playground launcher (P3 growth loop):
// <script src="https://<platform>/widget.js" data-blueprint='{"landingPage":"/wp-admin/"}' defer></script>
(function () {
  const btn = document.createElement("button");
  btn.textContent = "Try WordPress in your browser";
  btn.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:99999;padding:10px 16px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font:14px system-ui;cursor:pointer";
  document.body.appendChild(btn);
  btn.onclick = async () => {
    const { startPlaygroundWeb } = await import("https://esm.sh/@wp-playground/client@1.2.10?bundle-deps");
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;inset:5%;z-index:99998;border:1px solid #334;border-radius:12px;background:#fff";
    document.body.appendChild(frame);
    const bp = document.currentScript?.dataset.blueprint;
    await startPlaygroundWeb({ iframe: frame, remoteUrl: "https://playground.wordpress.net/remote.html", blueprint: bp ? JSON.parse(bp) : undefined });
    const x = document.createElement("button");
    x.textContent = "×";
    x.style.cssText = "position:fixed;top:4%;right:4.5%;z-index:99999;font:20px system-ui;background:none;border:0;color:#fff;cursor:pointer";
    x.onclick = () => { frame.remove(); x.remove(); };
    document.body.appendChild(x);
  };
})();
