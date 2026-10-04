/**
 * modules/file-upload.js — 文件上传模块
 * 文件选择、预览、附件读取、大小/类型校验
 */

import { addPendingFile, removePendingFile, clearPendingFiles, getState } from "../core/store.js";
import { emit, EventNames } from "../core/events.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

// ─── 工具函数 ────────────────────────────────────────────

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── 文件处理 ────────────────────────────────────────────

export function addFiles(fileList) {
  const fileInput = document.getElementById("fileInput");
  const pendingFiles = [];

  for (const file of fileList) {
    // 大小校验
    if (file.size > MAX_FILE_SIZE) {
      alert(`文件 "${file.name}" 超过 10MB 限制`);
      continue;
    }
    pendingFiles.push(file);
  }

  for (const file of pendingFiles) {
    addPendingFile(file);
    emit(EventNames.FILE_ATTACH, file);
  }

  renderFilePreview();

  // 清空 input 以便重复选择同一文件
  if (fileInput) fileInput.value = "";
}

export function removeFile(index) {
  removePendingFile(index);
  emit(EventNames.FILE_DETACH, index);
  renderFilePreview();
}

export function renderFilePreview() {
  const previewArea = document.getElementById("filePreviewArea");
  if (!previewArea) return;

  const files = getState("pendingFiles") || [];
  previewArea.innerHTML = "";

  if (files.length === 0) {
    previewArea.hidden = true;
    return;
  }

  previewArea.hidden = false;
  files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "file-preview-item";

    if (IMAGE_TYPES.has(file.type)) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.className = "file-preview-thumb";
      item.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "file-preview-icon";
      icon.textContent = "📄";
      item.appendChild(icon);
    }

    const meta = document.createElement("div");
    meta.className = "file-preview-meta";
    const name = document.createElement("span");
    name.className = "file-preview-name";
    name.textContent = file.name;
    meta.appendChild(name);
    const size = document.createElement("small");
    size.className = "file-preview-size";
    size.textContent = formatFileSize(file.size);
    meta.appendChild(size);
    item.appendChild(meta);

    const removeBtn = document.createElement("button");
    removeBtn.className = "file-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.title = "移除";
    removeBtn.addEventListener("click", () => removeFile(index));
    item.appendChild(removeBtn);

    previewArea.appendChild(item);
  });
}

/**
 * 清空待上传文件并隐藏预览区（发送成功后调用）
 */
export function clearFilePreview() {
  clearPendingFiles();
  renderFilePreview();
}

// ─── 初始化 ──────────────────────────────────────────────

export function initFileUpload() {
  const attachFileBtn = document.getElementById("attachFile");
  const fileInput = document.getElementById("fileInput");

  if (attachFileBtn && fileInput) {
    attachFileBtn.addEventListener("click", () => fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      if (e.target.files?.length) {
        addFiles(e.target.files);
      }
    });
  }
}
