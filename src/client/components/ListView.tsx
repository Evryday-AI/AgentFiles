import { Fragment, ReactNode } from "react";
import { FileItem } from "../api";

interface ListViewProps {
  files: FileItem[];
  selectedCode: string | null;
  selectedDetail: ReactNode;
  onSelect: (file: FileItem) => void;
  onCopy: (value: string, label: string) => void;
}

export function ListView({ files, selectedCode, selectedDetail, onSelect, onCopy }: ListViewProps) {
  if (files.length === 0) {
    return <div className="empty-state">Upload your first file to start sharing.</div>;
  }

  return (
    <section className="file-list" aria-label="File list">
      {files.map((file) => {
        const selected = selectedCode === file.code;
        return (
          <Fragment key={file.code}>
            <article className={`list-row ${selected ? "selected" : ""}`}>
              <button className="list-code" aria-pressed={selected} type="button" onClick={() => onSelect(file)}>
                {file.code}
              </button>
              <button className="list-name" title={file.name} aria-pressed={selected} type="button" onClick={() => onSelect(file)}>
                <span className="truncate">{file.name}</span>
                <small>{file.mime_type || "application/octet-stream"}</small>
              </button>
              <span className="list-size">{formatBytes(file.size_bytes ?? file.size)}</span>
              <span className={`status-pill ${file.durable ? "durable" : "expiring"}`}>
                {file.durable ? "Kept" : "Temporary"}
              </span>
              <div className="row-actions">
                <button type="button" onClick={() => onCopy(file.code, "Code copied")}>
                  Copy code
                </button>
                <button type="button" onClick={() => onCopy(file.private_url, "Private link copied")}>
                  Copy private link
                </button>
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
