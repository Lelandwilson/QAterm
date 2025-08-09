// Minimal TUI for QAterm using raw ANSI control sequences (no extra deps)
// Features: file browser (left), file preview (right), simple search (/), open, quit
import fs from 'fs';
import path from 'path';
import os from 'os';

function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
function hideCursor() { process.stdout.write('\x1b[?25l'); }
function showCursor() { process.stdout.write('\x1b[?25h'); }
function move(y, x) { process.stdout.write(`\x1b[${y};${x}H`); }
function color(txt, c) { return `\x1b[${c}m${txt}\x1b[0m`; }

function truncate(str, width) {
  if (str.length <= width) return str;
  if (width <= 1) return str.slice(0, width);
  return str.slice(0, width - 1) + '…';
}

function wrapText(text, width) {
  const out = [];
  const lines = Array.isArray(text) ? text : String(text).split(/\r?\n/);
  for (const line of lines) {
    let s = String(line);
    if (width <= 1) { out.push(s.slice(0, width)); continue; }
    while (s.length > width) {
      out.push(s.slice(0, width));
      s = s.slice(width);
    }
    out.push(s);
  }
  return out;
}

function humanPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// Convert a simple glob pattern to RegExp (supports * and ?)
function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|\[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$');
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.git'))
      .map(d => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  } catch { return []; }
}

function readPreview(p, maxLines = 200) {
  try {
    const data = fs.readFileSync(p, 'utf8');
    return data.split(/\r?\n/).slice(0, maxLines);
  } catch (e) {
    return [e.message];
  }
}

function buildNode(p) {
  const name = path.basename(p) || p;
  const isDir = (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })();
  return { path: p, name, isDir, expanded: false, children: null };
}

function loadChildren(node) {
  if (!node.isDir) return;
  const items = listDir(node.path);
  node.children = items.map(it => buildNode(path.join(node.path, it.name)));
}

function flattenTree(node, depth = 0, out = []) {
  out.push({ node, depth });
  if (node.isDir && node.expanded && node.children) {
    for (const ch of node.children) flattenTree(ch, depth + 1, out);
  }
  return out;
}

