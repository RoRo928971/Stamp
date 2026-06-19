/* PDFサインアプリ — クライアントサイドのみで動作 */
(() => {
  "use strict";

  // pdf.js worker
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const { PDFDocument, degrees } = PDFLib;

  // ---- アプリの状態 ----
  const state = {
    pdfBytes: null,        // 元PDFのバイト列 (Uint8Array)
    pdfName: "stamped.pdf",
    pageScales: [],        // ページごとの描画倍率 renderScale
    stamp: null,           // { dataUrl, type:'png'|'jpg', aspect:w/h }
    placements: [],        // { id, pageIndex, vx, vy, sw, sh, el } 視覚座標(pt, 左上原点, y下向き)
    defaultSize: 160,      // 新規サインの基準サイズ(表示px, 幅)
    selectedId: null,
    nextId: 1,
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const pdfInput = $("pdfInput");
  const pdfDrop = $("pdfDrop");
  const pdfNameEl = $("pdfName");
  const pagesEl = $("pages");
  const viewerPlaceholder = $("viewerPlaceholder");
  const stampPreview = $("stampPreview");
  const sizeRange = $("sizeRange");
  const sizeOut = $("sizeOut");
  const undoBtn = $("undoBtn");
  const clearBtn = $("clearBtn");
  const downloadBtn = $("downloadBtn");
  const toastEl = $("toast");

  // ---- ユーティリティ ----
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function setButtonsState() {
    const hasStamps = state.placements.length > 0;
    undoBtn.disabled = !hasStamps;
    clearBtn.disabled = !hasStamps;
    downloadBtn.disabled = !state.pdfBytes || !hasStamps;
  }

  // ファイル種別の判定（モバイルやクラウド経由で MIME が空/不正な場合は拡張子で判定）
  const isPdf = (file) =>
    file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isStampImage = (file) =>
    /^image\/(png|jpe?g)$/.test(file.type) || /\.(png|jpe?g)$/i.test(file.name);

  // ============ PDF 取り込み ============
  pdfDrop.addEventListener("click", () => pdfInput.click());
  pdfInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadPdf(file);
    e.target.value = ""; // 同じファイルを再選択できるようにリセット
  });
  setupDrop(pdfDrop, (file) => {
    if (isPdf(file)) loadPdf(file);
    else toast("PDFファイルを選択してください");
  });

  async function loadPdf(file) {
    try {
      const buf = await file.arrayBuffer();
      state.pdfBytes = new Uint8Array(buf);
      state.pdfName = file.name.replace(/\.pdf$/i, "") + "_サイン済み.pdf";
      pdfNameEl.textContent = file.name;
      // 既存のサインをリセット
      state.placements = [];
      state.selectedId = null;
      await renderAllPages();
      setButtonsState();
      toast("PDFを読み込みました");
    } catch (err) {
      console.error(err);
      toast("PDFの読み込みに失敗しました");
    }
  }

  async function renderAllPages() {
    pagesEl.innerHTML = "";
    state.pageScales = [];
    // pdf.js は読み込みでバイト列を消費するのでコピーを渡す
    const doc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
    viewerPlaceholder.style.display = "none";

    const targetWidth = Math.min(900, pagesEl.clientWidth || 900);

    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderScale = Math.min(2, targetWidth / baseViewport.width);
      state.pageScales[i - 1] = renderScale;

      const viewport = page.getViewport({ scale: renderScale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);

      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      wrap.style.width = canvas.width + "px";
      wrap.style.height = canvas.height + "px";
      wrap.dataset.pageIndex = String(i - 1);
      wrap.appendChild(canvas);
      pagesEl.appendChild(wrap);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

      wrap.addEventListener("click", onPageClick);
    }
  }

  // ============ サインの準備 ============
  // タブ切り替え
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("tab--active"));
      tab.classList.add("tab--active");
      $("tab-draw").classList.toggle("hidden", tab.dataset.tab !== "draw");
      $("tab-upload").classList.toggle("hidden", tab.dataset.tab !== "upload");
    });
  });

  // ---- 手書きサインパッド ----
  const pad = $("signPad");
  const pctx = pad.getContext("2d");
  pctx.lineCap = "round";
  pctx.lineJoin = "round";
  let padDrawing = false;
  let padHasInk = false;
  let lastX = 0, lastY = 0;

  // ポインタ座標 → キャンバス内部座標
  function padPos(e) {
    const r = pad.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (pad.width / r.width),
      y: (e.clientY - r.top) * (pad.height / r.height),
      scale: pad.width / r.width,
    };
  }

  pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    padDrawing = true;
    pad.setPointerCapture(e.pointerId);
    const p = padPos(e);
    lastX = p.x;
    lastY = p.y;
    pctx.strokeStyle = $("penColor").value;
    pctx.lineWidth = Number($("penWidth").value) * p.scale;
    // 点だけ打った場合でも見えるように小さな円を描く
    pctx.beginPath();
    pctx.arc(p.x, p.y, pctx.lineWidth / 2, 0, Math.PI * 2);
    pctx.fillStyle = $("penColor").value;
    pctx.fill();
    padHasInk = true;
  });

  pad.addEventListener("pointermove", (e) => {
    if (!padDrawing) return;
    const p = padPos(e);
    pctx.beginPath();
    pctx.moveTo(lastX, lastY);
    pctx.lineTo(p.x, p.y);
    pctx.stroke();
    lastX = p.x;
    lastY = p.y;
  });

  const endStroke = () => { padDrawing = false; };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);
  pad.addEventListener("pointerleave", endStroke);

  $("clearPadBtn").addEventListener("click", () => {
    pctx.clearRect(0, 0, pad.width, pad.height);
    padHasInk = false;
  });

  $("useSignBtn").addEventListener("click", () => {
    if (!padHasInk) {
      toast("枠内にサインを書いてください");
      return;
    }
    const trimmed = trimCanvas(pad);
    if (!trimmed) {
      toast("枠内にサインを書いてください");
      return;
    }
    setStamp({
      dataUrl: trimmed.dataUrl,
      type: "png",
      aspect: trimmed.width / trimmed.height,
    });
    toast("サインを設定しました");
  });

  // 描画部分の余白を取り除いて切り出す（透明部分を除外）
  function trimCanvas(srcCanvas) {
    const w = srcCanvas.width, h = srcCanvas.height;
    const data = srcCanvas.getContext("2d").getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 8) { // alpha
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // 何も描かれていない
    const pad = 8;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    out.getContext("2d").drawImage(srcCanvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return { dataUrl: out.toDataURL("image/png"), width: cw, height: ch };
  }

  // 画像アップロード
  $("imgInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadStampImage(file);
    e.target.value = "";
  });
  $("imgDrop").addEventListener("click", () => $("imgInput").click());
  setupDrop($("imgDrop"), (file) => {
    if (isStampImage(file)) loadStampImage(file);
    else toast("PNGまたはJPG画像を選択してください");
  });

  function loadStampImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        setStamp({
          dataUrl: reader.result,
          type: file.type === "image/png" ? "png" : "jpg",
          aspect: img.width / img.height,
        });
        toast("サイン画像を設定しました");
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function setStamp(stamp) {
    state.stamp = stamp;
    stampPreview.innerHTML = "";
    const img = new Image();
    img.src = stamp.dataUrl;
    stampPreview.appendChild(img);
  }

  // ============ サイン（配置） ============
  function onPageClick(e) {
    // 既存のサインをクリックした場合は配置しない
    if (e.target.closest(".placed-stamp")) return;
    if (!state.stamp) {
      toast("先にサインを準備してください");
      return;
    }
    const wrap = e.currentTarget;
    const rect = wrap.getBoundingClientRect();
    const pageIndex = Number(wrap.dataset.pageIndex);

    const w = state.defaultSize;
    const h = w / (state.stamp.aspect || 1);
    // クリック位置を中心に配置（表示px, page-wrap基準）
    const left = e.clientX - rect.left - w / 2;
    const top = e.clientY - rect.top - h / 2;

    addPlacement(pageIndex, left, top, w, h, wrap);
  }

  function addPlacement(pageIndex, leftPx, topPx, wPx, hPx, wrap) {
    const scale = state.pageScales[pageIndex];
    const id = state.nextId++;

    const el = document.createElement("div");
    el.className = "placed-stamp";
    el.style.left = leftPx + "px";
    el.style.top = topPx + "px";
    el.style.width = wPx + "px";
    el.style.height = hPx + "px";

    const img = new Image();
    img.src = state.stamp.dataUrl;
    el.appendChild(img);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "このサインを削除";
    el.appendChild(removeBtn);

    wrap.appendChild(el);

    const placement = {
      id,
      pageIndex,
      // 視覚座標(pt) = 表示px / renderScale
      vx: leftPx / scale,
      vy: topPx / scale,
      sw: wPx / scale,
      sh: hPx / scale,
      el,
    };
    state.placements.push(placement);

    removeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removePlacement(id);
    });
    enableDrag(el, placement);
    selectPlacement(id);

    setButtonsState();
  }

  function selectPlacement(id) {
    state.selectedId = id;
    state.placements.forEach((p) => p.el.classList.toggle("selected", p.id === id));
    const p = state.placements.find((x) => x.id === id);
    if (p) {
      const scale = state.pageScales[p.pageIndex];
      state.defaultSize = p.sw * scale;
      sizeRange.value = Math.round(state.defaultSize);
      sizeOut.textContent = Math.round(state.defaultSize);
    }
  }

  function removePlacement(id) {
    const idx = state.placements.findIndex((p) => p.id === id);
    if (idx >= 0) {
      state.placements[idx].el.remove();
      state.placements.splice(idx, 1);
      if (state.selectedId === id) state.selectedId = null;
      setButtonsState();
    }
  }

  // ドラッグで移動
  function enableDrag(el, placement) {
    let startX, startY, origLeft, origTop;

    el.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("remove-btn")) return;
      e.preventDefault();
      selectPlacement(placement.id);
      startX = e.clientX;
      startY = e.clientY;
      origLeft = parseFloat(el.style.left);
      origTop = parseFloat(el.style.top);
      el.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const nl = origLeft + (ev.clientX - startX);
        const nt = origTop + (ev.clientY - startY);
        el.style.left = nl + "px";
        el.style.top = nt + "px";
      };
      const onUp = () => {
        el.releasePointerCapture(e.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        const scale = state.pageScales[placement.pageIndex];
        placement.vx = parseFloat(el.style.left) / scale;
        placement.vy = parseFloat(el.style.top) / scale;
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  }

  // サイズ調整（選択中があればそれを、なければ既定値を変更）
  sizeRange.addEventListener("input", () => {
    const size = Number(sizeRange.value);
    sizeOut.textContent = size;
    state.defaultSize = size;
    const p = state.placements.find((x) => x.id === state.selectedId);
    if (p) {
      const scale = state.pageScales[p.pageIndex];
      const aspect = (p.sw / p.sh) || 1;
      const wPx = size;
      const hPx = size / aspect;
      p.el.style.width = wPx + "px";
      p.el.style.height = hPx + "px";
      p.sw = wPx / scale;
      p.sh = hPx / scale;
    }
  });

  // 取り消し / 全消去
  undoBtn.addEventListener("click", () => {
    const last = state.placements[state.placements.length - 1];
    if (last) removePlacement(last.id);
  });
  clearBtn.addEventListener("click", () => {
    state.placements.slice().forEach((p) => removePlacement(p.id));
  });

  // ============ 保存（サインを焼き込み） ============
  downloadBtn.addEventListener("click", saveStampedPdf);

  async function saveStampedPdf() {
    if (!state.pdfBytes || state.placements.length === 0) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "生成中...";
    try {
      const pdfDoc = await PDFDocument.load(state.pdfBytes);
      const pages = pdfDoc.getPages();

      // サイン画像をキャッシュ（同一dataUrlは1回だけ埋め込む）
      const embedCache = new Map();
      async function embed(dataUrl, type) {
        if (embedCache.has(dataUrl)) return embedCache.get(dataUrl);
        const img = type === "jpg"
          ? await pdfDoc.embedJpg(dataUrl)
          : await pdfDoc.embedPng(dataUrl);
        embedCache.set(dataUrl, img);
        return img;
      }

      for (const p of state.placements) {
        const page = pages[p.pageIndex];
        if (!page) continue;
        const { width: uw, height: uh } = page.getSize();
        const r = ((page.getRotation().angle % 360) + 360) % 360;
        const image = await embed(state.stamp.dataUrl, state.stamp.type);
        const plc = computePlacement(r, uw, uh, p.vx, p.vy, p.sw, p.sh);
        page.drawImage(image, {
          x: plc.x,
          y: plc.y,
          width: plc.width,
          height: plc.height,
          rotate: degrees(plc.rotate),
        });
      }

      const bytes = await pdfDoc.save();
      downloadBlob(new Blob([bytes], { type: "application/pdf" }), state.pdfName);
      toast("サイン済みPDFを保存しました");
    } catch (err) {
      console.error(err);
      toast("PDFの生成に失敗しました");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "サイン済みPDFをダウンロード";
    }
  }

  // 視覚座標(左上原点・y下向き・pt) → pdf-lib drawImage 用パラメータ
  // ページ回転 r (0/90/180/270) を考慮して、サインが常に正立するよう配置する
  function computePlacement(r, uw, uh, vx, vy, sw, sh) {
    // サインの「視覚的な左下隅」の視覚座標
    const bx = vx;
    const by = vy + sh;
    let x, y;
    switch (r) {
      case 90:
        x = by;       y = bx;            break;
      case 180:
        x = uw - bx;  y = by;            break;
      case 270:
        x = uw - by;  y = uh - bx;       break;
      default: // 0
        x = bx;       y = uh - by;       break;
    }
    return { x, y, width: sw, height: sh, rotate: r };
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ============ 共通: ドラッグ&ドロップ ============
  function setupDrop(el, onFile) {
    ["dragenter", "dragover"].forEach((ev) =>
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        el.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((ev) =>
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        el.classList.remove("dragover");
      })
    );
    el.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  // 背景クリックで選択解除
  pagesEl.addEventListener("click", (e) => {
    if (e.target === pagesEl) {
      state.selectedId = null;
      state.placements.forEach((p) => p.el.classList.remove("selected"));
    }
  });

  // 初期化
  state.defaultSize = Number(sizeRange.value);
  sizeOut.textContent = sizeRange.value;
  setButtonsState();
})();
