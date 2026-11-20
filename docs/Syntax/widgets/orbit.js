// A demo note widget, loaded through the widget channel (same-origin script +
// companion stylesheet). CSP-clean: DOM comes only from createElement, styling
// only from orbit.css / the CSSOM, and it makes no external requests.
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue("--accent").trim() || "#0a6cd6",
      faint: cs.getPropertyValue("--fg-faint").trim() || "#b0b0b5",
      border: cs.getPropertyValue("--border").trim() || "#e7e7ea",
    };
  }

  function init(host) {
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    if (!ctx) return;

    var colors = themeColors();
    var pointer = { x: -1e4, y: -1e4 };
    var running = false;
    var visible = false;
    var raf = 0;

    // One particle per orbit; angle drifts, radius breathes, the pointer
    // excites whatever passes near it.
    var orbits = [];
    for (var i = 0; i < 64; i++) {
      orbits.push({
        a: Math.random() * Math.PI * 2,
        r: 0.12 + 0.82 * Math.pow(Math.random(), 0.7), // denser rim
        v: (0.12 + Math.random() * 0.5) * (Math.random() < 0.2 ? -1 : 1),
        breathe: 0.4 + Math.random() * 1.2,
        phase: Math.random() * Math.PI * 2,
        size: 0.8 + Math.random() * 1.8,
        px: 0,
        py: 0,
        heat: 0,
      });
    }

    function resize() {
      var rect = host.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      for (var k = 0; k < orbits.length; k++) {
        orbits[k].px = 0;
        orbits[k].py = 0; // no trail lines across a resize
      }
      if (reduce.matches) draw(0);
    }

    function draw(t) {
      var w = canvas.width;
      var h = canvas.height;
      var cx = w / 2;
      var cy = h / 2;
      var maxR = Math.min(w, h) * 0.44;
      var px = pointer.x;
      var py = pointer.y;
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = colors.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
      ctx.stroke();

      for (var k = 0; k < orbits.length; k++) {
        var o = orbits[k];
        var wob = 1 + 0.05 * Math.sin(t * 0.001 * o.breathe + o.phase);
        var x = cx + Math.cos(o.a) * o.r * maxR * wob;
        var y = cy + Math.sin(o.a) * o.r * maxR * wob * 0.96;

        var dx = x - px;
        var dy = y - py;
        var near = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / (maxR * 0.55));
        o.heat = o.heat * 0.94 + near * 0.06;

        ctx.beginPath();
        if (o.px) {
          ctx.moveTo(o.px, o.py);
          ctx.lineTo(x, y);
          ctx.strokeStyle = colors.accent;
          ctx.globalAlpha = 0.15 + 0.7 * o.heat;
          ctx.lineWidth = o.size * (0.7 + o.heat);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(x, y, o.size * (1 + o.heat * 1.6), 0, Math.PI * 2);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = o.heat > 0.25 ? colors.accent : colors.faint;
        ctx.fill();
        ctx.globalAlpha = 1;

        var speed = o.v * (1 + o.heat * 6);
        o.a += speed * 0.016;
        o.px = x;
        o.py = y;
      }
    }

    function tick(t) {
      raf = 0;
      if (!running) return;
      draw(t);
      raf = requestAnimationFrame(tick);
    }

    function start() {
      if (running || reduce.matches) return;
      running = true;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    host.addEventListener("pointermove", function (e) {
      var rect = canvas.getBoundingClientRect();
      var dpr = canvas.width / Math.max(1, rect.width);
      pointer.x = (e.clientX - rect.left) * dpr;
      pointer.y = (e.clientY - rect.top) * dpr;
    });
    host.addEventListener("pointerleave", function () {
      pointer.x = -1e4;
      pointer.y = -1e4;
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        function (entries) {
          visible = entries[0].isIntersecting;
          if (visible) start();
          else stop();
        },
        { threshold: 0.05 },
      ).observe(host);
    } else {
      visible = true;
      start();
    }

    if ("ResizeObserver" in window) new ResizeObserver(resize).observe(host);
    else window.addEventListener("resize", resize);
    if (reduce.addEventListener) reduce.addEventListener("change", function () { resize(); if (!reduce.matches && visible) start(); });

    // Follow the site's light/dark switch (theme-init writes data-theme).
    new MutationObserver(function () {
      colors = themeColors();
      if (reduce.matches) draw(0);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    resize();
    if (visible) start();
    if (reduce.matches) draw(0);
  }

  for (var n = 0; n < document.querySelectorAll(".w-orbit").length; n++) {
    init(document.querySelectorAll(".w-orbit")[n]);
  }
})();
