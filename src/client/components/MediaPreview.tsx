import { CSSProperties, useState } from "react";
import { downloadUrl, FileItem } from "../api";

export function MediaPreview({ file, thumbnail = false }: { file: FileItem; thumbnail?: boolean }) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const url = downloadUrl(file.code);
  const style = ratio ? { "--media-ratio": ratio } as CSSProperties : undefined;
  if (failed) {
    return <div className="file-fallback"><span>Preview unavailable</span><small>Download the file to open it.</small></div>;
  }
  if (file.mime_type.startsWith("image/")) {
    return <div className={`media-content ${thumbnail ? "thumbnail" : ""}`} style={style}>
      <img alt={thumbnail ? "" : file.name} loading="lazy" src={url}
        onLoad={(event) => setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)}
        onError={() => setFailed(true)} />
    </div>;
  }
  if (file.mime_type.startsWith("video/")) {
    return <div className={`media-content ${thumbnail ? "thumbnail" : ""}`} style={style}>
      <video aria-label={file.name} controls={!thumbnail} muted={thumbnail} playsInline preload="metadata" src={url}
        onLoadedMetadata={(event) => {
          const { videoWidth, videoHeight } = event.currentTarget;
          if (videoWidth && videoHeight) setRatio(videoWidth / videoHeight);
        }} onError={() => setFailed(true)} />
      {thumbnail ? <span className="video-indicator" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>Video</span> : null}
    </div>;
  }
  if (file.mime_type.startsWith("audio/") && !thumbnail) {
    return <div className="audio-preview"><span>Audio preview</span><audio aria-label={file.name} controls preload="metadata" src={url} onError={() => setFailed(true)} /></div>;
  }
  return <div className="file-fallback"><span>{file.name.split(".").pop()?.toUpperCase() || "FILE"}</span><small>{file.mime_type.startsWith("audio/") ? "Audio" : "Document"}</small></div>;
}