async function startTui(baseDir, options = {}) {
  const onAction = options.onAction || null;
  const threePaneDefault = !!options.threePane;
  const getChatLines = typeof options.getChatLines === 'function' ? options.getChatLines : (()=>[]);
  const onAsk = typeof options.onAsk === 'function' ? options.onAsk : null;
  const autoScan = !!options.autoScan;
  const onToggleAutoScan = typeof options.onToggleAutoScan === 'function' ? options.onToggleAutoScan : null;
  let rootPath = path.resolve(baseDir || process.cwd());
  const root = buildNode(rootPath);
  loadChildren(root);
  root.expanded = true;
  let flat = flattenTree(root);
  let idx = 0;
  let scroll = 0;
  let mode = 'browse'; // 'browse' | 'search'
  let searchQuery = '';
  let results = []; // {path, line, text}
  let resultIdx = 0;
  let finderMode = false;
  let finderQuery = '';
  let finderItems = []; // list of {path, name}
  let finderSel = 0;
  let finderFiltered = [];
  // Search multi-select
  let selectedResults = new Set(); // store indices in results array
  // Pinned tabs
  let pinned = []; // array of file paths
  let pinnedIdx = 0;
  let pinPreview = false;
  // Focus and scroll state for tri-pane mode
  let focus = 'files'; // 'files' | 'chat' | 'preview'
  let chatScroll = 0;
  let previewScroll = 0;
  // Toast state
  let toast = '';
  let toastUntil = 0;

  function showToast(msg, durationMs = 1500) {
    toast = msg;
    toastUntil = Date.now() + durationMs;
    render();
    setTimeout(() => {
      if (Date.now() >= toastUntil) {
        toast = '';
        render();
      }
    }, durationMs + 10);
  }

  let threePane = threePaneDefault;
  const render = () => {
    const rows = process.stdout.rows || 30;
    const cols = process.stdout.columns || 100;
    const leftW = Math.max(24, Math.floor(cols * (threePane ? 0.28 : 0.35)));
    const midW = threePane ? Math.max(28, Math.floor(cols * 0.34)) : 0;
    const rightW = cols - leftW - (threePane ? midW + 4 : 3);
    clear();
    const title = ` QAterm TUI — ${humanPath(rootPath)} `;
    process.stdout.write(color(title.padEnd(cols), '44;37'));

    // Left panel header
    move(2, 1);
    const header = (mode === 'browse' ? 'Files' : `Search: ${searchQuery}`);
    let pins = '';
    if (pinned.length) {
      const names = pinned.map((p,i)=> (i===pinnedIdx? '['+path.basename(p)+']' : path.basename(p))).join(' | ');
      pins = `  Tabs: ${names}`;
    }
    const leftHdrStyle = (focus === 'files') ? '7' : '1';
    process.stdout.write(color(truncate(header + pins, leftW).padEnd(leftW), leftHdrStyle));

    // Left list
    const listArea = rows - 4; // header + footer lines
    if (finderMode) {
      // Build items at first render or on query change
      if (!finderItems.length) {
        const collect = (n, arr=[]) => { if (n.isDir && n.children){ n.children.forEach(c=>collect(c,arr)); } arr.push({ path: n.path, name: n.name, isDir: n.isDir }); return arr; };
        finderItems = collect(root, []).filter(it => !it.isDir);
      }
      // fuzzy rank
      finderFiltered = rankFuzzy(finderItems, finderQuery);
      if (finderSel >= finderFiltered.length) finderSel = Math.max(0, finderFiltered.length -1);
      for (let i=0;i<listArea;i++){
        const row=i+3; move(row,1);
        const it=finderFiltered[i+scroll];
        if(!it){ process.stdout.write(' '.repeat(leftW)); continue; }
        const line = renderFuzzyHighlight(it.name, it.matches);
        const sel=(i+scroll)===finderSel;
        process.stdout.write((sel?color(truncate(line,leftW).padEnd(leftW),'7'):truncate(line,leftW).padEnd(leftW)));
      }
    } else if (mode === 'browse') {
      flat = flattenTree(root);
      if (idx < 0) idx = 0;
      if (idx >= flat.length) idx = flat.length - 1;
      if (idx < scroll) scroll = idx;
      if (idx >= scroll + listArea) scroll = idx - listArea + 1;
      for (let i = 0; i < listArea; i++) {
        const row = i + 3;
        const item = flat[i + scroll];
        move(row, 1);
        if (!item) { process.stdout.write(' '.repeat(leftW)); continue; }
        const { node, depth } = item;
        const prefix = node.isDir ? (node.expanded ? '▾ ' : '▸ ') : '  ';
        const name = node.name + (node.isDir ? '/' : '');
        const line = ' '.repeat(depth * 2) + prefix + name;
        const sel = (i + scroll) === idx;
        const out = truncate(line, leftW);
        process.stdout.write((sel ? color(out.padEnd(leftW), '7') : out.padEnd(leftW)));
      }
    } else {
      if (resultIdx < 0) resultIdx = 0;
      if (resultIdx >= results.length) resultIdx = results.length - 1;
      if (resultIdx < scroll) scroll = resultIdx;
      if (resultIdx >= scroll + listArea) scroll = resultIdx - listArea + 1;
      for (let i = 0; i < listArea; i++) {
        const row = i + 3;
        const r = results[i + scroll];
        move(row, 1);
        if (!r) { process.stdout.write(' '.repeat(leftW)); continue; }
        const label = `${humanPath(r.path)}:${r.line}`;
        const text = truncate(label + ' ' + r.text.trim(), leftW);
        const sel = (i + scroll) === resultIdx;
        const mark = selectedResults.has(i+scroll) ? '*' : ' ';
        const line = mark + ' ' + text;
        process.stdout.write((sel ? color(truncate(line,leftW).padEnd(leftW), '7') : truncate(line,leftW).padEnd(leftW)));
      }
    }

    // Three-pane headers: Preview (middle) + Chat (right)
    if (threePane) {
      move(2, leftW + 3);
      const prevHdrStyle = (focus === 'preview') ? '7' : '1';
      process.stdout.write(color(truncate('Preview', midW).padEnd(midW), prevHdrStyle));
      move(2, leftW + midW + 4);
      const chatHdrStyle = (focus === 'chat') ? '7' : '1';
      process.stdout.write(color(truncate('Chat', rightW).padEnd(rightW), chatHdrStyle));
    }

    // Right preview
    const selectedPath = pinPreview && pinned.length
      ? pinned[pinnedIdx]
      : finderMode
      ? (finderFiltered.length ? finderFiltered[finderSel]?.path : null)
      : (mode === 'browse'
        ? (flat[idx]?.node?.path)
        : (results[resultIdx]?.path));
    const isDir = selectedPath ? (() => { try { return fs.statSync(selectedPath).isDirectory(); } catch { return false; } })() : false;
    let preview = (!selectedPath || isDir) ? [`${selectedPath || ''}`] : readPreview(selectedPath, 1000);
    // Simple colorized preview for JSON/MD/JS
    if (selectedPath && !isDir) {
      if (/\.json$/i.test(selectedPath)) {
        preview = preview.map(l => l
          .replace(/(".*?"\s*:)/g, (m)=>color(m,'36')) // keys
          .replace(/(:\s*".*?")/g, (m)=>color(m,'32')) // string values
          .replace(/(:\s*\b\d+\b)/g, (m)=>color(m,'33')) // numbers
        );
      } else if (/\.(md|markdown)$/i.test(selectedPath)) {
        preview = preview.map(l => l.replace(/^(#+\s.*)/, (m)=>color(m,'35')));
      } else if (/\.(js|ts|tsx|jsx|py)$/i.test(selectedPath)) {
        preview = preview.map(l => l
          .replace(/\b(function|const|let|var|return|if|else|for|while|class|def|import|from|as|await|async|try|except|finally)\b/g, (m)=>color(m,'36'))
          .replace(/(".*?"|'.*?')/g, (m)=>color(m,'32'))
        );
      }
    }
    // Render Preview (middle in 3-pane, right otherwise) with wrapping
    const prevPanelX = leftW + 3;
    const prevPanelW = threePane ? midW : rightW;
    const wrappedPreview = wrapText(preview, prevPanelW);
    const pOverflow = Math.max(0, wrappedPreview.length - listArea);
    if (previewScroll > pOverflow) previewScroll = pOverflow;
    if (previewScroll < 0) previewScroll = 0;
    for (let i = 0; i < listArea; i++) {
      const row = i + 3;
      move(row, prevPanelX);
      const line = wrappedPreview[i + previewScroll] || '';
      process.stdout.write(truncate(line, prevPanelW).padEnd(prevPanelW));
    }

    // Render Chat on the right (only in 3-pane) with wrapping
    if (threePane) {
      const area = rows - 4;
      const chat = getChatLines() || [];
      const wrapped = wrapText(chat, rightW);
      const cOverflow = Math.max(0, wrapped.length - area);
      if (chatScroll > cOverflow) chatScroll = cOverflow;
      if (chatScroll < 0) chatScroll = 0;
      const start = Math.max(0, wrapped.length - area - chatScroll);
      for (let i = 0; i < area; i++) {
        const row = i + 3;
        move(row, leftW + midW + 4);
        const line = wrapped[start + i] || '';
        process.stdout.write(truncate(line, rightW).padEnd(rightW));
      }
    }

    // Status line (focus + cwd + auto-scan)
    move(rows - 1, 1);
    const fFiles = focus === 'files' ? color('[Files*]', '7') : '[Files]';
    const fPrev  = focus === 'preview' ? color('[Preview*]', '7') : '[Preview]';
    const fChat  = threePane ? (focus === 'chat'  ? color('[Chat*]',  '7') : '[Chat]') : '';
    const statusLeft = ` Focus: ${fFiles} ${fPrev}${threePane ? ' ' + fChat : ''}`;
    const statusRight = ` CWD: ${humanPath(rootPath)}  |  Auto-scan: ${autoScan ? 'On' : 'Off'} `;
    const status = truncate(statusLeft + '  |  ' + statusRight, cols).padEnd(cols);
    process.stdout.write(color(status, '100;37'));

    // Footer / help
    move(rows, 1);
    const help = finderMode
      ? '[↑/↓] Move  [Type] Filter  [Enter] Jump  [Esc] Cancel  [q] Quit'
      : '[Tab] Cycle Focus  [↑/↓] Move/Scroll  [PgUp/PgDn] Page  [←/→] Expand  [Enter] Open  [/] Grep  [g] Grep+  [f] Fuzzy  [:] Cmd  [r] Rename  [m] Mkdir  [i] New file  [d] Delete  [n/N] Next/Prev  [Space] Select  [E] Edit  [O] Open Sel  [o] Open OS  [t] Pin  [P] Pin Prev  [ [ / ] ] Switch Tab  [x] Unpin  [s] Set CWD  [a] Ask AI  [A] Fix AI  [V] 3‑Pane  [C] Chat  [S] Auto‑scan  [q] Quit';
    const helpLine = color(truncate(help, cols).padEnd(cols), '100;30');
    const toastActive = toast && Date.now() < toastUntil;
    const toastText = toastActive ? ` ${toast} ` : '';
    process.stdout.write(helpLine);
    if (toastActive) {
      move(rows, Math.max(1, cols - Math.min(cols - 2, toastText.length)));
      process.stdout.write(color(truncate(toastText, cols - 2), '103;30'));
    }
  };

  let onData;
  const cleanup = () => {
    process.stdin.off('data', onData);
    showCursor();
    clear();
  };

  const enterLinePrompt = async (label='Input') => {
    // inline mini-prompt
    const rows = process.stdout.rows || 30;
    const cols = process.stdout.columns || 100;
    move(rows, 1); process.stdout.write(' '.repeat(cols));
    move(rows, 1); process.stdout.write(label+': ');
    let q = '';
    return new Promise(resolve => {
      // Temporarily detach main handler
      process.stdin.off('data', onData);
      const handler = (b) => {
        const s = b.toString('utf8');
        if (s === '\u0003' || s === '\u001b') { // Ctrl+C or Esc
          process.stdin.off('data', handler);
          process.stdin.on('data', onData);
          resolve(null);
          return;
        }
        if (s === '\r' || s === '\n') { process.stdin.off('data', handler); process.stdin.on('data', onData); resolve(q.trim()); return; }
        if (s === '\u0008' || s === '\u007f') { q = q.slice(0, -1); }
        else if (s >= ' ') { q += s; }
        move(rows, label.length+3); process.stdout.write(truncate(q, cols - (label.length+2)).padEnd(cols - (label.length+2)));
      };
      process.stdin.on('data', handler);
    });
  };

  const enterPromptAt = async (y, x, width, label='Input') => {
    // Draw a prompt in-place at specific coordinates and capture input
    move(y, x); process.stdout.write(' '.repeat(width));
    move(y, x); process.stdout.write(label+': ');
    let q = '';
    const max = Math.max(4, width - (label.length + 2));
    return new Promise(resolve => {
      // Temporarily detach main handler
      process.stdin.off('data', onData);
      const handler = (b) => {
        const s = b.toString('utf8');
        if (s === '\u0003' || s === '\u001b') { // Ctrl+C or Esc
          process.stdin.off('data', handler);
          process.stdin.on('data', onData);
          resolve(null);
          return;
        }
        if (s === '\r' || s === '\n') {
          process.stdin.off('data', handler);
          process.stdin.on('data', onData);
          resolve(q.trim());
          return;
        }
        if (s === '\u0008' || s === '\u007f') { q = q.slice(0, -1); }
        else if (s >= ' ') { q += s; }
        move(y, x + label.length + 2);
        process.stdout.write(truncate(q, max).padEnd(max));
      };
      process.stdin.on('data', handler);
    });
  };

  const doSearch = (q, opts={}) => {
    results = [];
    if (!q) return;
    const allFiles = [];
    const walk = (p) => {
      let st; try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) {
        let items = []; try { items = fs.readdirSync(p); } catch { items = []; }
        for (const it of items) {
          const fp = path.join(p, it);
          if (it === '.git') continue;
          if (it === 'node_modules') continue;
          walk(fp);
        }
      } else {
        allFiles.push(p);
      }
    };
    walk(rootPath);
    const includeRe = opts.include ? globToRegex(opts.include) : null;
    const excludeRe = opts.exclude ? globToRegex(opts.exclude) : null;
    const needle = opts.regex ? new RegExp(q, opts.caseSensitive? '' : 'i') : null;
    for (const f of allFiles) {
      const fn = path.basename(f);
      if (includeRe && !includeRe.test(fn)) continue;
      if (excludeRe && excludeRe.test(fn)) continue;
      let content; try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const lines = content.split(/\r?\n/);
      lines.forEach((ln, i) => {
        const hay = opts.caseSensitive ? ln : ln.toLowerCase();
        const qv = opts.caseSensitive ? q : q.toLowerCase();
        const match = needle ? needle.test(ln) : hay.includes(qv);
        if (match) results.push({ path: f, line: i + 1, text: ln });
      });
    }
    resultIdx = 0; scroll = 0; mode = 'search'; searchQuery = q;
  };

  // Fuzzy rank and highlight helpers
  function rankFuzzy(items, query) {
    if (!query) return items.map(it => ({ ...it, score: 0, matches: [] }));
    const q = query.toLowerCase();
    const ranked = [];
    for (const it of items) {
      const name = it.name.toLowerCase();
      let qi = 0; const idxs = [];
      for (let i=0;i<name.length && qi<q.length;i++) {
        if (name[i] === q[qi]) { idxs.push(i); qi++; }
      }
      if (qi < q.length) continue; // not all matched in order
      // score: prefer consecutive and early matches
      let score = 1000 - (idxs[idxs.length-1] - idxs[0]) - idxs[0];
      ranked.push({ ...it, score, matches: idxs });
    }
    ranked.sort((a,b)=> b.score - a.score);
    return ranked;
  }
  function renderFuzzyHighlight(name, idxs) {
    if (!idxs || !idxs.length) return name;
    let out = '';
    for (let i=0;i<name.length;i++) {
      const ch = name[i];
      out += idxs.includes(i) ? color(ch, '33') : ch; // yellow highlight
    }
    return out;
  }

  return new Promise((resolve) => {
    const prevRaw = process.stdin.isRaw;
    let sigintGuard = () => {};
    try { if (process.stdin.isTTY) process.stdin.setRawMode(true); } catch {}
    try { process.stdin.resume(); } catch {}
    // Guard SIGINT so Ctrl+C inside TUI doesn't kill parent app
    process.prependListener('SIGINT', sigintGuard);
    hideCursor();
    render();
    onData = async (buf) => {
      const s = buf.toString('utf8');
      if (s === '\u0003') { // Ctrl+C
        cleanup();
        try { process.removeListener('SIGINT', sigintGuard); } catch {}
        try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw); } catch {}
        resolve(); return;
      }
      if (s === 'q') { 
        cleanup(); 
        try { process.removeListener('SIGINT', sigintGuard); } catch {}
        try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw); } catch {}
        resolve({ type: 'quit' }); return; 
      }
      if (finderMode) {
        if (s === '\u001b') { finderMode=false; finderQuery=''; finderItems=[]; render(); return; }
        if (s === '\u001b[A') { finderSel=Math.max(0,finderSel-1); render(); return; }
        if (s === '\u001b[B') { const filtered = finderQuery? finderItems.filter(it=>it.name.toLowerCase().includes(finderQuery.toLowerCase())):finderItems; finderSel=Math.min((filtered.length-1),finderSel+1); render(); return; }
        if (s === '\r' || s==='\n') {
          const filtered = finderQuery? finderItems.filter(it=>it.name.toLowerCase().includes(finderQuery.toLowerCase())):finderItems;
          const sel = filtered[finderSel];
          if (sel) {
            // Jump to this file in tree
            // Expand path accordingly
            const parts = sel.path.split(path.sep);
            let cur = root;
            cur.expanded = true; loadChildren(cur);
            let accum = parts[0] === '' ? path.sep : parts[0];
            for (let i=1;i<parts.length;i++){
              const seg = parts[i];
              accum = path.join(accum, seg);
              const child = (cur.children||[]).find(n=>n.name===seg);
              if (child) {
                if (child.isDir){ child.expanded = true; loadChildren(child); }
                cur = child;
              }
            }
            flat = flattenTree(root);
            const pos = flat.findIndex(e=>e.node.path===sel.path);
            if (pos>=0) idx=pos;
          }
          finderMode=false; finderQuery=''; finderItems=[]; render(); return;
        }
        // Type to filter
        if (s === '\u0008' || s === '\u007f') { finderQuery = finderQuery.slice(0,-1); render(); return; }
        if (s >= ' ') { finderQuery += s; render(); return; }
        return;
      }
      if (s === '\t') { // Tab: cycle focus
        focus = (focus === 'files') ? (threePane ? 'chat' : 'preview') : (focus === 'chat' ? 'preview' : 'files');
        render(); return;
      }
      if (s === '\u001b[Z') { // Shift+Tab: reverse
        focus = (focus === 'preview') ? (threePane ? 'chat' : 'files') : (focus === 'chat' ? 'files' : 'preview');
        render(); return;
      }
      if (s === '\u001b[A') { // up
        if (focus === 'chat' && threePane) { chatScroll = chatScroll + 1; }
        else if (focus === 'preview') { previewScroll = previewScroll - 1; }
        else { if (mode === 'browse') { idx = Math.max(0, idx - 1); previewScroll = 0; } else { resultIdx = Math.max(0, resultIdx - 1); previewScroll = 0; } }
        render(); return;
      }
      if (s === '\u001b[B') { // down
        if (focus === 'chat' && threePane) { chatScroll = Math.max(0, chatScroll - 1); }
        else if (focus === 'preview') { previewScroll = previewScroll + 1; }
        else { if (mode === 'browse') { idx = Math.min(flat.length - 1, idx + 1); previewScroll = 0; } else { resultIdx = Math.min(results.length - 1, resultIdx + 1); previewScroll = 0; } }
        render(); return;
      }
      if (s === '\u001b[D') { // left collapse
        if (mode === 'browse' && focus === 'files') { const it = flat[idx]; if (it && it.node.isDir) { it.node.expanded = false; } }
        render(); return;
      }
      if (s === '\u001b[C') { // right expand
        if (mode === 'browse' && focus === 'files') { const it = flat[idx]; if (it && it.node.isDir) { if (!it.node.children) loadChildren(it.node); it.node.expanded = true; } }
        render(); return;
      }
      if (s === '\u001b[5~') { // Page Up
        if (focus === 'chat' && threePane) { chatScroll = chatScroll + ((process.stdout.rows||20) - 3); render(); return; }
        if (focus === 'preview') { previewScroll = previewScroll - ((process.stdout.rows||20) - 3); render(); return; }
      }
      if (s === '\u001b[6~') { // Page Down
        if (focus === 'chat' && threePane) { chatScroll = Math.max(0, chatScroll - ((process.stdout.rows||20) - 3)); render(); return; }
        if (focus === 'preview') { previewScroll = previewScroll + ((process.stdout.rows||20) - 3); render(); return; }
      }
      if (s === '\r' || s === '\n') { // open / open selection in preview (noop)
        render(); return;
      }
      // Vim-style motions (non-destructive)
      if (s === 'j') { // down
        if (focus === 'chat' && threePane) { chatScroll = Math.max(0, chatScroll - 1); }
        else if (focus === 'preview') { previewScroll = previewScroll + 1; }
        else { if (mode === 'browse') { idx = Math.min(flat.length - 1, idx + 1); previewScroll = 0; } else { resultIdx = Math.min(results.length - 1, resultIdx + 1); previewScroll = 0; } }
        render(); return;
      }
      if (s === 'k') { // up
        if (focus === 'chat' && threePane) { chatScroll = chatScroll + 1; }
        else if (focus === 'preview') { previewScroll = previewScroll - 1; }
        else { if (mode === 'browse') { idx = Math.max(0, idx - 1); previewScroll = 0; } else { resultIdx = Math.max(0, resultIdx - 1); previewScroll = 0; } }
        render(); return;
      }
      if (s === 'h') { // left (collapse)
        if (mode === 'browse' && focus === 'files') { const it = flat[idx]; if (it && it.node.isDir) { it.node.expanded = false; } }
        render(); return;
      }
      if (s === 'l') { // right (expand)
        if (mode === 'browse' && focus === 'files') { const it = flat[idx]; if (it && it.node.isDir) { if (!it.node.children) loadChildren(it.node); it.node.expanded = true; } }
        render(); return;
      }
      if (s === 'G') { // bottom/end
        if (focus === 'chat' && threePane) { chatScroll = 0; }
        else if (focus === 'preview') { previewScroll = 1e9; }
        else { if (mode === 'browse') idx = Math.max(0, flat.length - 1); else resultIdx = Math.max(0, results.length - 1); }
        render(); return;
      }
      if (s === '\u0006') { // Ctrl-F page down
        const page = (process.stdout.rows || 20) - 3;
        if (focus === 'chat' && threePane) { chatScroll = Math.max(0, chatScroll - page); }
        else if (focus === 'preview') { previewScroll += page; }
        else { if (mode === 'browse') { idx = Math.min(flat.length - 1, idx + page); } else { resultIdx = Math.min(results.length - 1, resultIdx + page); } }
        render(); return;
      }
      if (s === '\u0002') { // Ctrl-B page up
        const page = (process.stdout.rows || 20) - 3;
        if (focus === 'chat' && threePane) { chatScroll = chatScroll + page; }
        else if (focus === 'preview') { previewScroll = Math.max(0, previewScroll - page); }
        else { if (mode === 'browse') { idx = Math.max(0, idx - page); } else { resultIdx = Math.max(0, resultIdx - page); } }
        render(); return;
      }
      if (s === '/'){
        const q = await enterLinePrompt('Grep');
        if (q !== null) { doSearch(q); render(); }
        return;
      }
      if (s === 'f') { finderMode = true; finderQuery=''; finderItems=[]; finderFiltered=[]; finderSel=0; scroll=0; render(); return; }
      if (s === 'g') {
        const q = await enterLinePrompt('Grep pattern'); if (q===null) return;
        const inc = await enterLinePrompt('Include glob (* for any, blank to skip)');
        const exc = await enterLinePrompt('Exclude glob (e.g., *.min.js)');
        const cs = await enterLinePrompt('Case sensitive? (y/N)');
        const rg = await enterLinePrompt('Use regex? (y/N)');
        doSearch(q, { include: (inc||'').trim() || null, exclude: (exc||'').trim() || null, caseSensitive: /^y(es)?$/i.test(cs||''), regex: /^y(es)?$/i.test(rg||'') });
        render(); return;
      }
      if (s === 'V') { threePane = !threePane; render(); return; }
      if ((s === 'C' || s === 'c') && onAsk) {
        let q;
        if (threePane) {
          const rows = process.stdout.rows || 30;
          const cols = process.stdout.columns || 100;
          const leftW = Math.max(24, Math.floor(cols * 0.28));
          const midW = Math.max(28, Math.floor(cols * 0.34));
          const rightW = cols - leftW - (midW + 4);
          // Prompt on the last line inside chat panel area (right)
          const y = rows - 2;
          const x = leftW + midW + 4;
          q = await enterPromptAt(y, x, rightW, 'Ask AI');
        } else {
          q = await enterLinePrompt('Ask AI');
        }
        if (q !== null && q.trim()) {
          // Auto-include selected file context when present
          let prompt = q.trim();
          try {
            // Determine current selection path, same logic as preview
            const selectedPath = (function(){
              if (pinPreview && pinned.length) return pinned[pinnedIdx];
              if (finderMode) return (finderFiltered.length ? finderFiltered[finderSel]?.path : null);
              return (mode === 'browse') ? (flat[idx]?.node?.path) : (results[resultIdx]?.path);
            })();
            if (selectedPath) {
              let meta = '';
              try {
                const st = fs.statSync(selectedPath);
                meta = `size=${st.size} bytes, modified=${new Date(st.mtime).toISOString()}`;
              } catch {}
              let head = '';
              try {
                if (fs.existsSync(selectedPath) && fs.statSync(selectedPath).isFile()) {
                  const data = fs.readFileSync(selectedPath, 'utf8');
                  const lines = data.split(/\r?\n/).slice(0, 200).join('\n');
                  head = lines;
                }
              } catch {}
              const shortPath = humanPath(selectedPath);
              prompt = `Context: You are discussing the currently selected file in the app.\nPath: ${shortPath}${meta ? ` (${meta})` : ''}\n${head ? `\nFirst 200 lines:\n${head}\n\n` : ''}User request: ${q.trim()}`;
            }
          } catch {}
          try { await onAsk(prompt); } catch {}
          chatScroll = 0;
          render();
        }
        return;
      }
      if (s === 'S') {
        const newVal = !options.autoScan;
        options.autoScan = newVal;
        if (typeof onToggleAutoScan === 'function') {
          try { await onToggleAutoScan(newVal); } catch {}
        }
        showToast(`Auto-scan ${newVal ? 'enabled' : 'disabled'}`);
        return;
      }
      if (s === ' ') { // toggle select in search mode
        if (mode==='search') { const id = resultIdx; if (selectedResults.has(id)) selectedResults.delete(id); else selectedResults.add(id); render(); } return;
      }
      if (s === 'E') { // Edit selected file in editor view
        const pth = (mode === 'browse') ? flat[idx]?.node?.path : results[resultIdx]?.path;
        if (pth && !fs.statSync(pth).isDirectory()) { cleanup(); resolve({ type: 'editFile', path: pth }); return; }
        return;
      }
      if (s === 'O') { // open selected results via OS
        if (mode==='search' && selectedResults.size) {
          for (const id of selectedResults) {
            const r = results[id]; if (!r) continue;
            const pth = r.path;
            const cmd = process.platform === 'win32' ? `explorer "${pth}"` : (process.platform === 'darwin' ? `open "${pth}"` : `xdg-open "${pth}"`);
            require('child_process').exec(cmd, { cwd: rootPath });
          }
        }
        return;
      }
      // Pin tabs
      if (s === 't') { const pth=(mode==='browse')? flat[idx]?.node?.path : results[resultIdx]?.path; if (pth && !fs.statSync(pth).isDirectory()) { if (!pinned.includes(pth)) { pinned.push(pth); pinnedIdx=pinned.length-1; } else { pinnedIdx=pinned.indexOf(pth); } render(); } return; }
      if (s === 'x') { if (pinned.length) { pinned.splice(pinnedIdx,1); if (pinnedIdx>=pinned.length) pinnedIdx=Math.max(0,pinned.length-1); render(); } return; }
      if (s === '[') { if (pinned.length) { pinnedIdx = (pinnedIdx-1 + pinned.length) % pinned.length; render(); } return; }
      if (s === ']') { if (pinned.length) { pinnedIdx = (pinnedIdx+1) % pinned.length; render(); } return; }
      if (s === 'P') { if (pinned.length){ pinPreview = !pinPreview; render(); } return; }
      // Inline file ops
      if (s === 'r') { // rename
        const targetPath = (mode==='browse') ? flat[idx]?.node?.path : (results[resultIdx]?.path);
        if (targetPath){
          const nn = await enterLinePrompt('Rename to'); if (nn!==null && nn.trim()) { try { fs.renameSync(targetPath, path.join(path.dirname(targetPath), nn.trim())); } catch(e){ console.log(e.message);} loadChildren(root); render(); }
        }
        return;
      }
      if (s === 'm') { // mkdir
        const base = (mode==='browse' && flat[idx]?.node?.isDir) ? flat[idx].node.path : (results[resultIdx]?.path ? path.dirname(results[resultIdx].path) : rootPath);
        const nn = await enterLinePrompt('Directory name'); if (nn!==null && nn.trim()) { try { fs.mkdirSync(path.join(base, nn.trim()), { recursive: true }); } catch(e){ console.log(e.message);} loadChildren(root); render(); }
        return;
      }
      if (s === 'i') { // new file
        const base = (mode==='browse' && flat[idx]?.node?.isDir) ? flat[idx].node.path : (results[resultIdx]?.path ? path.dirname(results[resultIdx].path) : rootPath);
        const nn = await enterLinePrompt('New file name'); if (nn!==null && nn.trim()) { try { fs.writeFileSync(path.join(base, nn.trim()), ''); } catch(e){ console.log(e.message);} loadChildren(root); render(); }
        return;
      }
      if (s === 'd') { // delete
        const targetPath = (mode==='browse') ? flat[idx]?.node?.path : (results[resultIdx]?.path);
        if (targetPath){ const conf = await enterLinePrompt('Type DELETE to confirm'); if (conf && conf.toUpperCase()==='DELETE'){ try { fs.rmSync(targetPath,{recursive:true,force:true}); } catch(e){ console.log(e.message);} loadChildren(root); render(); } }
        return;
      }
      if (s === ':') {
        const cmd = await enterLinePrompt(':');
        if (cmd !== null) {
          const trimmed = cmd.trim();
          const targetPath = (mode==='browse') ? flat[idx]?.node?.path : (results[resultIdx]?.path);
          if (trimmed.startsWith('rename ') && targetPath) {
            const newName = trimmed.slice(7).trim();
            const dir = fs.statSync(targetPath).isDirectory() ? path.dirname(targetPath) : path.dirname(targetPath);
            const dest = path.join(dir, newName);
            try { fs.renameSync(targetPath, dest); rootPath = root.path; loadChildren(root); render(); } catch(e){ console.log(e.message);}        
          } else if ((trimmed.startsWith('new file ')|| trimmed.startsWith('touch '))) {
            const name = trimmed.replace(/^new file\s+|^touch\s+/,'');
            const base = (mode==='browse' && flat[idx]?.node?.isDir) ? flat[idx].node.path : (targetPath ? path.dirname(targetPath) : rootPath);
            const f = path.join(base, name);
            try { fs.writeFileSync(f,''); } catch(e) { console.log(e.message);} loadChildren(root); render();
          } else if (trimmed.startsWith('mkdir ')) {
            const name = trimmed.slice(6).trim();
            const base = (mode==='browse' && flat[idx]?.node?.isDir) ? flat[idx].node.path : (targetPath ? path.dirname(targetPath) : rootPath);
            const d = path.join(base, name);
            try { fs.mkdirSync(d, { recursive: true }); } catch(e) { console.log(e.message);} loadChildren(root); render();
          } else if (trimmed === 'delete' && targetPath) {
            // simple confirm inline
            const conf = await enterLinePrompt('Type DELETE to confirm');
            if (conf && conf.toUpperCase()==='DELETE') { try { fs.rmSync(targetPath,{recursive:true,force:true}); } catch(e) { console.log(e.message);} loadChildren(root); render(); }
          }
        }
        return;
      }
      if (s === 'a') {
        const pth = (mode === 'browse') ? flat[idx]?.node?.path : results[resultIdx]?.path;
        if (pth && onAction) { cleanup(); resolve({ type: 'askFile', path: pth }); return; }
        return;
      }
      if (s === 's') {
        // Set current directory as session CWD
        let pth = (mode === 'browse') ? flat[idx]?.node?.path : results[resultIdx]?.path;
        if (pth) {
          try {
            const isDir = fs.statSync(pth).isDirectory();
            if (!isDir) pth = path.dirname(pth);
            cleanup(); resolve({ type: 'setCwd', path: pth }); return;
          } catch {}
        }
        return;
      }
      if (s === 'A') {
        const pth = (mode === 'browse') ? flat[idx]?.node?.path : results[resultIdx]?.path;
        if (pth && onAction) {
          const instruction = await enterLinePrompt('Fix instruction');
          cleanup(); resolve({ type: 'fixFile', path: pth, instruction: instruction || '' }); return;
        }
        return;
      }
      if (s === 'n') { if (mode === 'search') { resultIdx = Math.min(results.length - 1, resultIdx + 1); render(); } return; }
      if (s === 'N') { if (mode === 'search') { resultIdx = Math.max(0, resultIdx - 1); render(); } return; }
      if (s === 'b') { mode = 'browse'; render(); return; }
      if (s === 'o') { // open via OS
        const pth = (mode === 'browse') ? flat[idx]?.node?.path : results[resultIdx]?.path;
        if (pth) {
          const cmd = process.platform === 'win32' ? `explorer "${pth}"` : (process.platform === 'darwin' ? `open "${pth}"` : `xdg-open "${pth}"`);
          require('child_process').exec(cmd, { cwd: rootPath });
        }
        return;
      }
    };
    process.stdin.on('data', onData);
  }).finally(() => {
    try { process.removeListener('SIGINT', sigintGuard); } catch {}
    try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw); } catch {}
    try { if (prevFlowing === false) process.stdin.pause(); } catch {}
    showCursor();
    });
}

