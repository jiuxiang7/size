(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var state = {
    items: [],
    seq: 0,
    running: false,
    cancel: false,
    format: 'auto',
    pdfMode: 'smart',
    allowResize: true
  };

  var els = {
    targetValue: $('#targetValue'),
    targetUnit: $('#targetUnit'),
    presets: $('#presets'),
    dropzone: $('#dropzone'),
    fileInput: $('#fileInput'),
    startBtn: $('#startBtn'),
    clearBtn: $('#clearBtn'),
    zipBtn: $('#zipBtn'),
    summary: $('#summary'),
    list: $('#list'),
    listWrap: $('#listWrap'),
    listCount: $('#listCount'),
    toast: $('#toast'),
    pdfHint: $('#pdfHint'),
    allowResize: $('#allowResize')
  };

  /* ---------------- 工具 ---------------- */
  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) {
      var kb = n / 1024;
      return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    }
    var mb = n / 1048576;
    return (mb < 10 ? mb.toFixed(2) : mb.toFixed(1)) + ' MB';
  }

  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove('show'); }, 2400);
  }

  function getTarget() {
    var v = parseFloat(els.targetValue.value);
    if (!isFinite(v) || v <= 0) v = 500;
    var unit = parseInt(els.targetUnit.value, 10) || 1024;
    return Math.max(10 * 1024, Math.round(v * unit));
  }

  function extOf(name) {
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  function outName(name, ext) {
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    return base + '_compressed.' + ext;
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ---------------- 文件接入 ---------------- */
  function kindOf(file) {
    var t = (file.type || '').toLowerCase();
    var ext = extOf(file.name);
    if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (t.indexOf('image/') === 0 || /^(jpg|jpeg|png|webp|gif|bmp|avif)$/.test(ext)) return 'image';
    return null;
  }

  function addFiles(fileList) {
    var added = 0, skipped = 0;
    Array.prototype.forEach.call(fileList, function (file) {
      var kind = kindOf(file);
      if (!kind) { skipped++; return; }
      if (!file.size) { skipped++; return; }

      var item = {
        id: ++state.seq,
        file: file,
        kind: kind,
        name: file.name,
        originalSize: file.size,
        status: 'pending',
        progress: 0,
        progressText: '等待处理',
        result: null,
        detail: '',
        error: '',
        thumb: null,
        thumbUrl: null
      };
      state.items.push(item);
      added++;
      if (kind === 'image') {
        item.thumbUrl = URL.createObjectURL(file);
        renderItem(item);
      } else {
        renderItem(item);
        PdfCompressor.thumbnail(file, 160).then(function (url) {
          item.thumbUrl = url;
          if (item.el) {
            var t = item.el.querySelector('.thumb');
            t.innerHTML = '<img alt="">';
            t.querySelector('img').src = url;
          }
        }).catch(function () { /* 缩略图失败不影响主流程 */ });
      }
    });

    if (added) {
      els.listWrap.hidden = false;
      updateActions();
      updateSummary();
      toast('已添加 ' + added + ' 个文件');
    }
    if (skipped) toast(skipped + ' 个文件类型不支持，已忽略');
  }

  /* ---------------- 列表渲染 ---------------- */
  var ICON_DL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  function renderItem(item) {
    var el = document.createElement('div');
    el.className = 'item';
    el.innerHTML =
      '<div class="thumb">' + (item.kind === 'pdf' ? '<span class="ph">PDF</span>' : '') + '</div>' +
      '<div class="meta">' +
        '<div class="name-row"><span class="name"></span><span class="tag"></span></div>' +
        '<div class="sizes"><span class="from"></span><span class="arrow">→</span><span class="to">—</span><span class="pill pend">待处理</span></div>' +
        '<div class="note">等待处理</div>' +
        '<div class="bar idle"><i></i></div>' +
      '</div>' +
      '<div class="actions">' +
        '<button class="ibtn dl" title="下载" disabled>' + ICON_DL + '</button>' +
        '<button class="ibtn rm" title="移除">' + ICON_X + '</button>' +
      '</div>';
    item.el = el;

    var thumb = el.querySelector('.thumb');
    if (item.thumbUrl) {
      thumb.innerHTML = '<img alt="">';
      thumb.querySelector('img').src = item.thumbUrl;
    }

    el.querySelector('.name').textContent = item.name;
    el.querySelector('.name').title = item.name;
    el.querySelector('.tag').textContent = item.kind === 'pdf' ? 'PDF' : (extOf(item.name) || 'IMG');
    el.querySelector('.from').textContent = fmtBytes(item.originalSize);

    el.querySelector('.dl').addEventListener('click', function () { downloadItem(item); });
    el.querySelector('.rm').addEventListener('click', function () { removeItem(item); });

    els.list.appendChild(el);
    updateItem(item);
  }

  function updateItem(item) {
    if (!item.el) return;
    var bar = item.el.querySelector('.bar');
    var fill = bar.querySelector('i');
    var to = item.el.querySelector('.to');
    var pill = item.el.querySelector('.pill');
    var note = item.el.querySelector('.note');
    var dl = item.el.querySelector('.dl');

    bar.className = 'bar';
    pill.className = 'pill';

    if (item.status === 'pending') {
      bar.classList.add('idle');
      pill.classList.add('pend');
      pill.textContent = '待处理';
      to.textContent = '—';
      note.textContent = '目标 ' + fmtBytes(getTarget());
      dl.disabled = true;
    } else if (item.status === 'working') {
      fill.style.width = Math.max(4, item.progress) + '%';
      pill.classList.add('pend');
      pill.textContent = '处理中';
      note.textContent = item.progressText || '处理中 …';
      dl.disabled = true;
    } else if (item.status === 'done') {
      bar.classList.add('done');
      fill.style.width = '100%';
      to.textContent = fmtBytes(item.resultSize);
      var saved = item.originalSize > 0 ? Math.round((1 - item.resultSize / item.originalSize) * 100) : 0;
      if (item.met) {
        pill.classList.add('ok');
        pill.textContent = saved > 0 ? '↓ ' + saved + '%' : '已达标';
      } else {
        pill.classList.add('warn');
        pill.textContent = saved > 0 ? '最接近 ↓ ' + saved + '%' : '未达标';
      }
      note.textContent = noteText(item);
      note.title = note.textContent;
      dl.disabled = false;
    } else if (item.status === 'skip') {
      bar.classList.add('done');
      fill.style.width = '100%';
      to.textContent = fmtBytes(item.originalSize);
      pill.classList.add('ok');
      pill.textContent = '无需压缩';
      note.textContent = noteText(item);
      dl.disabled = false;
    } else if (item.status === 'error') {
      bar.classList.add('err');
      fill.style.width = '100%';
      to.textContent = '失败';
      pill.classList.add('err');
      pill.textContent = '出错';
      note.textContent = item.error;
      note.title = item.error;
      dl.disabled = true;
    }
  }

  function noteText(item) {
    var text = item.detail || '';
    if (item.targetUsed && item.targetUsed !== getTarget()) {
      text += ' · 目标已改为 ' + fmtBytes(getTarget()) + '，可再次压缩';
    }
    return text;
  }

  function removeItem(item) {
    if (state.running) { toast('处理中，稍后再移除'); return; }
    if (item.thumbUrl && item.thumbUrl.indexOf('blob:') === 0) URL.revokeObjectURL(item.thumbUrl);
    if (item.el) item.el.remove();
    state.items = state.items.filter(function (i) { return i !== item; });
    if (!state.items.length) els.listWrap.hidden = true;
    updateActions();
    updateSummary();
  }

  function clearAll() {
    if (state.running) { toast('处理中，稍后再清空'); return; }
    state.items.forEach(function (i) {
      if (i.thumbUrl && i.thumbUrl.indexOf('blob:') === 0) URL.revokeObjectURL(i.thumbUrl);
      if (i.el) i.el.remove();
    });
    state.items = [];
    els.listWrap.hidden = true;
    updateActions();
    updateSummary();
  }

  /* ---------------- 压缩流程 ---------------- */
  async function processOne(item) {
    var target = getTarget();
    item.status = 'working';
    item.targetUsed = target;
    item.progress = 2;
    item.progressText = '准备中 …';
    updateItem(item);

    var report = function (pct, text) {
      item.progress = Math.max(2, Math.min(99, pct));
      item.progressText = text;
      updateItem(item);
    };

    try {
      if (item.originalSize <= target) {
        item.status = 'skip';
        item.result = item.file;
        item.resultSize = item.originalSize;
        item.resultName = item.name;
        item.detail = '原始体积已小于目标（' + fmtBytes(item.originalSize) + '），保留原文件';
        item.met = true;
        updateItem(item);
        return;
      }

      if (item.kind === 'image') {
        var r = await ImageCompressor.compress(item.file, target, {
          format: state.format,
          allowResize: state.allowResize
        }, report);
        item.result = r.blob;
        item.resultSize = r.blob.size;
        item.resultName = outName(item.name, r.ext);
        item.met = r.met;
        item.detail = r.detail;
        var extra = '';
        if (/gif/i.test(item.file.type)) extra = ' · 动图仅保留首帧';
        if (!state.allowResize && !r.met) extra += ' · 已禁用降分辨率，可勾选后重试';
        item.detail += extra;
      } else {
        var p = await PdfCompressor.compress(item.file, target, { pdfMode: state.pdfMode }, report);
        item.result = new Blob([p.bytes], { type: 'application/pdf' });
        item.resultSize = p.bytes.length;
        item.resultName = outName(item.name, 'pdf');
        item.met = p.met;
        item.detail = p.detail;
      }

      item.status = 'done';
      item.progress = 100;
      updateItem(item);
    } catch (e) {
      item.status = 'error';
      item.error = (e && e.message) || String(e);
      updateItem(item);
    }
  }

  async function processAll() {
    var pending = state.items.filter(needsWork);
    if (!pending.length) { toast('没有待处理的文件'); return; }

    state.running = true;
    state.cancel = false;
    updateActions();

    for (var i = 0; i < pending.length; i++) {
      if (state.cancel) break;
      await processOne(pending[i]);
      updateSummary();
      // 给 UI 一帧喘息时间
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    state.running = false;
    updateActions();
    updateSummary();
    toast(state.cancel ? '已停止' : '全部处理完成');
    state.cancel = false;
  }

  /* ---------------- 下载 ---------------- */
  /* 需要（重新）处理的文件：待处理、出错，或目标大小已变更 */
  function needsWork(item) {
    if (item.status === 'pending' || item.status === 'error') return true;
    if ((item.status === 'done' || item.status === 'skip') && item.targetUsed &&
        item.targetUsed !== getTarget()) return true;
    return false;
  }

  function downloadItem(item) {
    if (!item.result) return;
    var blob = item.result instanceof Blob ? item.result : new Blob([item.result]);
    saveBlob(blob, item.resultName || item.name);
  }

  async function downloadZip() {
    var items = state.items.filter(function (i) { return i.result; });
    if (!items.length) { toast('还没有可下载的结果'); return; }
    els.zipBtn.disabled = true;
    els.zipBtn.textContent = '打包中 …';
    try {
      var used = {};
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var blob = it.result instanceof Blob ? it.result : new Blob([it.result]);
        var name = it.resultName || it.name;
        if (used[name]) {
          var dot = name.lastIndexOf('.');
          var base = dot > 0 ? name.slice(0, dot) : name;
          var ext = dot > 0 ? name.slice(dot) : '';
          name = base + '(' + used[name] + ')' + ext;
        }
        used[it.resultName || it.name] = (used[it.resultName || it.name] || 1) + 1;
        entries.push({ name: name, data: new Uint8Array(await blob.arrayBuffer()) });
      }
      var zip = createZip(entries);
      saveBlob(zip, 'compressed_' + Date.now() + '.zip');
      toast('已打包 ' + entries.length + ' 个文件');
    } catch (e) {
      toast('打包失败：' + e.message);
    } finally {
      els.zipBtn.textContent = '打包下载 ZIP';
      updateActions();
    }
  }

  /* ---------------- 状态栏 ---------------- */
  function updateActions() {
    var hasPending = state.items.some(needsWork);
    var hasResult = state.items.some(function (i) { return i.result; });

    if (state.running) {
      els.startBtn.disabled = false;
      els.startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7h10v10H7z"/></svg> 停止压缩';
    } else {
      els.startBtn.disabled = !hasPending;
      els.startBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg> 开始压缩';
    }
    els.clearBtn.disabled = state.running || !state.items.length;
    els.zipBtn.disabled = state.running || !hasResult;

    els.listCount.textContent = state.items.length ? state.items.length + ' 个文件' : '';
  }

  function updateSummary() {
    var totalIn = 0, totalOut = 0, done = 0;
    state.items.forEach(function (i) {
      if (i.result) {
        totalIn += i.originalSize;
        totalOut += i.resultSize;
        done++;
      }
    });
    if (!done) { els.summary.textContent = ''; return; }
    var saved = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0;
    els.summary.textContent = done + ' 个已完成 · ' + fmtBytes(totalIn) + ' → ' + fmtBytes(totalOut) +
      (saved > 0 ? '（省下 ' + saved + '%）' : '');
  }

  /* ---------------- 事件绑定 ---------------- */
  // 只留一条触发路径：容器本身不再关联 input，避免「点一次弹两次」窗口
  var lastPickAt = 0;
  function openPicker(e) {
    if (e) e.preventDefault();
    var now = Date.now();
    if (now - lastPickAt < 400) return; // 同一次点击的重复触发兜底
    lastPickAt = now;
    els.fileInput.value = '';           // 允许再次选择同一个文件
    els.fileInput.click();
  }
  els.dropzone.addEventListener('click', openPicker);
  els.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') openPicker(e);
  });
  els.fileInput.addEventListener('change', function () {
    addFiles(this.files);
    this.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      if (evt === 'dragleave' && e.target !== els.dropzone) return;
      els.dropzone.classList.remove('is-over');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  window.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) addFiles(items);
  });

  els.startBtn.addEventListener('click', function () {
    if (state.running) {
      state.cancel = true;
      toast('正在停止，当前文件处理完即停');
      return;
    }
    processAll();
  });

  els.clearBtn.addEventListener('click', clearAll);
  els.zipBtn.addEventListener('click', downloadZip);

  // 预设
  els.presets.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    els.targetValue.value = btn.dataset.value;
    els.targetUnit.value = btn.dataset.unit;
    Array.prototype.forEach.call(els.presets.children, function (c) { c.classList.remove('is-active'); });
    btn.classList.add('is-active');
    refreshPendingNotes();
  });
  els.targetValue.addEventListener('input', function () {
    Array.prototype.forEach.call(els.presets.children, function (c) { c.classList.remove('is-active'); });
    refreshPendingNotes();
  });
  els.targetUnit.addEventListener('change', function () {
    Array.prototype.forEach.call(els.presets.children, function (c) { c.classList.remove('is-active'); });
    refreshPendingNotes();
  });

  function refreshPendingNotes() {
    state.items.forEach(function (i) {
      if (!i.el) return;
      var note = i.el.querySelector('.note');
      if (!note) return;
      if (i.status === 'pending') note.textContent = '目标 ' + fmtBytes(getTarget());
      else if (i.status === 'done' || i.status === 'skip') note.textContent = noteText(i);
    });
    updateActions();
  }

  // 分段控件
  Array.prototype.forEach.call(document.querySelectorAll('[data-seg]'), function (seg) {
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      Array.prototype.forEach.call(seg.children, function (c) { c.classList.remove('is-active'); });
      btn.classList.add('is-active');
      if (seg.dataset.seg === 'format') state.format = btn.dataset.value;
      if (seg.dataset.seg === 'pdfMode') {
        state.pdfMode = btn.dataset.value;
        els.pdfHint.textContent = {
          smart: '智能：先做无损结构优化，不达标再重绘页面（文字将变为图片，不可选中）。',
          structure: '仅结构：只重排对象流与清理冗余对象，画质无损，压缩幅度通常 2%~15%，不保证达标。',
          raster: '重绘：逐页渲染为 JPEG 重新封装，压缩幅度最大，但文字会变成图片、无法搜索复制。'
        }[state.pdfMode];
      }
    });
  });

  els.allowResize.addEventListener('change', function () { state.allowResize = this.checked; });

  updateActions();
})();
