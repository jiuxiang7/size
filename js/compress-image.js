/* 图片压缩引擎：固定质量下用「像素数 ≈ 字节数」的比例关系快速逼近尺寸，再二分质量把画质拉回来。 */
(function (global) {
  'use strict';

  var WEBP_OK = (function () {
    try {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { return false; }
  })();

  function decode(file) {
    return (async function () {
      if (global.createImageBitmap) {
        var opts = [{ imageOrientation: 'from-image' }, undefined];
        for (var i = 0; i < opts.length; i++) {
          try {
            var bmp = await createImageBitmap(file, opts[i]);
            if (bmp.width && bmp.height) {
              return {
                source: bmp, width: bmp.width, height: bmp.height,
                close: function () { if (bmp.close) bmp.close(); }
              };
            }
          } catch (e) { /* 换下一种方式 */ }
        }
      }
      var url = URL.createObjectURL(file);
      try {
        var img = new Image();
        img.src = url;
        if (img.decode) { await img.decode(); }
        else {
          await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; });
        }
        if (!img.naturalWidth) throw new Error('empty');
        return {
          source: img, width: img.naturalWidth, height: img.naturalHeight,
          close: function () { URL.revokeObjectURL(url); }
        };
      } catch (e) {
        URL.revokeObjectURL(url);
        throw new Error('无法解码该图片，可能是浏览器不支持的格式');
      }
    })();
  }

  function detectAlpha(source, w, h) {
    try {
      var side = 48;
      var s = Math.min(side / w, side / h, 1);
      var cw = Math.max(1, Math.round(w * s));
      var ch = Math.max(1, Math.round(h * s));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(source, 0, 0, cw, ch);
      var data = ctx.getImageData(0, 0, cw, ch).data;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return true;
      }
      canvas.width = canvas.height = 0;
      return false;
    } catch (e) { return false; }
  }

  function pickType(format, hasAlpha) {
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'png') return 'image/png';
    if (format === 'webp') return WEBP_OK ? 'image/webp' : 'image/jpeg';
    return hasAlpha ? (WEBP_OK ? 'image/webp' : 'image/png') : 'image/jpeg';
  }

  function encode(source, srcW, srcH, scale, type, quality) {
    return new Promise(function (resolve, reject) {
      var w = Math.max(1, Math.round(srcW * scale));
      var h = Math.max(1, Math.round(srcH * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, w, h);
      var done = function (blob) {
        canvas.width = canvas.height = 0;
        if (!blob) { reject(new Error('图片编码失败')); return; }
        blob._w = w; blob._h = h;
        resolve(blob);
      };
      if (canvas.toBlob) canvas.toBlob(done, type, quality);
      else {
        try {
          var dataUrl = canvas.toDataURL(type, quality);
          var bin = atob(dataUrl.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          done(new Blob([arr], { type: type }));
        } catch (err) { reject(err); }
      }
    });
  }

  /**
   * @param {File} file
   * @param {number} target 目标字节数
   * @param {{format:string, allowResize:boolean}} opts
   * @param {(pct:number, text:string)=>void} onProgress
   */
  async function compress(file, target, opts, onProgress) {
    var decoded = await decode(file);
    try {
      var W = decoded.width, H = decoded.height;
      if (!W || !H) throw new Error('图片尺寸异常，无法处理');

      var hasAlpha = detectAlpha(decoded.source, W, H);
      var type = pickType(opts.format, hasAlpha);
      var minScale = opts.allowResize ? 0.1 : 1;
      var report = function (p, t) { if (onProgress) onProgress(p, t); };

      if (type === 'image/png') {
        return await pngSearch(decoded, W, H, target, minScale, report);
      }
      return await lossySearch(decoded, W, H, target, minScale, type, report);
    } finally {
      decoded.close();
    }
  }

  async function lossySearch(decoded, W, H, target, minScale, type, report) {
    var scale = 1;
    var q = 0.82;
    var upper = 0.985; // 当前分辨率下已知装不下的质量上限
    var steps = 0;

    report(8, '首次编码');
    var blob = await encode(decoded.source, W, H, scale, type, q);

    // 小幅超标时先让质量让步，尽量保住像素
    if (blob.size > target) {
      upper = q;
      var probes = [0.72, 0.62];
      for (var p = 0; p < probes.length; p++) {
        report(10 + p * 5, '尝试质量 ' + probes[p]);
        var probe = await encode(decoded.source, W, H, scale, type, probes[p]);
        if (probe.size <= target) { blob = probe; q = probes[p]; break; }
        upper = Math.min(upper, probes[p]);
        q = probes[p];
        blob = probe;
      }
    }

    // 仍然超标 → 按「体积 ≈ 像素数」的比例缩分辨率
    while (blob.size > target && scale > minScale && steps++ < 6) {
      var factor = Math.sqrt(target / blob.size) * 0.97;
      factor = Math.max(0.25, Math.min(0.9, factor));
      scale = Math.max(minScale, scale * factor);
      report(Math.min(88, 20 + steps * 11), '第 ' + steps + ' 轮：缩至 ' +
        Math.round(scale * 100) + '% 并重新编码');
      blob = await encode(decoded.source, W, H, scale, type, q);
      upper = 0.985;
      if (scale <= minScale) break;
    }

    // 已达标的低分辨率结果：在质量下限约束下二分出「能放下的最大分辨率」
    if (blob.size <= target && scale < 0.999) {
      var QF = 0.58;
      var loS = scale, hiS = 1;
      for (var k = 0; k < 4; k++) {
        var midS = (loS + hiS) / 2;
        if (midS - loS < 0.02) break;
        report(92, '换回分辨率 ' + Math.round(midS * 100) + '%');
        var b2 = await encode(decoded.source, W, H, midS, type, QF);
        if (b2.size <= target) { scale = midS; blob = b2; q = QF; loS = midS; }
        else hiS = midS;
      }
      upper = 0.985;
    }

    // 已达标 → 二分把质量尽量拉回
    if (blob.size <= target && upper - q > 0.02) {
      var lo = q, hi = upper, best = blob, bestQ = q;
      for (var i = 0; i < 4; i++) {
        var mid = (lo + hi) / 2;
        if (hi - lo < 0.02) break;
        report(90 + i * 2, '微调画质 …');
        var t = await encode(decoded.source, W, H, scale, type, mid);
        if (t.size <= target) { best = t; bestQ = mid; lo = mid; }
        else hi = mid;
      }
      blob = best; q = bestQ;
    }

    // 分辨率已到下限仍超标 → 继续压质量
    var guard = 0;
    while (blob.size > target && q > 0.42 && guard++ < 5) {
      q = Math.max(0.4, q - 0.1);
      report(96, '降至质量 ' + q.toFixed(2));
      blob = await encode(decoded.source, W, H, scale, type, q);
    }

    var ext = type === 'image/webp' ? 'webp' : 'jpg';
    return {
      blob: blob,
      width: blob._w,
      height: blob._h,
      type: type,
      ext: ext,
      quality: q,
      scale: scale,
      met: blob.size <= target,
      detail: describe(type, q, blob._w, blob._h)
    };
  }

  async function pngSearch(decoded, W, H, target, minScale, report) {
    var lo = minScale, hi = 1, best = null, bestScale = minScale;
    report(10, 'PNG 只能靠降低分辨率，正在搜索 …');
    for (var i = 0; i < 6; i++) {
      var mid = (lo + hi) / 2;
      var b = await encode(decoded.source, W, H, mid, 'image/png', 1);
      report(20 + i * 13, '尝试分辨率 ' + Math.round(mid * 100) + '%');
      if (b.size <= target) { best = b; bestScale = mid; lo = mid; }
      else hi = mid;
    }
    if (!best) {
      best = await encode(decoded.source, W, H, minScale, 'image/png', 1);
    }
    return {
      blob: best,
      width: best._w,
      height: best._h,
      type: 'image/png',
      ext: 'png',
      quality: null,
      scale: bestScale,
      met: best.size <= target,
      detail: 'PNG 无损 · ' + best._w + '×' + best._h
    };
  }

  function describe(type, q, w, h) {
    var fmt = type === 'image/webp' ? 'WebP' : type === 'image/jpeg' ? 'JPEG' : 'PNG';
    return fmt + ' · 质量 ' + q.toFixed(2) + ' · ' + w + '×' + h;
  }

  global.ImageCompressor = {
    compress: compress,
    decode: decode,
    webpSupported: WEBP_OK
  };
})(window);
