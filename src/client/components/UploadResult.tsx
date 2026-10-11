import { FileItem } from "../api";
export function UploadResult({
  file,
  onCopy,
}: {
  file: FileItem;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="upload-result" aria-label={`Upload result ${file.name}`}>
      <strong>{file.name}</strong>
      <code>{file.code}</code>
      <p>
        {file.durable
          ? "Persistent: kept indefinitely by explicit request."
          : `Expires ${file.expires_at ?? "unavailable — recheck metadata"}`}
      </p>
      <p>
        SHA-256: <code>{file.sha256 ?? "Unavailable"}</code>
      </p>
      <a href={file.private_url}>Private browser link</a>
      <p>Sign in required. This is not a public share.</p>
      <div className="tile-actions">
        <button type="button" onClick={() => onCopy(file.code, "Code copied")}>
          Copy code
        </button>
        <button
          type="button"
          onClick={() => onCopy(file.private_url, "Private link copied")}
        >
          Copy private link
        </button>
      </div>
    </div>
  );
}
