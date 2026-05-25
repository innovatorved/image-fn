document.addEventListener("DOMContentLoaded", () => {
  const IMAGE_PATH = "/i";
  const RECENT_KEY = "imagefn.recentTransforms.v1";
  const MAX_RECENT = 8;
  const MAX_OUTPUT_PIXELS = 41943040;

  let requestSeq = 0;
  let sourcePreviewTimer = 0;
  let lastPreviewSize = null;

  const imageUrlInput = document.getElementById("image-url");
  const urlSourceNote = document.getElementById("url-source-note");
  const sourceSizeText = document.getElementById("source-size");
  const outputSizeText = document.getElementById("output-size");

  const resizeW = document.getElementById("resize-w");
  const resizeH = document.getElementById("resize-h");
  const resizeFit = document.getElementById("resize-fit");
  const rotateSelect = document.getElementById("rotate");
  const outputFmt = document.getElementById("output-fmt");
  const qualityInput = document.getElementById("quality");
  const qualityVal = document.getElementById("quality-val");
  const qualityGroup = document.getElementById("quality-group");

  const btnApply = document.getElementById("btn-apply");
  const previewStage = document.getElementById("preview-stage");
  const previewFrame = document.getElementById("preview-frame");
  const previewImage = document.getElementById("preview-image");
  const previewLoading = document.getElementById("preview-loading");
  const emptyState = document.getElementById("empty-state");
  const metadataHud = document.getElementById("metadata-hud");
  const hudFormat = document.getElementById("hud-format");
  const hudDimensions = document.getElementById("hud-dimensions");
  const hudSize = document.getElementById("hud-size");
  const hudCache = document.getElementById("hud-cache");
  const shareUrlInput = document.getElementById("share-url");
  const shareEditorInput = document.getElementById("share-editor-url");
  const btnCopyUrl = document.getElementById("btn-copy-url");
  const btnCopyEditor = document.getElementById("btn-copy-editor");
  const btnDownload = document.getElementById("btn-download");
  const recentLinks = document.getElementById("recent-links");
  const recentList = document.getElementById("recent-list");
  const btnClearRecent = document.getElementById("btn-clear-recent");

  qualityInput.addEventListener("input", () => {
    qualityVal.textContent = qualityInput.value;
  });

  outputFmt.addEventListener("change", () => {
    const isPng = outputFmt.value === "png";
    qualityGroup.style.opacity = isPng ? "0.4" : "1";
    qualityInput.disabled = isPng;
  });

  imageUrlInput.addEventListener("input", () => {
    window.clearTimeout(sourcePreviewTimer);
    sourcePreviewTimer = window.setTimeout(() => previewUrlSource(false), 450);
  });
  imageUrlInput.addEventListener("change", () => previewUrlSource(true));
  window.addEventListener("resize", () => {
    if (lastPreviewSize) {
      setPreviewFrameSize(lastPreviewSize.width, lastPreviewSize.height);
      return;
    }
    const outputSize = currentOutputSize();
    setPreviewFrameSize(outputSize.width, outputSize.height);
  });

  btnApply.addEventListener("click", () => applyPreview(true));

  function getSourceUrl() {
    return imageUrlInput.value.trim();
  }

  function buildTransformParams() {
    const sourceUrl = getSourceUrl();
    if (!sourceUrl) return null;
    if (sourceUrl.startsWith("blob:")) return null;

    const params = new URLSearchParams();
    params.set("url", sourceUrl);

    const w = resizeW.value.trim();
    const h = resizeH.value.trim();
    if (w) params.set("w", w);
    if (h) params.set("h", h);
    if (w || h) params.set("fit", resizeFit.value);

    if (rotateSelect.value !== "0") params.set("rot", rotateSelect.value);
    params.set("fmt", outputFmt.value);
    if (outputFmt.value !== "png") params.set("q", qualityInput.value);

    return params;
  }

  function updateShareLinks(params) {
    const qs = params.toString();
    const imageUrl = `${window.location.origin}${IMAGE_PATH}?${qs}`;
    const editorUrl = `${window.location.origin}/?${qs}`;
    shareUrlInput.value = imageUrl;
    if (shareEditorInput) shareEditorInput.value = editorUrl;
    btnDownload.href = `${IMAGE_PATH}?${qs}`;
    btnDownload.download = buildDownloadFilename(params);
    saveRecentLink(params, imageUrl, editorUrl);
  }

  function buildDownloadFilename(params) {
    const base = extractBaseName(params.get("url") || "");
    const tags = [];

    const w = params.get("w");
    const h = params.get("h");
    if (w && h) tags.push(`w${w}-h${h}`);
    else if (w) tags.push(`w${w}`);
    else if (h) tags.push(`h${h}`);

    if (w || h) {
      tags.push(fitLabel(params.get("fit") || "pad"));
    }
    const rot = params.get("rot");
    if (rot) tags.push(`rot${rot}`);
    if (params.get("flip") === "true") tags.push("flip");
    if (params.get("flop") === "true") tags.push("flop");
    if (params.get("withoutEnlargement") === "true") tags.push("no-upscale");

    const fmt = params.get("fmt") || "webp";
    const q = params.get("q");
    if (fmt !== "png" && q && q !== "80") tags.push(`q${q}`);

    const brightness = params.get("brightness");
    if (brightness) tags.push(`b${formatModulationTag(Number(brightness))}`);
    const saturation = params.get("saturation");
    if (saturation) tags.push(`s${formatModulationTag(Number(saturation))}`);

    const suffix = tags.length > 0 ? `-${tags.join("-")}` : "";
    return `${base}${suffix}.${formatExtension(fmt)}`;
  }

  function extractBaseName(sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      const segment = decodeURIComponent(url.pathname).split("/").filter(Boolean).pop();
      const raw = segment && segment.length > 0 ? segment : url.hostname.replace(/^www\./, "");
      const stem = raw.replace(/\.[^.]+$/, "");
      return sanitizeFilename(stem) || "image";
    } catch {
      return "image";
    }
  }

  function sanitizeFilename(value) {
    return value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .slice(0, 80);
  }

  function fitLabel(fit) {
    if (fit === "pad") return "contain";
    if (fit === "fill") return "cover";
    return "inside";
  }

  function formatModulationTag(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  }

  function formatExtension(fmt) {
    if (fmt === "jpeg") return "jpg";
    if (fmt === "auto") return "webp";
    return fmt;
  }

  function readRecentLinks() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeRecentLinks(items) {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
    renderRecentLinks();
  }

  function saveRecentLink(params, imageUrl, editorUrl) {
    const qs = params.toString();
    const source = params.get("url") || "Image";
    const items = readRecentLinks().filter((item) => item.qs !== qs);
    items.unshift({ qs, imageUrl, editorUrl, source, createdAt: Date.now() });
    writeRecentLinks(items);
  }

  function renderRecentLinks() {
    if (!recentLinks || !recentList) return;
    const items = readRecentLinks();
    recentLinks.classList.toggle("hidden", items.length === 0);
    recentList.innerHTML = "";

    items.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "recent-item";
      row.title = item.editorUrl;
      row.innerHTML = `<span>${shortLabel(item.source)}</span><small>${new Date(item.createdAt).toLocaleDateString()}</small>`;
      row.addEventListener("click", () => {
        window.history.replaceState(null, "", `/?${item.qs}`);
        loadFromParams(new URLSearchParams(item.qs));
        applyPreview(true);
      });
      recentList.appendChild(row);
    });
  }

  function shortLabel(value) {
    try {
      const url = new URL(value);
      return url.hostname.replace(/^www\./, "");
    } catch {
      return value.length > 28 ? `${value.slice(0, 28)}...` : value;
    }
  }

  async function applyPreview(force) {
    const params = buildTransformParams();
    if (!params) {
      if (force) setSourceMessage("Enter an HTTPS image URL.");
      return;
    }

    const qs = params.toString();
    const imageUrl = `${IMAGE_PATH}?${qs}`;
    updateShareLinks(params);

    const seq = ++requestSeq;
    previewLoading.classList.remove("hidden");
    emptyState.classList.add("hidden");
    previewFrame.classList.add("hidden");
    metadataHud.classList.add("hidden");

    void refreshMetadata(imageUrl, seq);

    previewImage.onload = () => {
      if (seq !== requestSeq) return;
      const width = previewImage.naturalWidth;
      const height = previewImage.naturalHeight;
      setPreviewFrameSize(width, height);
      previewLoading.classList.add("hidden");
      previewFrame.classList.remove("hidden");
      metadataHud.classList.remove("hidden");
      hudDimensions.textContent = `${width}×${height}`;
      setSourceStats(
        sourceSizeText?.textContent && sourceSizeText.textContent !== "—"
          ? parseSizeLabel(sourceSizeText.textContent)
          : null,
        { width, height }
      );
      emptyState.classList.add("hidden");
    };
    previewImage.onerror = async () => {
      if (seq !== requestSeq) return;
      previewLoading.classList.add("hidden");
      previewFrame.classList.add("hidden");
      emptyState.classList.remove("hidden");
      try {
        const res = await fetch(imageUrl, { method: "GET", cache: "no-store" });
        if (seq !== requestSeq) return;
        const err = await res.json().catch(() => ({}));
        emptyState.textContent = err.error || `Transform failed (${res.status})`;
      } catch {
        emptyState.textContent = "Could not load transformed image";
      }
      metadataHud.classList.add("hidden");
    };
    previewImage.src = imageUrl;
  }

  function previewUrlSource(force, preserveOutputSize = false) {
    const sourceUrl = imageUrlInput.value.trim();
    if (!sourceUrl) {
      setSourceMessage("Paste an HTTPS image URL to preview its source size.");
      setSourceStats(null, null);
      return;
    }
    if (!/^https:\/\//i.test(sourceUrl)) {
      setSourceMessage("Use an HTTPS image URL.");
      setSourceStats(null, null);
      return;
    }

    const seq = ++requestSeq;
    setSourceMessage("Loading source preview...");
    setSourceStats(null, null);
    previewLoading.classList.remove("hidden");
    emptyState.classList.add("hidden");
    previewFrame.classList.add("hidden");
    metadataHud.classList.add("hidden");
    clearShareOutputs();

    previewImage.onload = () => {
      if (seq !== requestSeq) return;
      const width = previewImage.naturalWidth;
      const height = previewImage.naturalHeight;
      const outputSize = preserveOutputSize && resizeW.value && resizeH.value
        ? currentOutputSize()
        : setTransformSize(width, height);
      setPreviewFrameSize(width, height);
      previewLoading.classList.add("hidden");
      previewFrame.classList.remove("hidden");
      metadataHud.classList.remove("hidden");
      hudFormat.textContent = "SOURCE";
      hudDimensions.textContent = `${width}×${height}`;
      hudSize.textContent = "—";
      hudCache.textContent = "READY";
      hudCache.className = "cache-pill";
      if (urlSourceNote) {
        setSourceMessage(outputSize.scaled
          ? `Source ${width}×${height}. Output set to ${outputSize.width}×${outputSize.height}.`
          : `Source ${width}×${height}. Click Apply to transform.`);
      }
      setSourceStats({ width, height }, outputSize);
    };
    previewImage.onerror = () => {
      if (seq !== requestSeq) return;
      previewLoading.classList.add("hidden");
      previewFrame.classList.add("hidden");
      emptyState.classList.remove("hidden");
      emptyState.textContent = "Could not preview that source URL";
      metadataHud.classList.add("hidden");
      setSourceMessage("Preview failed. The transform may still work if the server can fetch it.");
      setSourceStats(null, null);
    };
    previewImage.src = sourceUrl;
  }

  function setTransformSize(width, height) {
    if (!width || !height) return { width: 0, height: 0, scaled: false };
    let outputWidth = width;
    let outputHeight = height;
    let scaled = false;
    if (outputWidth * outputHeight > MAX_OUTPUT_PIXELS) {
      const scale = Math.sqrt(MAX_OUTPUT_PIXELS / (outputWidth * outputHeight));
      outputWidth = Math.max(1, Math.floor(outputWidth * scale));
      outputHeight = Math.max(1, Math.floor(outputHeight * scale));
      scaled = true;
    }
    resizeW.value = String(outputWidth);
    resizeH.value = String(outputHeight);
    return { width: outputWidth, height: outputHeight, scaled };
  }

  function setPreviewFrameSize(width, height) {
    if (!previewFrame || !width || !height) return;
    lastPreviewSize = { width, height };
    const scale = previewDisplayScale(width, height);
    const displayWidth = Math.max(1, Math.floor(width * scale));
    const displayHeight = Math.max(1, Math.floor(height * scale));
    previewFrame.style.setProperty("--preview-w", String(width));
    previewFrame.style.setProperty("--preview-h", String(height));
    previewFrame.style.setProperty("--preview-display-w", String(displayWidth));
    previewFrame.style.setProperty("--preview-display-h", String(displayHeight));
  }

  function parseSizeLabel(label) {
    const match = /^(\d+)×(\d+)$/.exec(label.trim());
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  function previewDisplayScale(width, height) {
    const stageWidth = Math.max(1, (previewStage?.clientWidth || width) - 48);
    const stageHeight = Math.max(1, (previewStage?.clientHeight || height) - 48);
    const fitScale = Math.min(1, stageWidth / width, stageHeight / height);
    const largestSide = Math.max(width, height);
    const tinyScale = largestSide < 96 ? 2 : largestSide < 160 ? 1.5 : 1;
    return Math.min(tinyScale, fitScale);
  }

  function currentOutputSize() {
    const width = Math.max(1, Number(resizeW.value) || 1);
    const height = Math.max(1, Number(resizeH.value) || width);
    return { width, height, scaled: false };
  }

  function setSourceMessage(message) {
    if (urlSourceNote) {
      urlSourceNote.textContent = message;
    }
  }

  function setSourceStats(source, output) {
    if (sourceSizeText) sourceSizeText.textContent = source ? `${source.width}×${source.height}` : "—";
    if (outputSizeText) outputSizeText.textContent = output ? `${output.width}×${output.height}` : "—";
  }

  function clearShareOutputs() {
    shareUrlInput.value = "";
    if (shareEditorInput) shareEditorInput.value = "";
    btnDownload.removeAttribute("href");
  }

  async function refreshMetadata(imageUrl, seq) {
    try {
      const res = await fetch(imageUrl, { method: "HEAD", cache: "no-store" });
      if (seq !== requestSeq || !res.ok) return;

      const ct = res.headers.get("Content-Type") || "";
      if (ct.startsWith("image/")) {
        hudFormat.textContent = ct.replace("image/", "").toUpperCase();
      }

      const cache = (res.headers.get("X-Cache") || "—").toUpperCase();
      hudCache.textContent = cache;
      hudCache.className = `cache-pill ${cache.toLowerCase()}`;

      const len = res.headers.get("Content-Length");
      if (len) {
        hudSize.textContent = `${(Number(len) / 1024).toFixed(1)} KB`;
      }
    } catch {
      /* metadata is optional */
    }
  }

  btnCopyUrl.addEventListener("click", () => copyText(shareUrlInput, btnCopyUrl));
  if (btnCopyEditor && shareEditorInput) {
    btnCopyEditor.addEventListener("click", () => copyText(shareEditorInput, btnCopyEditor));
  }
  if (btnClearRecent) {
    btnClearRecent.addEventListener("click", () => {
      localStorage.removeItem(RECENT_KEY);
      renderRecentLinks();
    });
  }

  function copyText(input, btn) {
    if (!input?.value) return;
    navigator.clipboard.writeText(input.value).then(() => {
      const prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = prev; }, 1500);
    });
  }

  function loadFromQuery() {
    const qp = new URLSearchParams(window.location.search);
    if (!qp.has("url")) return false;
    loadFromParams(qp);
    return true;
  }

  function loadFromParams(qp) {
    if (!qp.has("url")) return;

    const src = qp.get("url");
    imageUrlInput.value = src;
    if (qp.get("w")) resizeW.value = qp.get("w");
    if (qp.get("h")) resizeH.value = qp.get("h");
    if (qp.get("fit")) resizeFit.value = qp.get("fit");
    if (qp.get("rot")) rotateSelect.value = qp.get("rot");
    if (qp.get("fmt")) outputFmt.value = qp.get("fmt");
    if (qp.get("q")) qualityInput.value = qp.get("q");
    qualityVal.textContent = qualityInput.value;
    outputFmt.dispatchEvent(new Event("change"));
  }

  renderRecentLinks();
  const loadedFromQuery = loadFromQuery();
  previewUrlSource(false, loadedFromQuery);
});
