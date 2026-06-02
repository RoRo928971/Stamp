/* PDF捺印アプリ — クライアントサイドのみで動作 */
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
    defaultSize: 120,      // 新規捺印の基準サイズ(表示px)
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

  // ============ PDF 取り込み ============
  pdfDrop.addEventListener("click", () => pdfInput.click());
  pdfInput.addEventListener("change", (e) => {
    if (e.target.files[0]) loadPdf(e.target.files[0]);
  });
  setupDrop(pdfDrop, (file) => {
    if (file.type === "application/pdf") loadPdf(file);
    else toast("PDFファイルを選択してください");
  });

  async function loadPdf(file) {
    try {
      const buf = await file.arrayBuffer();
      state.pdfBytes = new Uint8Array(buf);
      state.pdfName = file.name.replace(/\.pdf$/i, "") + "_捺印済み.pdf";
      pdfNameEl.textContent = file.name;
      // 既存の捺印をリセット
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

  // ============ 印鑑の準備 ============
  // タブ切り替え
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("tab--active"));
      tab.classList.add("tab--active");
      $("tab-generate").classList.toggle("hidden", tab.dataset.tab !== "generate");
      $("tab-upload").classList.toggle("hidden", tab.dataset.tab !== "upload");
    });
  });

  // 電子印鑑の生成
  $("makeStampBtn").addEventListener("click", () => {
    const text = $("stampText").value.trim() || "印";
    const shape = $("stampShape").value;
    const color = $("stampColor").value;
    const dataUrl = generateStampImage(text, shape, color);
    setStamp({ dataUrl, type: "png", aspect: 1 });
    toast("電子印鑑を設定しました");
  });

  // キャンバスに印影を描画して dataURL を返す
  function generateStampImage(text, shape, color) {
    const S = 400;            // 解像度
    const canvas = document.createElement("canvas");
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, S, S);

    const lineWidth = S * 0.05;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;

    // 枠
    const m = lineWidth; // margin
    if (shape === "circle") {
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, S / 2 - m, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const r = S * 0.06;
      roundRect(ctx, m, m, S - 2 * m, S - 2 * m, r);
      ctx.stroke();
    }

    // 文字レイアウト（縦書き風：1〜4文字を縦/格子に配置）
    const chars = Array.from(text).slice(0, 4);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const inner = S * 0.62;
    const startX = S / 2;

    if (chars.length === 1) {
      ctx.font = `bold ${inner * 0.95}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
      ctx.fillText(chars[0], S / 2, S / 2 + inner * 0.02);
    } else if (chars.length === 2) {
      ctx.font = `bold ${inner * 0.55}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
      ctx.fillText(chars[0], startX, S / 2 - inner * 0.25);
      ctx.fillText(chars[1], startX, S / 2 + inner * 0.25);
    } else {
      // 3〜4文字：2x2 グリッド
      ctx.font = `bold ${inner * 0.42}px "Hiragino Mincho ProN", "Yu Mincho", serif`;
      const off = inner * 0.26;
      const pos = [
        [S / 2 - off, S / 2 - off],
        [S / 2 + off, S / 2 - off],
        [S / 2 - off, S / 2 + off],
        [S / 2 + off, S / 2 + off],
      ];
      // 縦書き順(右上→右下→左上...)に近づけるため並べ替え
      const order = chars.length === 3 ? [1, 3, 0] : [1, 3, 0, 2];
      chars.forEach((c, idx) => {
        const p = pos[order[idx]];
        ctx.fillText(c, p[0], p[1]);
      });
    }
    return canvas.toDataURL("image/png");
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 画像アップロード
  $("imgInput").addEventListener("change", (e) => {
    if (e.target.files[0]) loadStampImage(e.target.files[0]);
  });
  $("imgDrop").addEventListener("click", () => $("imgInput").click());
  setupDrop($("imgDrop"), (file) => {
    if (/^image\/(png|jpeg)$/.test(file.type)) loadStampImage(file);
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
        toast("印鑑画像を設定しました");
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

  // ============ 捺印（配置） ============
  function onPageClick(e) {
    // 既存の印鑑をクリックした場合は配置しない
    if (e.target.closest(".placed-stamp")) return;
    if (!state.stamp) {
      toast("先に印鑑を準備してください");
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
    removeBtn.title = "この捺印を削除";
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

  // ============ 保存（捺印を焼き込み） ============
  downloadBtn.addEventListener("click", saveStampedPdf);

  async function saveStampedPdf() {
    if (!state.pdfBytes || state.placements.length === 0) return;
    downloadBtn.disabled = true;
    downloadBtn.textContent = "生成中...";
    try {
      const pdfDoc = await PDFDocument.load(state.pdfBytes);
      const pages = pdfDoc.getPages();

      // 印鑑画像をキャッシュ（同一dataUrlは1回だけ埋め込む）
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
      toast("捺印済みPDFを保存しました");
    } catch (err) {
      console.error(err);
      toast("PDFの生成に失敗しました");
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = "捺印済みPDFをダウンロード";
    }
  }

  // 視覚座標(左上原点・y下向き・pt) → pdf-lib drawImage 用パラメータ
  // ページ回転 r (0/90/180/270) を考慮して、印影が常に正立するよう配置する
  function computePlacement(r, uw, uh, vx, vy, sw, sh) {
    // 印影の「視覚的な左下隅」の視覚座標
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
  sizeOut.textContent = sizeRange.value;
  setButtonsState();
})();
