/* =====================================================================
   PROGRAMMING 1 — SHARED SCRIPT
   Powers the slide engine, sidebar, theme toggle, fullscreen, quizzes,
   and small UX niceties used across every Topic##_*.html page.
   This file is safe to include on index.html too (it no-ops there).
   ===================================================================== */

(function () {
  'use strict';

  /* -------------------------------------------------------------------
     THEME (Dark / Light) — persisted in localStorage, falls back to OS
     preference. Works per-file when opened via file:// (each local file
     may have its own storage bucket in some browsers); still applies
     correctly within a single page session either way.
     ------------------------------------------------------------------- */
  function initTheme() {
    const root = document.documentElement;
    const toggleBtn = document.getElementById('darkModeToggle');
    const stored = safeGet('ptheme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    applyTheme(stored || (prefersDark ? 'dark' : 'light'));

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        safeSet('ptheme', next);
      });
    }

    function applyTheme(mode) {
      root.setAttribute('data-theme', mode);
      if (toggleBtn) {
        const icon = toggleBtn.querySelector('i');
        if (icon) icon.className = mode === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
        toggleBtn.setAttribute('aria-label', mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
    }
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore (privacy mode / file://) */ }
  }

  /* -------------------------------------------------------------------
     SIDEBAR (mobile off-canvas toggle)
     ------------------------------------------------------------------- */
  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const openBtn = document.getElementById('mobileSidebarToggle');
    const closeBtn = document.getElementById('sidebarCloseBtn');
    const overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;

    function open() {
      sidebar.classList.add('open');
      if (overlay) overlay.classList.add('visible');
    }
    function close() {
      sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('visible');
    }

    if (openBtn) openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (overlay) overlay.addEventListener('click', close);
  }

  /* -------------------------------------------------------------------
     FULLSCREEN
     ------------------------------------------------------------------- */
  function initFullscreen() {
    const btn = document.getElementById('fullscreenToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
    document.addEventListener('fullscreenchange', () => {
      const icon = btn.querySelector('i');
      if (!icon) return;
      icon.className = document.fullscreenElement ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
    });
  }

  /* -------------------------------------------------------------------
     PRESENTATION MODE
     Hides the sidebar + all chrome so the active slide fills the whole
     viewport. Toggled by the topbar "Present" button; exits via the
     floating exit button or the Escape key.
     ------------------------------------------------------------------- */
  function initPresentation() {
    const appContainer = document.querySelector('.app-container');
    const presentBtn = document.getElementById('presentToggle');
    const exitBtn = document.getElementById('presentExitBtn');
    if (!appContainer || !presentBtn) return;

    function setIcon(btn, iconClass) {
      const icon = btn.querySelector('i');
      if (icon) icon.className = iconClass;
    }

    function enter() {
      appContainer.classList.add('presentation-mode');
      presentBtn.setAttribute('aria-label', 'Exit presentation mode');
      setIcon(presentBtn, 'fa-solid fa-stop');
    }

    function exit() {
      appContainer.classList.remove('presentation-mode');
      presentBtn.setAttribute('aria-label', 'Enter presentation mode');
      setIcon(presentBtn, 'fa-solid fa-play');
    }

    presentBtn.addEventListener('click', () => {
      appContainer.classList.contains('presentation-mode') ? exit() : enter();
    });

    if (exitBtn) exitBtn.addEventListener('click', exit);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && appContainer.classList.contains('presentation-mode')) {
        exit();
      }
    });
  }

  /* -------------------------------------------------------------------
     SLIDE ENGINE
     ------------------------------------------------------------------- */
  function initSlides() {
    const viewport = document.getElementById('slidesViewport');
    if (!viewport) return; // page has no slide deck (shouldn't happen, but stay safe)

    const slides = Array.from(viewport.querySelectorAll('.slide'));
    const total = slides.length;
    if (total === 0) return;

    const progressBar = document.getElementById('progressBar');
    const counterEl = document.getElementById('slideCounter');
    const dotsContainer = document.getElementById('dotsContainer');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');

    let current = 0;

    // Deep-link support: #slide-4 opens directly on slide 4
    const hashMatch = /slide-(\d+)/.exec(window.location.hash);
    if (hashMatch) {
      const idx = parseInt(hashMatch[1], 10) - 1;
      if (idx >= 0 && idx < total) current = idx;
    }

    // Build dot navigation
    if (dotsContainer) {
      dotsContainer.innerHTML = '';
      slides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = 'dot';
        dot.setAttribute('aria-label', 'Go to slide ' + (i + 1));
        dot.addEventListener('click', () => goTo(i));
        dotsContainer.appendChild(dot);
      });
    }

    function render() {
      slides.forEach((s, i) => {
        s.classList.toggle('active', i === current);
        s.setAttribute('aria-hidden', i === current ? 'false' : 'true');
      });

      if (progressBar) progressBar.style.width = ((current + 1) / total * 100) + '%';
      if (counterEl) counterEl.textContent = 'Slide ' + (current + 1) + ' of ' + total;

      if (dotsContainer) {
        Array.from(dotsContainer.children).forEach((d, i) => d.classList.toggle('active', i === current));
      }

      if (prevBtn) prevBtn.disabled = current === 0;
      if (nextBtn) nextBtn.disabled = current === total - 1;

      try { history.replaceState(null, '', '#slide-' + (current + 1)); } catch (e) { /* file:// origins block state updates */ }

      // Scroll the new active slide back to top
      slides[current].scrollTop = 0;
      updateBackToTop(slides[current]);
    }

    function goTo(index) {
      if (index < 0 || index >= total || index === current) return;
      current = index;
      render();
    }

    function next() { goTo(current + 1); }
    function prev() { goTo(current - 1); }

    if (nextBtn) nextBtn.addEventListener('click', next);
    if (prevBtn) prevBtn.addEventListener('click', prev);

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      // Don't hijack keys while typing in a form field
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          prev();
          break;
        case 'Home':
          e.preventDefault();
          goTo(0);
          break;
        case 'End':
          e.preventDefault();
          goTo(total - 1);
          break;
      }
    });

    // Basic swipe support for touch devices
    let touchStartX = null;
    viewport.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
    viewport.addEventListener('touchend', (e) => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 60) { dx < 0 ? next() : prev(); }
      touchStartX = null;
    }, { passive: true });

    // Back-to-top button (one shared button injected into the active slide's scroll area)
    function updateBackToTop(slideEl) {
      let btn = viewport.querySelector('.back-to-top');
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'back-to-top';
        btn.setAttribute('aria-label', 'Back to top of slide');
        btn.innerHTML = '<i class="fa-solid fa-arrow-up" aria-hidden="true"></i>';
        viewport.appendChild(btn);
        btn.addEventListener('click', () => {
          const active = viewport.querySelector('.slide.active');
          if (active) active.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
      slides.forEach(s => s.removeEventListener('scroll', s._btHandler || (() => {})));
      slideEl.addEventListener('scroll', function handler() {
        btn.classList.toggle('visible', slideEl.scrollTop > 160);
      });
    }

    // Highlight.js syntax highlighting (if library loaded on this page)
    if (window.hljs) {
      document.querySelectorAll('.code-block code').forEach((block) => {
        window.hljs.highlightElement(block);
      });
    }

    render();
  }

  /* -------------------------------------------------------------------
     EXPORT TO PDF
     Renders every slide in the deck to a canvas (via html2canvas) and
     stitches the images into a downloadable PDF (via jsPDF) — the whole
     deck is generated client-side from this page's own markup, then
     saved straight to the browser's downloads folder.
     ------------------------------------------------------------------- */
  function initExportPdf() {
    const btn = document.getElementById('exportPdfBtn');
    const viewport = document.getElementById('slidesViewport');
    if (!btn || !viewport) return;

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;

      if (!window.html2canvas || !window.jspdf) {
        alert('PDF export could not start: the export libraries failed to load (check your internet connection).');
        return;
      }

      const appContainer = document.querySelector('.app-container');
      const slides = Array.from(viewport.querySelectorAll('.slide'));
      const originalActiveIndex = slides.findIndex((s) => s.classList.contains('active'));
      const backToTop = viewport.querySelector('.back-to-top');
      const icon = btn.querySelector('i');
      const originalIconClass = icon ? icon.className : '';

      btn.disabled = true;
      if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
      if (appContainer) appContainer.classList.add('pdf-exporting');
      if (backToTop) backToTop.style.display = 'none';

      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch (e) { /* ignore */ }
      }

      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-alt').trim() || '#ffffff';
      const { jsPDF } = window.jspdf;
      let pdf = null;

      const CAPTURE_SCALE = 2;
      const CAPTURE_DPI = 96 * CAPTURE_SCALE; // html2canvas renders at CAPTURE_SCALE × the browser's 96dpi CSS-pixel grid
      const PAGE_PADDING_IN = 0.5;

      try {
        for (let i = 0; i < slides.length; i++) {
          slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
          slides[i].scrollTop = 0;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

          const target = slides[i].querySelector('.slide-inner') || slides[i];
          const canvas = await window.html2canvas(target, {
            backgroundColor: bg,
            scale: CAPTURE_SCALE,
            useCORS: true
          });

          const imgData = canvas.toDataURL('image/jpeg', 0.92);
          const contentWIn = canvas.width / CAPTURE_DPI;
          const contentHIn = canvas.height / CAPTURE_DPI;
          const pageWIn = contentWIn + PAGE_PADDING_IN * 2;
          const pageHIn = contentHIn + PAGE_PADDING_IN * 2;
          const orientation = pageWIn >= pageHIn ? 'landscape' : 'portrait';

          if (!pdf) {
            pdf = new jsPDF({ orientation, unit: 'in', format: [pageWIn, pageHIn], compress: true });
          } else {
            pdf.addPage([pageWIn, pageHIn], orientation);
          }
          // Fill the full page (including the 0.5in padding margin) with the
          // deck's background color first, then place the slide on top of it.
          pdf.setFillColor(bg);
          pdf.rect(0, 0, pageWIn, pageHIn, 'F');
          pdf.addImage(imgData, 'JPEG', PAGE_PADDING_IN, PAGE_PADDING_IN, contentWIn, contentHIn);
        }

        if (pdf) {
          const rawTitle = document.title.split('|')[0].trim();
          const filename = rawTitle.replace(/[—–]/g, '-').replace(/\s+/g, '_').replace(/[^\w\-]/g, '') + '.pdf';
          pdf.save(filename);
        }
      } finally {
        slides.forEach((s, idx) => s.classList.toggle('active', idx === originalActiveIndex));
        if (backToTop) backToTop.style.display = '';
        if (appContainer) appContainer.classList.remove('pdf-exporting');
        if (icon) icon.className = originalIconClass;
        btn.disabled = false;
      }
    });
  }

  /* -------------------------------------------------------------------
     QUIZ INTERACTIONS
     Two supported patterns:
       1) Multiple choice: .quiz-option buttons with data-correct="true|false"
          inside a .quiz-question — click reveals correct/incorrect state.
       2) Simple reveal: a ".reveal-btn" toggles the next ".reveal-answer".
     ------------------------------------------------------------------- */
  function initQuiz() {
    document.querySelectorAll('.quiz-question').forEach((question) => {
      const options = Array.from(question.querySelectorAll('.quiz-option'));
      const feedback = question.querySelector('.quiz-feedback');
      options.forEach((opt) => {
        opt.addEventListener('click', () => {
          if (opt.disabled) return;
          const isCorrect = opt.getAttribute('data-correct') === 'true';
          options.forEach((o) => {
            o.disabled = true;
            if (o.getAttribute('data-correct') === 'true') o.classList.add('correct');
          });
          if (!isCorrect) opt.classList.add('incorrect');
          if (feedback) {
            feedback.textContent = isCorrect
              ? 'Correct! Well done.'
              : 'Not quite — the highlighted option is correct.';
            feedback.className = 'quiz-feedback ' + (isCorrect ? 'correct-text' : 'incorrect-text');
          }
        });
      });
    });

    document.querySelectorAll('.reveal-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const answer = btn.nextElementSibling;
        if (!answer || !answer.classList.contains('reveal-answer')) return;
        const shown = answer.classList.toggle('shown');
        btn.textContent = shown ? 'Hide Answer' : 'Reveal Answer';
      });
    });
  }

  /* -------------------------------------------------------------------
     INIT
     ------------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initSidebar();
    initFullscreen();
    initPresentation();
    initSlides();
    initQuiz();
    initExportPdf();
  });
})();
