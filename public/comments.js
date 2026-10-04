// wp-cloud comments — embed on any published Lane-1 page:
//   <div id="wpc-comments" data-site="SITE_ID"></div><script src="https://<platform>/comments.js" defer></script>
(function () {
  const host = document.getElementById("wpc-comments");
  if (!host) return;
  const api = location.hostname.endsWith("pages.dev") ? "" : `${location.protocol}//api.${location.hostname.split(".").slice(-2).join(".")}`;
  const site = host.dataset.site, path = location.pathname;
  async function load() {
    const rows = await (await fetch(`${api}/api/comments?site=${site}&path=${encodeURIComponent(path)}`)).json();
    host.innerHTML = "<h3>Comments</h3>" + rows.map((c) => `<p><b>${esc(c.author)}</b>: ${esc(c.body)}</p>`).join("") +
      `<form><input name=author placeholder="Name" required><br><textarea name=body required></textarea><br><button>Comment</button></form>`;
    host.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      await fetch(`${api}/api/comments`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ site_id: site, post_path: path, author: f.get("author"), body: f.get("body") }) });
      e.target.outerHTML = "<p>Comment submitted for review.</p>";
    };
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  load();
})();