export { startTui };

// Simple collaborative editor for a single file with AI chat pane
async function startEditor(filePath, options = {}) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { content = ''; }
  let lines = content.split(/\r?\n/);
  let curY = 0, curX = 0;
  let top = 0; // scroll top line index
  let mode = 'normal';
  let modified = false;
  const chat = [];
  const onAsk = options.onAsk || null;
  const onApplyAI = options.onApplyAI || null;

  let showHelp = true;
  function draw() {
    const rows = process.stdout.rows || 30;
    const cols = process.stdout.columns || 100;
    const leftW = Math.max(40, Math.floor(cols * 0.65));
    const rightW = cols - leftW - 3;
    clear();
    showCursor();
    const title = ` Editor — ${humanPath(filePath)} `;
    process.stdout.write(color(title.padEnd(cols), '44;37'));
    // Headers
    move(2,1); process.stdout.write(color(truncate('File', leftW).padEnd(leftW),'1'));
    move(2,leftW+3); process.stdout.write(color(truncate('AI Chat', rightW).padEnd(rightW),'1'));
    // Editor area
    const area = rows - 4;
    for (let i=0;i<area;i++){
      const y = top + i;
      const line = lines[y] ?? '';
      move(3+i,1); process.stdout.write(truncate(line, leftW).padEnd(leftW));
    }
    // Highlight cursor cell in NORMAL mode for visibility
    const cy = 3 + (curY - top);
    const cx = 1 + Math.min(curX, leftW-1);
    if (mode === 'normal') {
      const chLine = lines[curY] ?? '';
      const ch = (curX < chLine.length) ? chLine[curX] : ' ';
      move(cy, cx);
      process.stdout.write(color(ch || ' ', '7')); // inverse cell
    }
    // Chat area
    const wrapped = wrapText(chat, rightW);
    const start = Math.max(0, wrapped.length - area);
    for (let i=0;i<area;i++){
      move(3+i,leftW+3);
      process.stdout.write(truncate(wrapped[start+i] || '', rightW).padEnd(rightW));
    }
    // Status line
    const statusLeft = ` ${mode.toUpperCase()} ${modified ? '*' : ' '} ${curY+1}:${curX+1}`;
    const statusRight = ` :w save  :q quit  C ask-AI  Esc cancel-input  ? help `;
    move(rows-1,1);
    process.stdout.write(color(truncate(statusLeft + ' | ' + statusRight, cols).padEnd(cols),'100;37'));
    // Help bar (mode-aware)
    const help = showHelp
      ? (mode === 'normal'
          ? 'Move: h j k l | Insert: i | New line: o | Save/Quit: :w :q :wq | Page: Ctrl-F/Ctrl-B | AI: C'
          : 'Insert: type to edit | Enter: split line | Backspace: delete/join | Esc: Normal | Save: :w | Quit: :q')
      : '';
    if (help) {
      move(rows,1);
      process.stdout.write(color(truncate(' ' + help, cols).padEnd(cols), '100;30'));
    }
    // Place terminal cursor at logical position
    move(cy, cx);
  }

  function clampCursor() {
    if (curY < 0) curY = 0; if (curY >= lines.length) curY = Math.max(0, lines.length-1);
    if (curX < 0) curX = 0; const len = (lines[curY]||'').length; if (curX > len) curX = len;
    const rows = process.stdout.rows || 30; const area = rows - 4;
    if (curY < top) top = curY; if (curY >= top + area) top = curY - area + 1;
  }

  async function askAIInstruction() {
    if (!onAsk) return;
    // Inline prompt at bottom of chat pane
    const rows = process.stdout.rows || 30; const cols = process.stdout.columns || 100;
    const leftW = Math.max(40, Math.floor(cols * 0.65)); const rightW = cols - leftW - 3;
    move(rows-2, leftW+3); process.stdout.write(' '.repeat(rightW));
    move(rows-2, leftW+3); process.stdout.write('AI instruction: ');
    let q='';
    await new Promise((resolve)=>{
      const handler=(b)=>{
        const s=b.toString('utf8');
        if (s==='\u0003' || s==='\u001b'){ process.stdin.off('data',handler); resolve(); return; }
        if (s==='\r' || s==='\n'){ process.stdin.off('data',handler); resolve(); return; }
        if (s==='\u0008' || s==='\u007f'){ q=q.slice(0,-1);} else if (s>=' ') { q+=s; }
        move(rows-2, leftW+3 + 'AI instruction: '.length);
        process.stdout.write(truncate(q, rightW - 'AI instruction: '.length).padEnd(rightW - 'AI instruction: '.length));
      };
      process.stdin.on('data',handler);
    });
    if (!q.trim()) return;
    chat.push('You: ' + q.trim());
    draw();
    // Build prompt to request full file rewrite
    const prompt = `You are editing a file. Apply the user's instruction to the code and respond ONLY with a tool_code block that writes the full updated file.\n\nInstruction: ${q.trim()}\n\nFile: ${filePath}\n\nCurrent content:\n\n${lines.join('\n')}\n\nRespond in this exact format:\n\n\`\`\`tool_code\n{{agent:fs:write:${filePath}:<paste full updated file content here>}}\n\`\`\``;
    const ans = await onAsk(prompt);
    chat.push('AI: ' + (ans || '').split(/\r?\n/)[0]);
    // Try to extract tool_code
    const re = /```tool_code\s*\n\s*\{\{agent:fs:write:(.*?):([\s\S]*?)\}\}\s*\n\s*```/;
    const m = (ans||'').match(re);
    if (m) {
      const newContent = m[2];
      lines = newContent.replace(/\r\n/g,'\n').split('\n');
      modified = true; curX=0; curY=0; top=0;
      if (onApplyAI) try { await onApplyAI(newContent); } catch{}
    }
    draw();
  }

  return new Promise((resolve)=>{
    const prevRaw = process.stdin.isRaw;
    try { if (process.stdin.isTTY) process.stdin.setRawMode(true);} catch{}
    try { process.stdin.resume(); } catch{}
    draw();
    const onKey = async (buf)=>{
      const s = buf.toString('utf8');
      if (s==='\u0003'){ showCursor(); try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw);} catch{} resolve(); return; }
      if (s==='q' && mode==='normal'){ showCursor(); try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw);} catch{} resolve({ saved:false }); return; }
      if (s===':' && mode==='normal'){
        // mini cmdline
        const rows = process.stdout.rows || 30; const cols = process.stdout.columns || 100;
        move(rows,1); process.stdout.write(' '.repeat(cols)); move(rows,1); process.stdout.write(':');
        let cmd='';
        const handler=(b)=>{
          const t=b.toString('utf8');
          if (t==='\u0003' || t==='\u001b'){ process.stdin.off('data',handler); draw(); return; }
          if (t==='\r' || t==='\n'){
            process.stdin.off('data',handler);
            if (cmd.trim()==='w' || cmd.trim()==='wq'){
              try { fs.writeFileSync(filePath, lines.join('\n')); modified=false; } catch{}
              if (cmd.trim()==='wq'){ showCursor(); try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw);} catch{} resolve({ saved:true }); return; }
            } else if (cmd.trim()==='q'){ showCursor(); try { if (process.stdin.isTTY) process.stdin.setRawMode(!!prevRaw);} catch{} resolve({ saved:false }); return; }
            draw(); return;
          }
          if (t==='\u0008' || t==='\u007f'){ cmd=cmd.slice(0,-1);} else if (t>=' '){ cmd+=t; }
          move(rows,2); process.stdout.write(truncate(cmd, cols-2).padEnd(cols-2));
        };
        process.stdin.on('data',handler);
        return;
      }
      if (s==='C' && mode==='normal'){ await askAIInstruction(); return; }
      if (s==='?') { showHelp = !showHelp; draw(); return; }
      if (mode==='normal'){
        if (s==='i'){ mode='insert'; draw(); return; }
        if (s==='o'){ lines.splice(curY+1,0,''); curY++; curX=0; mode='insert'; modified=true; draw(); return; }
        if (s==='x'){ const L=lines[curY]||''; if (curX< L.length){ lines[curY]=L.slice(0,curX)+L.slice(curX+1); modified=true; } draw(); return; }
        if (s==='h'){ curX--; clampCursor(); draw(); return; }
        if (s==='l'){ curX++; clampCursor(); draw(); return; }
        if (s==='j'){ curY++; clampCursor(); draw(); return; }
        if (s==='k'){ curY--; clampCursor(); draw(); return; }
        if (s==='G'){ curY = Math.max(0, lines.length-1); clampCursor(); draw(); return; }
        if (s==='\u0006'){ const page=(process.stdout.rows||20)-4; curY=Math.min(lines.length-1, curY+page); clampCursor(); draw(); return; }
        if (s==='\u0002'){ const page=(process.stdout.rows||20)-4; curY=Math.max(0, curY-page); clampCursor(); draw(); return; }
        return;
      }
      // insert mode
      if (s==='\u001b'){ mode='normal'; draw(); return; }
      if (s==='\r' || s==='\n'){ const L=lines[curY]||''; const before=L.slice(0,curX); const after=L.slice(curX); lines[curY]=before; lines.splice(curY+1,0,after); curY++; curX=0; modified=true; draw(); return; }
      if (s==='\u0008' || s==='\u007f'){ const L=lines[curY]||''; if (curX>0){ lines[curY]=L.slice(0,curX-1)+L.slice(curX); curX--; modified=true; } else if (curY>0){ const prevLen= (lines[curY-1]||'').length; lines[curY-1]+=L; lines.splice(curY,1); curY--; curX=prevLen; modified=true; } draw(); return; }
      if (s>=' '){ const L=lines[curY]||''; lines[curY]=L.slice(0,curX)+s+L.slice(curX); curX++; modified=true; draw(); return; }
    };
    process.stdin.on('data', onKey);
  });
}

export { startEditor };
