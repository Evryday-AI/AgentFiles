import { Fragment, ReactNode } from "react";
import { MediaPreview } from "./MediaPreview";
import { absoluteDownloadUrl, FileItem } from "../api";

interface GalleryViewProps {
  files: FileItem[];
  selectedCode: string | null;
  selectedDetail: ReactNode;
  onSelect: (file: FileItem) => void;
  onCopy: (value: string, label: string) => void;
}

export function GalleryView({ files, selectedCode, selectedDetail, onSelect, onCopy }: GalleryViewProps) {
  if (files.length === 0) {
    return <div className="empty-state">Upload your first file to start sharing.</div>;
  }

  return (
    <section className="gallery-grid" aria-label="File gallery">
      {files.map((file) => {
        const selected = selectedCode === file.code;
        return (
          <Fragment key={file.code}>
            <article className={`file-tile ${selected ? "selected" : ""}`}>
              <button className="media-frame" type="button" aria-label={`Preview ${file.name}`} aria-pressed={selected} onClick={() => onSelect(file)}><MediaPreview key={file.code} file={file} thumbnail /></button>
              <div className="tile-body">
                <button className="file-name-button" title={file.name} type="button" aria-pressed={selected} onClick={() => onSelect(file)}>{file.name}</button>
                <div className="tile-meta"><span className="file-code">{file.code}</span><span>{formatBytes(file.size_bytes ?? file.size)}</span></div>
                <span className={`status-pill ${file.durable ? "durable" : "expiring"}`}>{file.durable ? "Kept" : "Temporary"}</span>
                <div className="tile-actions">
                  <button type="button" onClick={() => onCopy(file.code, "Code copied")}>
                    Copy code
                  </button>
                  <button
                    type="button"
                    onClick={() => onCopy(absoluteDownloadUrl(file.code), "URL copied")}
                  >
                    Copy URL
                  </button>
                </div>
              </div>
            </article>
            {selected && selectedDetail ? <div className="mobile-selected-detail">{selectedDetail}</div> : null}
          </Fragment>
        );
      })}
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
