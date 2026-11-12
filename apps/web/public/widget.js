/* RouteNorth tracking widget. Add <div data-routenorth-track="LINK-TOKEN"></div> and this script to a page. */
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : "";
  function mount(el) {
    if (el.getAttribute("data-rn-ready")) return;
    var token = el.getAttribute("data-routenorth-track");
    if (!token || !/^[A-Za-z0-9_-]{8,}$/.test(token)) return;
    el.setAttribute("data-rn-ready", "1");
    var f = document.createElement("iframe");
    f.src = origin + "/j/" + encodeURIComponent(token) + "?embed=1";
    f.title = el.getAttribute("data-title") || "Delivery tracking";
    f.loading = "lazy";
    f.style.cssText = "width:100%;border:0;border-radius:8px;height:" + (parseInt(el.getAttribute("data-height"), 10) || 520) + "px";
    f.setAttribute("allow", "");
    f.setAttribute("referrerpolicy", "origin");
    el.appendChild(f);
  }
  function run() { document.querySelectorAll("[data-routenorth-track]").forEach(mount); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
