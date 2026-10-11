import { ChangeEvent, useRef, useState } from "react";
import { FileItem, uploadFile } from "../api";

interface UploadPanelProps {
  onUploaded: (files: FileItem[]) => void;
  onError: (message: string) => void;
}

interface UploadRow {
  id: string;
  name: string;
  size: number;
  percent: number;
  status: "queued" | "uploading" | "done" | "error";
  code?: string;
  error?: string;
}

export function UploadPanel({ onUploaded, onError }: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [durable, setDurable] = useState(false);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [busy, setBusy] = useState(false);

  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);
  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await uploadFiles(files);
  }
  async function uploadFiles(files: File[]) {
    if (files.length === 0 || busyRef.current) return;
    busyRef.current = true;

    const rows = files.map((file) => ({
      id: `${file.name}-${file.lastModified}-${file.size}-${crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      percent: 0,
      status: "queued" as const,
    }));
    setUploads(rows);
    setBusy(true);

    const uploaded: FileItem[] = [];
    for (const [index, file] of files.entries()) {
      const rowId = rows[index]?.id;
      if (!rowId) continue;
      updateRow(rowId, { status: "uploading", percent: 0 });
      try {
        const result = await uploadFile(file, {
          durable,
          onProgress: (progress) => updateRow(rowId, { percent: progress.percent }),
        });
        uploaded.push(result);
        updateRow(rowId, { status: "done", percent: 100, code: result.code });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        updateRow(rowId, { status: "error", error: message });
        onError(message);
      }
    }

    busyRef.current = false;
    setBusy(false);
    if (uploaded.length > 0) {
      onUploaded(uploaded);
    }
  }

  function updateRow(id: string, patch: Partial<UploadRow>) {
    setUploads((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  return (
    <section className={`upload-panel ${dragging ? "dragging" : ""}`} aria-label="Upload files"
      onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void uploadFiles(Array.from(event.dataTransfer.files)); }}>
      <div className="upload-copy">
        <h2>{dragging ? "Drop files to upload" : "Upload files"}</h2>
        <p>Drag files here, or choose them from your device.</p>
      </div>
      <div className="upload-controls">
        <label className="toggle-line">
          <input
            checked={durable}
            disabled={busy}
            type="checkbox"
            onChange={(event) => setDurable(event.target.checked)}
          />
          <span>Keep indefinitely</span>
        </label>
        <button
          className="primary-action"
          disabled={busy}
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose files"}
        </button>
        <input
          ref={inputRef}
          hidden
          multiple
          type="file"
          onChange={handleFiles}
        />
      </div>
      {uploads.length > 0 ? (
        <div className="upload-queue" aria-live="polite">
          {!busy ? <button className="queue-dismiss" type="button" onClick={() => setUploads([])}>Dismiss completed uploads</button> : null}
          {uploads.map((upload) => (
            <div className="upload-row" key={upload.id}>
              <div className="upload-row-main">
                <span className="truncate">{upload.name}</span>
                <span className={`status-pill ${upload.status}`}>{upload.code ?? upload.status}</span>
              </div>
              <div className="progress-track" role="progressbar" aria-label={`Upload ${upload.name}`} aria-valuenow={upload.percent} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${upload.percent}%` }} />
              </div>
              <div className="meta-line">
                <span>{formatBytes(upload.size)}</span>
                {upload.error ? <span>{upload.error}</span> : <span>{upload.percent}%</span>}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units.shift() ?? "KB";
  while (value >= 1024 && units.length > 0) {
    value /= 1024;
    unit = units.shift() ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}
