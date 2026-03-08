import { useState, useEffect, useCallback, useRef } from "react";
import { useToast } from "./useToast";
import type { UploadResponse } from "../lib/types";

const ALLOWED_TYPES = [
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/x-aac",
  "audio/opus",
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "video/mp4",
  "video/webm",
];

const ALLOWED_EXTENSIONS = [
  "mp3", "ogg", "wav", "flac", "aac", "opus", "webm", "mp4", "m4a",
];

const MAX_UPLOAD_SIZE_MB = 300;

export interface DroppedFileUpload {
  name: string;
  size: number;
  type: string;
  uploadPromise: Promise<UploadResponse>;
}

/** Plain FormData + fetch upload — the standard approach used by every website. */
function uploadFile(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  return fetch("/api/upload", {
    method: "POST",
    body: formData,
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest" },
  }).then(async (res) => {
    if (res.status === 401) {
      window.location.href = "/auth/login";
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    return res.json() as Promise<UploadResponse>;
  });
}

function validateFile(
  file: File,
  showToast: (msg: string, type: "error") => void,
): boolean {
  if (file.type && !ALLOWED_TYPES.includes(file.type)) {
    showToast(`Unsupported file type: ${file.type}`, "error");
    return false;
  }
  if (!file.type) {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
      showToast("Unsupported file type", "error");
      return false;
    }
  }
  if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
    showToast(`File too large (max ${MAX_UPLOAD_SIZE_MB}MB)`, "error");
    return false;
  }
  return true;
}

export function useFileDrop() {
  const { showToast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [droppedFile, setDroppedFile] = useState<DroppedFileUpload | null>(null);
  const counterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const clearDroppedFile = useCallback(() => {
    setDroppedFile(null);
  }, []);

  const startUpload = useCallback(
    (file: File) => {
      if (!validateFile(file, showToast)) return;

      const uploadPromise = uploadFile(file);

      setDroppedFile({
        name: file.name,
        size: file.size,
        type: file.type,
        uploadPromise,
      });
    },
    [showToast],
  );

  // Hidden file input for manual file selection
  const triggerFileInput = useCallback(() => {
    if (!fileInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) startUpload(file);
        input.value = "";
      });
      document.body.appendChild(input);
      fileInputRef.current = input;
    }
    fileInputRef.current.click();
  }, [startUpload]);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      counterRef.current += 1;
      if (e.dataTransfer?.types.includes("Files")) {
        setIsDragging(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      counterRef.current -= 1;
      if (counterRef.current === 0) {
        setIsDragging(false);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      counterRef.current = 0;
      setIsDragging(false);

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      startUpload(files[0]);
    };

    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, [startUpload]);

  useEffect(() => {
    return () => {
      if (fileInputRef.current) {
        fileInputRef.current.remove();
        fileInputRef.current = null;
      }
    };
  }, []);

  return { isDragging, droppedFile, clearDroppedFile, triggerFileInput };
}
