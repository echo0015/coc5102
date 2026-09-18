/* =====================================================================
   PYTHON COMPILER — RUNTIME + EDITOR WIRING
   Boots a Python runtime (Pyodide: CPython compiled to WebAssembly) and
   wires it to a CodeMirror editor + output console. All execution stays
   client-side — nothing is sent to a server.

   Two engines, chosen automatically:
   - WorkerEngine (preferred): runs Pyodide in a Web Worker so a stuck
     script never freezes the page, and input() blocks on a
     SharedArrayBuffer so the student types their answer inline in the
     output console, like a real terminal. Requires cross-origin
     isolation (COOP/COEP headers — see vercel.json), so it's only
     available when the page is served with those headers.
   - MainThreadEngine (fallback): runs Pyodide on the main thread and
     uses window.prompt() for input(). Used when SharedArrayBuffer isn't
     available (e.g. the page opened directly from disk).
   ===================================================================== */

(function () {
  'use strict';

  const MAIN_THREAD_TIMEOUT_SECONDS = 8;
  const PYODIDE_HOME = '/home/pyodide';
  const STDIN_CAPACITY = 8192; // bytes available per input() line
  const STATE_IDLE = 0;
  const STATE_WAITING = 1;
  const STATE_READY = 2;

  const EXAMPLES = {
    hello: {
      label: 'Hello, World!',
      code: 'print("Hello, World!")\n'
    },
    variables: {
      label: 'Variables & Data Types',
      code:
        'name = "Ada"\n' +
        'age = 20\n' +
        'gpa = 3.8\n' +
        'is_enrolled = True\n\n' +
        'print(name, "is", age, "years old.")\n' +
        'print("GPA:", gpa, "| Enrolled:", is_enrolled)\n'
    },
    conditionals: {
      label: 'Conditionals',
      code:
        'score = 78\n\n' +
        'if score >= 90:\n' +
        '    grade = "A"\n' +
        'elif score >= 75:\n' +
        '    grade = "B"\n' +
        'else:\n' +
        '    grade = "C"\n\n' +
        'print("Score:", score, "-> Grade:", grade)\n'
    },
    loops: {
      label: 'Loops',
      code:
        'total = 0\n' +
        'for n in range(1, 6):\n' +
        '    total += n\n' +
        '    print("Added", n, "-> running total:", total)\n\n' +
        'print("Final total:", total)\n'
    },
    functions: {
      label: 'Functions',
      code:
        'def greet(name, greeting="Hello"):\n' +
        '    return f"{greeting}, {name}!"\n\n' +
        'print(greet("World"))\n' +
        'print(greet("Programming 1", greeting="Welcome"))\n'
    },
    lists: {
      label: 'Lists',
      code:
        'fruits = ["apple", "banana", "cherry"]\n' +
        'fruits.append("date")\n\n' +
        'for i, fruit in enumerate(fruits, start=1):\n' +
        '    print(i, fruit)\n\n' +
        'print("Total fruits:", len(fruits))\n'
    },
    input: {
      label: 'Reading Input',
      code:
        'name = input("What is your name? ")\n' +
        'print("Nice to meet you, " + name + "!")\n\n' +
        'age = int(input("How old are you? "))\n' +
        'print("Next year you will be", age + 1, "years old.")\n'
    },
    errors: {
      label: 'Errors & Exceptions',
      code:
        'def divide(a, b):\n' +
        '    try:\n' +
        '        return a / b\n' +
        '    except ZeroDivisionError:\n' +
        '        print("Cannot divide by zero!")\n' +
        '        return None\n\n' +
        'print(divide(10, 2))\n' +
        'print(divide(10, 0))\n'
    },
    filehandling: {
      label: 'File Handling',
      code:
        '# Writing to a file\n' +
        'with open("notes.txt", "w") as f:\n' +
        '    f.write("Programming 1\\n")\n' +
        '    f.write("File handling with open()!\\n")\n\n' +
        '# Reading it back\n' +
        'with open("notes.txt", "r") as f:\n' +
        '    for line in f:\n' +
        '        print(line.strip())\n\n' +
        '# Tip: open the "Data Files" panel above (folder icon) to\n' +
        '# download notes.txt, or upload your own file and open() it here.\n'
    }
  };

  const DEFAULT_CODE = EXAMPLES.hello.code;

  let editor = null;
  let engine = null;
  let isRunning = false;
  let currentFileName = 'main.py';

  const outputEl = document.getElementById('output');
  const runBtn = document.getElementById('runBtn');
  const stopBtn = document.getElementById('stopBtn');
  const resetBtn = document.getElementById('resetBtn');
  const clearOutputBtn = document.getElementById('clearOutputBtn');
  const statusEl = document.getElementById('runtimeStatus');
  const exampleSelect = document.getElementById('exampleSelect');
  const currentFileLabel = document.getElementById('currentFileLabel');
  const openFileBtn = document.getElementById('openFileBtn');
  const openFileInput = document.getElementById('openFileInput');
  const downloadFileBtn = document.getElementById('downloadFileBtn');
  const filesBtn = document.getElementById('filesBtn');
  const filesModalOverlay = document.getElementById('filesModalOverlay');
  const filesModalCloseBtn = document.getElementById('filesModalCloseBtn');
  const uploadFileBtn = document.getElementById('uploadFileBtn');
  const uploadFileInput = document.getElementById('uploadFileInput');
  const fileListEl = document.getElementById('fileList');
  const inputRow = document.getElementById('inputRow');
  const inputField = document.getElementById('inputField');
  const fabRunBtn = document.getElementById('fabRunBtn');
  const fabStopBtn = document.getElementById('fabStopBtn');
  const mobileTabEditor = document.getElementById('mobileTabEditor');
  const mobileTabOutput = document.getElementById('mobileTabOutput');
  const outputTabDot = document.getElementById('outputTabDot');
  const editorPaneEl = document.querySelector('.editor-pane');
  const outputPaneEl = document.querySelector('.output-pane');

  /* -------------------------------------------------------------------
     SHARED UI HELPERS
     ------------------------------------------------------------------- */
  function triggerDownload(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearOutput() {
    outputEl.innerHTML = '';
    const placeholder = document.createElement('span');
    placeholder.className = 'output-placeholder';
    placeholder.textContent = "Your program's output will appear here once you click Run.";
    outputEl.appendChild(placeholder);
    outputEl.appendChild(inputRow);
  }

  // Appends a raw chunk of text (not necessarily a full line) so partial
  // prompts like `input("Name? ")` show up immediately, terminal-style.
  function appendOutputText(text, cssClass) {
    if (!text) return;
    const placeholder = outputEl.querySelector('.output-placeholder');
    if (placeholder) placeholder.remove();
    const span = document.createElement('span');
    span.className = cssClass ? 'output-line ' + cssClass : 'output-line';
    span.textContent = text;
    outputEl.insertBefore(span, inputRow);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function appendOutputLine(text, cssClass) {
    appendOutputText(text + '\n', cssClass);
  }

  function setStatus(message, state) {
    statusEl.innerHTML = message;
    statusEl.className = 'runtime-status' + (state ? ' ' + state : '');
  }

  function setReadyUI() {
    runBtn.disabled = false;
    fabRunBtn.disabled = false;
    uploadFileBtn.disabled = false;
    const icon = runBtn.querySelector('i');
    const label = runBtn.querySelector('span');
    if (icon) icon.className = 'fa-solid fa-play';
    if (label) label.textContent = 'Run';
  }

  function setRunning(running) {
    isRunning = running;
    runBtn.disabled = running;
    fabRunBtn.disabled = running;
    fabRunBtn.hidden = running;
    fabStopBtn.hidden = !running;
    filesBtn.disabled = running;
    stopBtn.hidden = !running;
    outputTabDot.hidden = !running;
    const icon = runBtn.querySelector('i');
    const label = runBtn.querySelector('span');
    if (running) {
      runBtn.classList.add('running');
      if (icon) icon.className = 'fa-solid fa-circle-notch fa-spin';
      if (label) label.textContent = 'Running\u2026';
      hideInputRow();
      switchMobileTab('output'); // jump to Output so prompts/results are visible right away
    } else {
      runBtn.classList.remove('running');
      if (icon) icon.className = 'fa-solid fa-play';
      if (label) label.textContent = 'Run';
    }
  }

  /* -------------------------------------------------------------------
     MOBILE CODE/OUTPUT TABS \u2014 below ~700px wide, only one pane shows at
     a time (see compiler.css); above that both are always visible and
     these calls are harmless no-ops visually.
     ------------------------------------------------------------------- */
  function switchMobileTab(tab) {
    const showOutput = tab === 'output';
    editorPaneEl.classList.toggle('mobile-active', !showOutput);
    outputPaneEl.classList.toggle('mobile-active', showOutput);
    mobileTabEditor.classList.toggle('active', !showOutput);
    mobileTabOutput.classList.toggle('active', showOutput);
    mobileTabEditor.setAttribute('aria-selected', String(!showOutput));
    mobileTabOutput.setAttribute('aria-selected', String(showOutput));
    if (showOutput) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function initMobileTabs() {
    mobileTabEditor.addEventListener('click', () => switchMobileTab('editor'));
    mobileTabOutput.addEventListener('click', () => switchMobileTab('output'));
    fabRunBtn.addEventListener('click', runCode);
    fabStopBtn.addEventListener('click', stopCode);
  }

  function showInputRow() {
    const placeholder = outputEl.querySelector('.output-placeholder');
    if (placeholder) placeholder.remove();
    switchMobileTab('output'); // in case the student switched back to Code while it was running
    inputRow.hidden = false;
    inputField.value = '';
    inputField.disabled = false;
    inputField.focus();
    inputField.scrollIntoView({ block: 'nearest' });
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function hideInputRow() {
    inputRow.hidden = true;
  }

  function renderErrorText(errorText) {
    const cssClass = errorText.includes('TimeoutError') ? 'timeout' : 'error';
    appendOutputText(errorText.endsWith('\n') ? errorText : errorText + '\n', cssClass);
  }

  function finishRun() {
    if (!outputEl.querySelector('.output-line')) {
      appendOutputLine('(Program finished with no output.)', 'system');
    }
  }

  /* -------------------------------------------------------------------
     DATA FILES MODAL — delegates the actual filesystem work to whichever
     engine is active.
     ------------------------------------------------------------------- */
  async function refreshFileList() {
    fileListEl.innerHTML = '';
    if (!engine || !engine.isReady()) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = 'Python runtime is still loading\u2026';
      fileListEl.appendChild(li);
      return;
    }

    let names = [];
    try {
      names = await engine.listFiles();
    } catch (e) { /* ignore */ }

    if (names.length === 0) {
      const li = document.createElement('li');
      li.className = 'file-list-empty';
      li.textContent = 'No files yet \u2014 upload one, or run code that creates one.';
      fileListEl.appendChild(li);
      return;
    }

    names.sort().forEach((name) => {
      const li = document.createElement('li');
      li.className = 'file-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.innerHTML = '<i class="fa-solid fa-file-lines" aria-hidden="true"></i>';
      nameSpan.appendChild(document.createTextNode(name));

      const actions = document.createElement('span');
      actions.className = 'file-row-actions';

      const downloadBtn = document.createElement('button');
      downloadBtn.className = 'icon-btn small';
      downloadBtn.setAttribute('aria-label', 'Download ' + name);
      downloadBtn.innerHTML = '<i class="fa-solid fa-download" aria-hidden="true"></i>';
      downloadBtn.addEventListener('click', async () => {
        try {
          const data = await engine.readFile(name);
          triggerDownload(name, new Blob([data]));
        } catch (e) {
          appendOutputLine('Could not read file "' + name + '": ' + e.message, 'error');
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'icon-btn small';
      deleteBtn.setAttribute('aria-label', 'Delete ' + name);
      deleteBtn.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
        try {
          await engine.deleteFile(name);
          refreshFileList();
        } catch (e) {
          appendOutputLine('Could not delete file "' + name + '": ' + e.message, 'error');
        }
      });

      actions.appendChild(downloadBtn);
      actions.appendChild(deleteBtn);
      li.appendChild(nameSpan);
      li.appendChild(actions);
      fileListEl.appendChild(li);
    });
  }

  function initDataFilesModal() {
    filesBtn.addEventListener('click', () => {
      if (filesBtn.disabled) return;
      filesModalOverlay.hidden = false;
      refreshFileList();
    });
    filesModalCloseBtn.addEventListener('click', () => { filesModalOverlay.hidden = true; });
    filesModalOverlay.addEventListener('click', (e) => {
      if (e.target === filesModalOverlay) filesModalOverlay.hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !filesModalOverlay.hidden) filesModalOverlay.hidden = true;
    });

    uploadFileBtn.addEventListener('click', () => uploadFileInput.click());
    uploadFileInput.addEventListener('change', async () => {
      const files = Array.from(uploadFileInput.files || []);
      for (const file of files) {
        try {
          const buffer = await file.arrayBuffer();
          await engine.writeFile(file.name, new Uint8Array(buffer));
        } catch (e) {
          appendOutputLine('Could not upload "' + file.name + '": ' + e.message, 'error');
        }
      }
      uploadFileInput.value = '';
      refreshFileList();
    });
  }

  /* -------------------------------------------------------------------
     OPEN / DOWNLOAD .py FILES
     ------------------------------------------------------------------- */
  function initFileIO() {
    openFileBtn.addEventListener('click', () => openFileInput.click());

    openFileInput.addEventListener('change', async () => {
      const file = openFileInput.files && openFileInput.files[0];
      if (!file) return;
      const text = await file.text();
      editor.setValue(text);
      currentFileName = file.name;
      currentFileLabel.textContent = currentFileName;
      clearOutput();
      openFileInput.value = '';
    });

    downloadFileBtn.addEventListener('click', () => {
      const blob = new Blob([editor.getValue()], { type: 'text/x-python' });
      triggerDownload(currentFileName || 'main.py', blob);
    });
  }

  /* -------------------------------------------------------------------
     ENGINE: WORKER (preferred) — real inline console input.
     ------------------------------------------------------------------- */
  function createWorkerEngine() {
    const worker = new Worker('assets/js/compiler-worker.js');
    const sab = new SharedArrayBuffer(8 + STDIN_CAPACITY);
    const stdinInt32 = new Int32Array(sab, 0, 2);
    const stdinBytes = new Uint8Array(sab, 8);

    let ready = false;
    let nextId = 1;
    const pending = new Map(); // id -> {resolve, reject}
    let readyResolve, readyReject;
    const readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

    function nextRequestId() { return nextId++; }

    function submitInput(text) {
      const bytes = new TextEncoder().encode(text + '\n');
      const n = Math.min(bytes.length, STDIN_CAPACITY);
      stdinBytes.set(bytes.subarray(0, n));
      Atomics.store(stdinInt32, 1, n);
      Atomics.store(stdinInt32, 0, STATE_READY);
      Atomics.notify(stdinInt32, 0);
    }

    worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          ready = true;
          readyResolve();
          break;
        case 'init_error':
          readyReject(new Error(msg.message));
          break;
        case 'stdout':
          appendOutputText(msg.text);
          break;
        case 'stderr':
          appendOutputText(msg.text, 'stderr');
          break;
        case 'input_request':
          showInputRow();
          break;
        case 'run_result': {
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); p.resolve(msg.error); }
          break;
        }
        case 'fs_list_result':
        case 'fs_read_result':
        case 'fs_write_result':
        case 'fs_delete_result': {
          const p = pending.get(msg.id);
          if (!p) break;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg);
          break;
        }
        case 'worker_error':
          appendOutputLine('Unexpected worker error: ' + msg.message, 'error');
          break;
      }
    };

    worker.onerror = (e) => {
      readyReject(new Error(e.message || 'The Python worker crashed.'));
    };

    worker.postMessage({ type: 'init', sab });

    inputField.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const text = inputField.value;
      appendOutputText(text + '\n', 'echoed-input');
      inputField.disabled = true;
      hideInputRow();
      submitInput(text);
    };

    return {
      isReady: () => ready,
      waitUntilReady: () => readyPromise,
      async run(code) {
        const id = nextRequestId();
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ type: 'run', id, code });
        return promise;
      },
      async listFiles() {
        const id = nextRequestId();
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ type: 'fs_list', id });
        const res = await promise;
        return res.names;
      },
      async readFile(name) {
        const id = nextRequestId();
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ type: 'fs_read', id, name });
        const res = await promise;
        return res.data;
      },
      async writeFile(name, bytes) {
        const id = nextRequestId();
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ type: 'fs_write', id, name, data: bytes });
        return promise;
      },
      async deleteFile(name) {
        const id = nextRequestId();
        const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        worker.postMessage({ type: 'fs_delete', id, name });
        return promise;
      },
      stop() {
        worker.terminate();
      }
    };
  }

  /* -------------------------------------------------------------------
     ENGINE: MAIN THREAD (fallback) — window.prompt()-based input, used
     only when SharedArrayBuffer / cross-origin isolation isn't available.
     ------------------------------------------------------------------- */
  function createMainThreadEngine() {
    let pyodide = null;
    let ready = false;

    const PY_SETUP = `
import sys, time, traceback, builtins

_timeout_seconds = ${MAIN_THREAD_TIMEOUT_SECONDS}
_deadline = None

def _watchdog(frame, event, arg):
    if event == 'line' and time.time() > _deadline:
        raise TimeoutError(
            "Your code took too long to run (over " + str(_timeout_seconds) +
            "s) and was stopped automatically \\u2014 check for an infinite loop."
        )
    return _watchdog

def _browser_input(prompt=""):
    global _deadline
    import js
    result = js.prompt(str(prompt))
    _deadline = time.time() + _timeout_seconds
    if result is None:
        raise EOFError("EOF when reading a line")
    return result

builtins.input = _browser_input

_real_sleep = time.sleep
def _capped_sleep(seconds):
    _real_sleep(min(seconds, 5))
time.sleep = _capped_sleep

def _run_user_code(code, g, seconds=${MAIN_THREAD_TIMEOUT_SECONDS}):
    global _deadline, _timeout_seconds
    _timeout_seconds = seconds
    _deadline = time.time() + seconds
    g["__name__"] = "__main__"
    sys.settrace(_watchdog)
    try:
        exec(compile(code, "main.py", "exec"), g)
        return None
    except BaseException as e:
        tb = e.__traceback__
        if tb is not None:
            tb = tb.tb_next
        return "".join(traceback.format_exception(type(e), e, tb))
    finally:
        sys.settrace(None)
`;

    function fsPath(name) { return PYODIDE_HOME + '/' + name; }

    return {
      isReady: () => ready,
      async waitUntilReady() {
        pyodide = await loadPyodide();
        pyodide.setStdout({ write: (buf) => { appendOutputText(new TextDecoder().decode(buf)); return buf.length; } });
        pyodide.setStderr({ write: (buf) => { appendOutputText(new TextDecoder().decode(buf), 'stderr'); return buf.length; } });
        await pyodide.runPythonAsync(PY_SETUP);
        try { pyodide.FS.mkdirTree(PYODIDE_HOME); } catch (e) { /* exists */ }
        ready = true;
      },
      async run(code) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        let freshGlobals = null;
        let runFn = null;
        try {
          freshGlobals = pyodide.toPy({});
          runFn = pyodide.globals.get('_run_user_code');
          return runFn(code, freshGlobals, MAIN_THREAD_TIMEOUT_SECONDS);
        } finally {
          if (runFn) runFn.destroy();
          if (freshGlobals) freshGlobals.destroy();
        }
      },
      async listFiles() {
        return pyodide.FS.readdir(PYODIDE_HOME).filter((n) => n !== '.' && n !== '..');
      },
      async readFile(name) {
        return pyodide.FS.readFile(fsPath(name));
      },
      async writeFile(name, bytes) {
        pyodide.FS.writeFile(fsPath(name), bytes);
      },
      async deleteFile(name) {
        pyodide.FS.unlink(fsPath(name));
      },
      stop() {
        // No safe way to interrupt synchronous main-thread execution;
        // the settrace watchdog above is this engine's only safety net.
      }
    };
  }

  function supportsWorkerEngine() {
    return typeof SharedArrayBuffer !== 'undefined' &&
      typeof Atomics !== 'undefined' &&
      typeof Worker !== 'undefined' &&
      window.crossOriginIsolated === true;
  }

  /* -------------------------------------------------------------------
     RUN / STOP
     ------------------------------------------------------------------- */
  async function runCode() {
    if (isRunning || !engine || !engine.isReady()) return;
    const code = editor.getValue();
    clearOutput();
    setRunning(true);

    try {
      const errorText = await engine.run(code);
      if (errorText) renderErrorText(errorText);
      finishRun();
    } catch (err) {
      appendOutputLine('Unexpected runtime error: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      setRunning(false);
      refreshFileList();
    }
  }

  function stopCode() {
    if (!isRunning || !engine) return;
    engine.stop();
    hideInputRow();
    appendOutputLine('\u23f9 Execution stopped by user.', 'system');
    setRunning(false);
    setStatus('<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> Restarting Python runtime\u2026');
    runBtn.disabled = true;
    fabRunBtn.disabled = true;
    uploadFileBtn.disabled = true;
    initEngine();
  }

  /* -------------------------------------------------------------------
     ENGINE BOOTSTRAP
     ------------------------------------------------------------------- */
  async function initEngine() {
    const usingWorker = supportsWorkerEngine();
    engine = usingWorker ? createWorkerEngine() : createMainThreadEngine();

    try {
      await engine.waitUntilReady();
      setStatus(
        usingWorker
          ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Python ready'
          : '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Python ready (popup input mode)',
        'ready'
      );
      setReadyUI();
      refreshFileList();
    } catch (err) {
      setStatus('<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Failed to load Python runtime', 'error');
      appendOutputLine('The Python runtime could not be loaded. Check your internet connection and reload this page.', 'error');
      console.error(err);
    }
  }

  /* -------------------------------------------------------------------
     EDITOR / EXAMPLES / THEME
     ------------------------------------------------------------------- */
  function initEditor() {
    editor = CodeMirror(document.getElementById('editor'), {
      value: DEFAULT_CODE,
      mode: 'python',
      theme: 'dracula',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      matchBrackets: true,
      styleActiveLine: true,
      viewportMargin: Infinity,
      extraKeys: {
        'Ctrl-Enter': runCode,
        'Cmd-Enter': runCode,
        'Tab': function (cm) {
          cm.replaceSelection('    ', 'end');
        }
      }
    });

    // Mobile keyboards otherwise "helpfully" auto-capitalize and
    // autocorrect Python code, which mangles it.
    const cmInput = editor.getInputField();
    if (cmInput) {
      cmInput.setAttribute('autocorrect', 'off');
      cmInput.setAttribute('autocapitalize', 'off');
      cmInput.setAttribute('autocomplete', 'off');
      cmInput.setAttribute('spellcheck', 'false');
    }
  }

  function populateExamples() {
    Object.keys(EXAMPLES).forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = EXAMPLES[key].label;
      exampleSelect.appendChild(opt);
    });
    exampleSelect.addEventListener('change', () => {
      const key = exampleSelect.value;
      if (key && EXAMPLES[key]) {
        editor.setValue(EXAMPLES[key].code);
        currentFileName = 'main.py';
        currentFileLabel.textContent = currentFileName;
        clearOutput();
      }
      exampleSelect.value = '';
    });
  }

  function initTheme() {
    const root = document.documentElement;
    const toggleBtn = document.getElementById('darkModeToggle');
    let stored = null;
    try { stored = localStorage.getItem('ptheme'); } catch (e) { /* ignore */ }
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try { localStorage.setItem('ptheme', next); } catch (e) { /* ignore */ }
      });
    }

    function applyTheme(mode) {
      root.setAttribute('data-theme', mode);
      if (toggleBtn) {
        const icon = toggleBtn.querySelector('i');
        if (icon) icon.className = mode === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      }
      if (editor) editor.setOption('theme', mode === 'dark' ? 'dracula' : 'default');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initEditor();
    populateExamples();
    initFileIO();
    initDataFilesModal();
    initMobileTabs();
    initEngine();

    runBtn.addEventListener('click', runCode);
    stopBtn.addEventListener('click', stopCode);
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset the editor back to the starter example? Your current code will be lost.')) {
        editor.setValue(DEFAULT_CODE);
        currentFileName = 'main.py';
        currentFileLabel.textContent = currentFileName;
        clearOutput();
      }
    });
    clearOutputBtn.addEventListener('click', clearOutput);
  });
})();
