/* =====================================================================
   PYTHON COMPILER — WORKER
   Runs Pyodide off the main thread so a stuck script never freezes the
   page, and so input() can genuinely block (via Atomics.wait on a
   SharedArrayBuffer) while the student types into the on-page console —
   the same experience as a real terminal, no native prompt() popup.
   ===================================================================== */

importScripts('https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.js');

const PYODIDE_HOME = '/home/pyodide';
const MAX_RUN_SECONDS = 20;
const STATE_IDLE = 0;
const STATE_WAITING = 1;
const STATE_READY = 2;

let pyodide = null;
let stdinInt32 = null;
let stdinBytes = null;
let pendingInputBytes = null;
let pendingInputOffset = 0;

const stdoutDecoder = new TextDecoder('utf-8');
const stderrDecoder = new TextDecoder('utf-8');

/* -------------------------------------------------------------------
   Same watchdog idea as before: an automatic safety net in case a loop
   runs away and the student doesn't notice/click Stop. Runs off the
   main thread now, so it's a courtesy, not a necessity.
   ------------------------------------------------------------------- */
const PY_SETUP = `
import sys, time, traceback

_timeout_seconds = ${MAX_RUN_SECONDS}
_deadline = None

def _watchdog(frame, event, arg):
    if event == 'line' and time.time() > _deadline:
        raise TimeoutError(
            "Your code took too long to run (over " + str(_timeout_seconds) +
            "s) and was stopped automatically \\u2014 check for an infinite loop."
        )
    return _watchdog

_real_sleep = time.sleep
def _capped_sleep(seconds):
    _real_sleep(min(seconds, 5))
time.sleep = _capped_sleep

def _run_user_code(code, g, seconds=${MAX_RUN_SECONDS}):
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
            tb = tb.tb_next  # hide this wrapper's own frame from the student
        return "".join(traceback.format_exception(type(e), e, tb))
    finally:
        sys.settrace(None)
`;

/* -------------------------------------------------------------------
   Raw stdin: called by CPython whenever it needs more bytes. Serves
   from a locally-buffered chunk first; once that's exhausted, blocks
   the *worker thread only* (main thread stays fully responsive) until
   the main thread writes a line into the shared buffer and notifies.
   ------------------------------------------------------------------- */
function readStdin(buf) {
  if (pendingInputBytes && pendingInputOffset < pendingInputBytes.length) {
    const remaining = pendingInputBytes.length - pendingInputOffset;
    const n = Math.min(buf.length, remaining);
    buf.set(pendingInputBytes.subarray(pendingInputOffset, pendingInputOffset + n));
    pendingInputOffset += n;
    return n;
  }

  postMessage({ type: 'input_request' });
  Atomics.store(stdinInt32, 0, STATE_WAITING);
  Atomics.wait(stdinInt32, 0, STATE_WAITING); // blocks this thread only; Stop = worker.terminate()

  const state = Atomics.load(stdinInt32, 0);
  const byteLen = Atomics.load(stdinInt32, 1);
  Atomics.store(stdinInt32, 0, STATE_IDLE);

  if (state !== STATE_READY || byteLen <= 0) return 0; // EOF

  pendingInputBytes = stdinBytes.slice(0, byteLen);
  pendingInputOffset = 0;

  const n = Math.min(buf.length, pendingInputBytes.length);
  buf.set(pendingInputBytes.subarray(0, n));
  pendingInputOffset = n;
  return n;
}

function postStream(kind, buf) {
  const decoder = kind === 'stdout' ? stdoutDecoder : stderrDecoder;
  const text = decoder.decode(buf, { stream: true });
  if (text.length) postMessage({ type: kind, text });
}

function fsPath(name) { return PYODIDE_HOME + '/' + name; }

async function init(sab) {
  stdinInt32 = new Int32Array(sab, 0, 2);
  stdinBytes = new Uint8Array(sab, 8);

  pyodide = await loadPyodide();
  pyodide.setStdout({ write: (buf) => { postStream('stdout', buf); return buf.length; } });
  pyodide.setStderr({ write: (buf) => { postStream('stderr', buf); return buf.length; } });
  pyodide.setStdin({ read: readStdin, isatty: false });
  await pyodide.runPythonAsync(PY_SETUP);
  try { pyodide.FS.mkdirTree(PYODIDE_HOME); } catch (e) { /* already exists */ }

  postMessage({ type: 'ready' });
}

async function runCode(id, code) {
  let freshGlobals = null;
  let runFn = null;
  try {
    freshGlobals = pyodide.toPy({});
    runFn = pyodide.globals.get('_run_user_code');
    const errorText = runFn(code, freshGlobals, MAX_RUN_SECONDS);
    postMessage({ type: 'run_result', id, error: errorText || null });
  } catch (err) {
    postMessage({ type: 'run_result', id, error: 'Unexpected runtime error: ' + (err && err.message ? err.message : String(err)) });
  } finally {
    if (runFn) runFn.destroy();
    if (freshGlobals) freshGlobals.destroy();
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        try {
          await init(msg.sab);
        } catch (err) {
          postMessage({ type: 'init_error', message: err && err.message ? err.message : String(err) });
        }
        break;

      case 'run':
        runCode(msg.id, msg.code);
        break;

      case 'fs_list':
        try {
          const names = pyodide.FS.readdir(PYODIDE_HOME).filter((n) => n !== '.' && n !== '..');
          postMessage({ type: 'fs_list_result', id: msg.id, names });
        } catch (err) {
          postMessage({ type: 'fs_list_result', id: msg.id, error: err.message });
        }
        break;

      case 'fs_read':
        try {
          const data = pyodide.FS.readFile(fsPath(msg.name));
          postMessage({ type: 'fs_read_result', id: msg.id, data });
        } catch (err) {
          postMessage({ type: 'fs_read_result', id: msg.id, error: err.message });
        }
        break;

      case 'fs_write':
        try {
          pyodide.FS.writeFile(fsPath(msg.name), new Uint8Array(msg.data));
          postMessage({ type: 'fs_write_result', id: msg.id, ok: true });
        } catch (err) {
          postMessage({ type: 'fs_write_result', id: msg.id, error: err.message });
        }
        break;

      case 'fs_delete':
        try {
          pyodide.FS.unlink(fsPath(msg.name));
          postMessage({ type: 'fs_delete_result', id: msg.id, ok: true });
        } catch (err) {
          postMessage({ type: 'fs_delete_result', id: msg.id, error: err.message });
        }
        break;
    }
  } catch (err) {
    postMessage({ type: 'worker_error', message: err && err.message ? err.message : String(err) });
  }
};
