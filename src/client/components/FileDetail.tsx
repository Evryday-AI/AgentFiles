import { MediaPreview } from "./MediaPreview";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  absoluteDownloadUrl,
  createShareLink,
  deleteFile,
  downloadUrl,
  FileItem,
  revokeShareLink,
  setFileDurable,
  ShareLink,
} from "../api";

interface FileDetailProps {
  file: FileItem | null;
  onClose: () => void;
  onCopy: (value: string, label: string, sourceCode?: string) => void;
  onError: (message: string) => void;
  onMutated: (actedCode: string, file: FileItem | null) => void;
}

export function FileDetail({ file, onClose, onCopy, onError, onMutated }: FileDetailProps) {
  const previewDialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareLink | null>(null);
  const [shareHours, setShareHours] = useState("24");
  const [maxDownloads, setMaxDownloads] = useState("");
  const activeCodeRef = useRef<string | null>(file?.code ?? null);

  useEffect(() => {
    activeCodeRef.current = file?.code ?? null;
    setShare(null);

    return () => {
      activeCodeRef.current = null;
    };
  }, [file?.code]);

  function isActiveFile(code: string) {
    return activeCodeRef.current === code;
  }

  if (!file) {
    return (
      <aside className="detail-panel placeholder">
        <h2>No file selected</h2>
      </aside>
    );
  }

  async function handleDurable() {
    if (!file) return;
    const actedCode = file.code;
    setBusy(true);
    try {
      const updated = await setFileDurable(actedCode, !file.durable);
      onMutated(actedCode, updated);
    } catch (error) {
      if (isActiveFile(actedCode)) {
        onError(error instanceof Error ? error.message : "Durable update failed");
      }
    } finally {
      if (isActiveFile(actedCode)) {
        setBusy(false);
      }
    }
  }

  async function handleDelete() {
    if (!file || !window.confirm(`Delete ${file.code}?`)) return;
    const actedCode = file.code;
    setBusy(true);
    try {
      await deleteFile(actedCode);
      if (isActiveFile(actedCode)) {
        setShare(null);
      }
      onMutated(actedCode, null);
    } catch (error) {
      if (isActiveFile(actedCode)) {
        onError(error instanceof Error ? error.message : "Delete failed");
      }
    } finally {
      if (isActiveFile(actedCode)) {
        setBusy(false);
      }
    }
  }

  async function handleShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const actedCode = file.code;
    setBusy(true);
    try {
      const created = await createShareLink(actedCode, {
        expiresAt: new Date(Date.now() + Number(shareHours) * 60 * 60 * 1000).toISOString(),
        maxDownloads: maxDownloads ? Number(maxDownloads) : null,
      });
      if (isActiveFile(actedCode)) {
        setShare(created);
        onCopy(created.public_url, "Share URL copied", actedCode);
      }
    } catch (error) {
      if (isActiveFile(actedCode)) {
        onError(error instanceof Error ? error.message : "Share creation failed");
      }
    } finally {
      if (isActiveFile(actedCode)) {
        setBusy(false);
      }
    }
  }

  async function handleRevokeShare() {
    if (!file || !share) return;
    const actedCode = file.code;
    setBusy(true);
    try {
      await revokeShareLink(share.id);
      if (isActiveFile(actedCode)) {
        setShare(null);
      }
    } catch (error) {
      if (isActiveFile(actedCode)) {
        onError(error instanceof Error ? error.message : "Share revoke failed");
      }
    } finally {
      if (isActiveFile(actedCode)) {
        setBusy(false);
      }
    }
  }

  return (
    <aside className="detail-panel" aria-label="File detail">
      <div className="detail-top">
        <div>
          <h2>File details</h2>
          <span className="file-code">{file.code}</span>
        </div>
        <button className="icon-action" aria-label="Close detail" type="button" onClick={onClose}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>

      {!expanded ? <div className="detail-preview">
        <MediaPreview key={`${file.code}-${expanded}`} file={file} />
      </div> : null}
      {file.mime_type.startsWith("video/") || file.mime_type.startsWith("image/") ? <button className="expand-preview" type="button" onClick={() => { setExpanded(true); previewDialog.current?.showModal(); }}>Open larger preview</button> : null}
      <dialog ref={previewDialog} className="preview-dialog" aria-label={`Preview ${file.name}`} onClose={() => setExpanded(false)} onClick={(event) => { if (event.target === event.currentTarget) previewDialog.current?.close(); }}>
        <div className="preview-dialog-head"><h2>{file.name}</h2><button autoFocus type="button" onClick={() => previewDialog.current?.close()}>Close preview</button></div>
        {expanded ? <MediaPreview key={file.code} file={file} /> : null}
      </dialog>

      <div className="detail-title">
        <h3>{file.name}</h3>
        <span className={`status-pill ${file.durable ? "durable" : "expiring"}`}>
          {file.durable ? "Kept" : "Temporary"}
        </span>
      </div>

      <dl className="detail-facts">
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(file.size_bytes ?? file.size)}</dd>
        </div>
        <div>
          <dt>File type</dt>
          <dd>{file.mime_type}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(file.created_at)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{file.expires_at ? formatDate(file.expires_at) : "Never"}</dd>
        </div>
      </dl>

      <div className="action-grid">
        <button type="button" onClick={() => onCopy(file.code, "Code copied", file.code)}>
          Copy code
        </button>
        <button type="button" onClick={() => onCopy(absoluteDownloadUrl(file.code), "URL copied", file.code)}>
          Copy URL
        </button>
        <a className="button-like primary-action" href={downloadUrl(file.code)}>
          Download
        </a>
        <button disabled={busy} type="button" onClick={handleDurable}>
          {file.durable ? "Use auto-expiry" : "Keep indefinitely"}
        </button>
      </div>

      <form className="share-box" onSubmit={handleShare}>
        <h3>Share a download link</h3>
        <p>Anyone with the link can download until it expires.</p>
        <div className="share-inputs">
          <label className="field compact">
            <span>Expires in (hours)</span>
            <input
              min="1"
              required
              type="number"
              value={shareHours}
              onChange={(event) => setShareHours(event.target.value)}
            />
          </label>
          <label className="field compact">
            <span>Download limit</span>
            <input
              min="1"
              placeholder="Unlimited"
              type="number"
              value={maxDownloads}
              onChange={(event) => setMaxDownloads(event.target.value)}
            />
          </label>
          <button disabled={busy} type="submit">
            {busy ? "Working…" : "Create share link"}
          </button>
        </div>
        {share ? (
          <div className="share-result">
            <button type="button" onClick={() => onCopy(share.public_url, "Share URL copied", file.code)}>
              {share.public_url}
            </button>
            <button disabled={busy} type="button" onClick={handleRevokeShare}>
              Revoke
            </button>
          </div>
        ) : null}
      </form>

      <button className="danger-action" disabled={busy} type="button" onClick={handleDelete}>
        Delete file
      </button>
    </aside>
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
