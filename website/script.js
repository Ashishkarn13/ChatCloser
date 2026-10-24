/* ChatCloser 2.0 landing — interactivity
   1) 3D tilt on the hero phone (desktop, fine pointer only)
   2) spotlight follow + micro-tilt on feature cards
   3) scroll-reveal via IntersectionObserver (staggered by CSS)
   4) reading progress bar in the nav
   5) active section highlighting in the nav
   6) nav shadow + back-to-top button */

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1) hero tilt ---------- */
  var scene = document.getElementById("tiltScene");
  var wrap = document.getElementById("tiltWrap");
  var hero = document.querySelector(".hero");

  if (scene && wrap && hero && !reduceMotion) {
    var finePointer = window.matchMedia("(pointer: fine)").matches;
    if (finePointer) {
      var maxTilt = 10; // degrees

      hero.addEventListener("mousemove", function (e) {
        var rect = scene.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        // normalized -1..1 relative to the scene center
        var nx = (e.clientX - cx) / Math.max(rect.width, 1);
        var ny = (e.clientY - cy) / Math.max(rect.height, 1);

        var ry = -14 + nx * maxTilt; // base pose + follow
        var rx = 6 - ny * maxTilt * 0.7;

        wrap.style.setProperty("--ry", ry.toFixed(2) + "deg");
        wrap.style.setProperty("--rx", rx.toFixed(2) + "deg");
      });

      hero.addEventListener("mouseleave", function () {
        wrap.style.setProperty("--ry", "-14deg");
        wrap.style.setProperty("--rx", "6deg");
      });
    }
  }

  /* ---------- 2) card spotlight + micro tilt ---------- */
  var cards = document.querySelectorAll("[data-tilt]");
  cards.forEach(function (card) {
    if (reduceMotion) {
      card.addEventListener("mousemove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
        card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
      });
      return;
    }
    card.addEventListener("mousemove", function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      card.style.setProperty("--mx", (px * 100).toFixed(1) + "%");
      card.style.setProperty("--my", (py * 100).toFixed(1) + "%");
      card.style.transform =
        "perspective(700px) rotateX(" + ((0.5 - py) * 4).toFixed(2) + "deg)" +
        " rotateY(" + ((px - 0.5) * 6).toFixed(2) + "deg)" +
        " translateY(-4px)";
    });
    card.addEventListener("mouseleave", function () {
      card.style.transform = "";
    });
  });

  /* ---------- 3) scroll reveal ---------- */
  var targets = document.querySelectorAll(".reveal, .card, .inv, .pay-card, .float-card, .phone, .providers");
  if ("IntersectionObserver" in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("show");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    targets.forEach(function (t) { io.observe(t); });
  } else {
    targets.forEach(function (t) { t.classList.add("show"); });
  }

  /* ---------- 4-6) scroll progress, active nav, nav shadow, to-top ---------- */
  var nav = document.getElementById("siteNav");
  var progress = nav ? nav.querySelector(".progress") : null;
  var toTop = document.getElementById("toTop");
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-links a"));
  var sections = navLinks
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;

      var y = window.scrollY || document.documentElement.scrollTop;
      var max = document.documentElement.scrollHeight - window.innerHeight;

      // 4) progress bar
      if (progress) {
        var pct = max > 0 ? Math.min(100, (y / max) * 100) : 0;
        progress.style.width = pct.toFixed(2) + "%";
      }

      // 6) nav shadow + back-to-top
      if (nav) nav.classList.toggle("scrolled", y > 8);
      if (toTop) toTop.classList.toggle("show", y > 600);

      // 5) active nav link: last section whose top is above the fold-third
      if (sections.length) {
        var current = null;
        var probe = y + window.innerHeight * 0.34;
        for (var i = 0; i < sections.length; i++) {
          if (sections[i].offsetTop <= probe) current = sections[i];
        }
        navLinks.forEach(function (a) {
          a.classList.toggle("active", !!current && a.getAttribute("href") === "#" + current.id);
        });
      }
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();
})();
