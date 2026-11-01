/* PDF 压缩引擎
 * 路线一：pdf-lib 重新序列化（无损，靠对象流 + 清理冗余对象，通常 2%~15%）
 * 路线二：pdf.js 逐页重绘为 JPEG 再拼回 PDF（强压，文字变图片）
 * 逐页流式处理：渲染完立刻编码、释放 canvas，避免几十页同时占内存。
 */
(function (global) {
  'use strict';

  var PDFLib = null;
  var pdfjsLib = null;

  function libs() {
    if (!PDFLib) PDFLib = global.PDFLib;
    if (!pdfjsLib) pdfjsLib = global.pdfjsLib;
    if (!PDFLib || !pdfjsLib) throw new Error('PDF 依赖库未加载完成，请刷新页面重试');
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    }
    return { PDFLib: PDFLib, pdfjsLib: pdfjsLib };
  }

  /* 把第三方库的英文报错揉成用户能看懂的话 */
  function friendly(err) {
    var msg = (err && err.message) || '';
    if (/password/i.test(msg)) return '该 PDF 已加密，需要密码才能处理';
    if (/Invalid PDF|structure|corrupt|xref/i.test(msg)) return '文件已损坏或不是有效的 PDF';
    if (!msg) return '未知错误';
    return msg.length > 90 ? msg.slice(0, 90) + '…' : msg;
  }

  async function open(input) {
    var L = libs();
    var bytes = input;
    if (input instanceof Blob) {
      bytes = new Uint8Array(await input.arrayBuffer());
    }
    return L.pdfjsLib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: false
    }).promise.catch(function (err) {
      throw new Error('PDF 解析失败：' + friendly(err));
    });
  }

  async function structuralSave(bytes) {
    var L = libs();
    var doc = await L.PDFLib.PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false
    });
    var out = await doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 60 });
    return out;
  }

  function toJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (!b) { reject(new Error('页面编码失败')); return; }
        resolve(b);
      }, 'image/jpeg', quality);
    });
  }

  async function renderPage(pdf, meta, dpi) {
    var page = await pdf.getPage(meta.index);
    var s = dpi / 72;
    var longest = Math.max(meta.w, meta.h) * s;
    if (longest > 4000) s *= 4000 / longest;
    var vp = page.getViewport({ scale: s });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
    page.cleanup();
    return canvas;
  }

  /* 单页在给定额度内找最高质量 */
  async function encodeWithin(canvas, budget, rounds) {
    var lo = 0.3, hi = 0.92, best = null, smallest = null;
    for (var i = 0; i < (rounds || 4); i++) {
      var mid = (lo + hi) / 2;
      var blob = await toJpeg(canvas, mid);
      if (blob.size <= budget) { best = { blob: blob, q: mid }; lo = mid; }
      else { hi = mid; smallest = { blob: blob, q: mid }; }
      if (hi - lo < 0.06) break;
    }
    if (best) return best;
    var fallback = smallest && smallest.q <= 0.32 ? smallest : { blob: await toJpeg(canvas, 0.3), q: 0.3 };
    return { blob: fallback.blob, q: fallback.q, over: true };
  }

  /**
   * 重绘式压缩
   */
  /* 一轮完整重绘：按剩余额度给每页分配预算 */
  async function rasterPass(pdf, metas, dpi, targetBytes, attempt, report) {
    var n = metas.length;
    var bandStart = [10, 58, 76][attempt] || 10;
    var bandEnd = [58, 76, 90][attempt] || 58;
    var remaining = targetBytes * 0.96; // 预留 PDF 结构与图片对象开销
    var produced = 0;
    var shorts = 0;
    var parts = [];

    for (var k = 0; k < n; k++) {
      var meta = metas[k];
      var left = n - k;
      var budget = Math.max(8 * 1024, (remaining - produced) / left);
      var canvas = await renderPage(pdf, meta, dpi);
      var res = await encodeWithin(canvas, budget, 4);

      if (res.over) {
        // 单页仍超标 → 这一页单独降分辨率再试一次
        canvas.width = canvas.height = 0;
        var lower = Math.max(60, Math.round(dpi * 0.72));
        canvas = await renderPage(pdf, meta, lower);
        res = await encodeWithin(canvas, budget, 3);
      }
      canvas.width = canvas.height = 0;

      var buf = new Uint8Array(await res.blob.arrayBuffer());
      parts.push({ bytes: buf, w: meta.w, h: meta.h });
      produced += buf.length;
      if (res.over) shorts++;

      report(
        bandStart + Math.round(((k + 1) / n) * (bandEnd - bandStart)),
        (attempt ? '第 ' + (attempt + 1) + ' 轮 · ' : '') + '重绘第 ' + (k + 1) + '/' + n +
          ' 页 · 质量 ' + res.q.toFixed(2)
      );
    }

    return { parts: parts, total: produced, shorts: shorts };
  }

  async function rasterize(bytes, targetBytes, opts, onProgress) {
    var report = function (p, t) { if (onProgress) onProgress(p, t); };
    var pdf = await open(bytes);

    try {
      var n = pdf.numPages;
      var metas = [];
      var areaPt = 0;
      for (var i = 1; i <= n; i++) {
        var page = await pdf.getPage(i);
        var vp = page.getViewport({ scale: 1 });
        metas.push({ index: i, w: vp.width, h: vp.height });
        areaPt += vp.width * vp.height;
        page.cleanup();
      }

      var dpi = 150;
      var MAX_TOTAL_PX = 30e6;
      var totalPx = areaPt * Math.pow(dpi / 72, 2);
      if (totalPx > MAX_TOTAL_PX) {
        dpi = Math.max(72, Math.round(dpi * Math.sqrt(MAX_TOTAL_PX / totalPx)));
      }

      var best = null;
      var rounds = 0;
      // 单页都压到质量下限还不够时，整体再降 DPI 重来，最多三轮
      for (var attempt = 0; attempt < 3; attempt++) {
        rounds = attempt + 1;
        var pass = await rasterPass(pdf, metas, dpi, targetBytes, attempt, report);
        if (!best || pass.total < best.total) best = { parts: pass.parts, total: pass.total, dpi: dpi, shorts: pass.shorts };
        if (pass.total <= targetBytes || dpi <= 60) break;
        dpi = Math.max(60, Math.round(dpi * 0.7));
        report(58 + attempt * 8, '整体仍超标，降到 ' + dpi + ' DPI 重试 …');
      }

      report(92, '重新封装 PDF …');
      var out = await build(best.parts);
      report(100, '完成');

      return {
        bytes: out,
        met: out.length <= targetBytes,
        mode: 'raster',
        pages: n,
        detail: '重绘 ' + n + ' 页 · ' + best.dpi + ' DPI · JPEG' +
          (rounds > 1 ? ' · 降 DPI 重试 ' + (rounds - 1) + ' 次' : '') +
          (best.shorts ? ' · ' + best.shorts + ' 页受限于下限' : '')
      };
    } finally {
      try { pdf.destroy(); } catch (e) { /* ignore */ }
    }
  }

  async function build(parts) {
    var L = libs();
    var doc = await L.PDFLib.PDFDocument.create();
    doc.setProducer('图片压缩');
    doc.setCreator('图片压缩 · 本地处理');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var img = await doc.embedJpg(p.bytes);
      var page = doc.addPage([p.w, p.h]);
      page.drawImage(img, { x: 0, y: 0, width: p.w, height: p.h });
    }
    return await doc.save({ useObjectStreams: true });
  }

  /**
   * @param {File} file
   * @param {number} target
   * @param {{pdfMode:'smart'|'structure'|'raster'}} opts
   */
  /* 加密 PDF 的关键字探测（/Encrypt 一定出现在文件尾部 xref 段） */
  function looksEncrypted(bytes) {
    var needle = [0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // Encrypt
    var limit = bytes.length - needle.length;
    for (var i = 0; i < limit; i++) {
      if (bytes[i] !== 0x2f) continue; // '/'
      var hit = true;
      for (var j = 0; j < needle.length; j++) {
        if (bytes[i + 1 + j] !== needle[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  async function compress(file, target, opts, onProgress) {
    var report = function (p, t) { if (onProgress) onProgress(p, t); };
    var bytes = new Uint8Array(await file.arrayBuffer());

    report(3, '读取文件 …');

    if (looksEncrypted(bytes)) {
      throw new Error('该 PDF 已加密，请先解除密码保护再压缩');
    }

    var struct = null;
    if (opts.pdfMode !== 'raster') {
      try {
        report(6, '无损结构优化 …');
        struct = await structuralSave(bytes);
      } catch (e) {
        if (opts.pdfMode === 'structure') throw new Error('无法解析该 PDF：' + friendly(e));
      }
    }

    if (opts.pdfMode === 'structure') {
      if (!struct) throw new Error('无法读取该 PDF');
      return {
        bytes: struct, met: struct.length <= target, mode: 'structure',
        detail: '无损结构优化（对象流重排）'
      };
    }

    if (struct && struct.length <= target && opts.pdfMode !== 'raster') {
      report(100, '完成');
      return { bytes: struct, met: true, mode: 'structure', detail: '无损结构优化（未损失画质）' };
    }

    var best = struct;
    var bestMode = 'structure';
    var bestDetail = '无损结构优化';

    try {
      var r = await rasterize(bytes, target, opts, function (p, t) { report(Math.min(99, Math.round(p * 0.92) + 8), t); });
      if (!best || r.bytes.length < best.length) {
        best = r.bytes;
        bestMode = 'raster';
        bestDetail = r.detail;
      }
      if (r.met) { best = r.bytes; bestMode = 'raster'; bestDetail = r.detail; }
    } catch (e) {
      if (!best) throw e;
      bestDetail += ' · 重绘失败：' + friendly(e);
    }

    // 都不如原文件时，保留原文件
    if (best && best.length >= bytes.length) {
      return {
        bytes: bytes,
        met: bytes.length <= target,
        mode: 'original',
        detail: '该 PDF 以矢量文字为主，压缩后反而更大，已保留原文件'
      };
    }

    return { bytes: best, met: best.length <= target, mode: bestMode, detail: bestDetail };
  }

  /* 列表缩略图 */
  async function thumbnail(bytes, maxW) {
    var pdf = await open(bytes);
    try {
      var page = await pdf.getPage(1);
      var vp0 = page.getViewport({ scale: 1 });
      var s = (maxW || 160) / vp0.width;
      var vp = page.getViewport({ scale: s });
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
      page.cleanup();
      return canvas.toDataURL('image/jpeg', 0.8);
    } finally {
      try { pdf.destroy(); } catch (e) { /* ignore */ }
    }
  }

  async function pageCount(bytes) {
    var pdf = await open(bytes);
    try { return pdf.numPages; } finally { try { pdf.destroy(); } catch (e) {} }
  }

  global.PdfCompressor = {
    compress: compress,
    thumbnail: thumbnail,
    pageCount: pageCount
  };
})(window);
