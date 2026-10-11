import { useEffect, useMemo, useRef, useState } from "react";
import { FileItem, getFile, getSession, listFiles, login, logout, Principal } from "./api";
import { FileDetail } from "./components/FileDetail";
import { GalleryView } from "./components/GalleryView";
import { ListView } from "./components/ListView";
import { Login } from "./components/Login";
import { Settings } from "./components/Settings";
import { UploadPanel } from "./components/UploadPanel";

type Tab = "gallery" | "list" | "settings";

export function App() {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("gallery");
  const [search, setSearch] = useState("");
  const [fileType, setFileType] = useState("all");
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1099px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1099px)");
    const update = () => setCompact(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const visibleFiles = useMemo(() => files.filter((file) =>
    `${file.name} ${file.code}`.toLowerCase().includes(search.trim().toLowerCase()) &&
    (fileType === "all" || (fileType === "durable" ? file.durable : file.mime_type.startsWith(`${fileType}/`)))
  ), [files, search, fileType]);
  const initialCode = initialFileCodeFromPath();
  const [selectedCode, setSelectedCode] = useState<string | null>(initialCode);
  const selectedCodeRef = useRef<string | null>(initialCode);
  const noticeTimeoutRef = useRef<number | null>(null);

  const selectedFile = useMemo(
    () => files.find((file) => file.code === selectedCode) ?? null,
    [files, selectedCode],
  );
  const totalBytes = files.reduce((total, file) => total + (file.size_bytes ?? file.size), 0);
  const showInitialFilesLoading = activeTab !== "settings" && filesLoading && files.length === 0;

  useEffect(() => {
    void loadSession();

    return () => {
      if (noticeTimeoutRef.current !== null) {
        window.clearTimeout(noticeTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (principal) {
      void refreshFiles();
    }
  }, [principal]);

  async function loadSession() {
    setSessionLoading(true);
    try {
      const session = await getSession();
      setPrincipal(session.authenticated ? session.principal : null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Session check failed");
    } finally {
      setSessionLoading(false);
    }
  }

  async function handleLogin(username: string, password: string) {
    if (loginLoading) return;
    setLoginError(null);
    setLoginLoading(true);
    try {
      const session = await login(username, password);
      setPrincipal(session.principal);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
      setPrincipal(null);
      setFiles([]);
      updateSelectedCode(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign out failed");
    }
  }

  async function refreshFiles(options: { adjustSelection?: boolean } = {}) {
    setFilesLoading(true);
    setError(null);
    try {
      const current = selectedCodeRef.current;
      const listedFiles = await listFiles();
      const nextFiles =
        current && !listedFiles.some((file) => file.code === current)
          ? await prependSelectedFile(listedFiles, current)
          : listedFiles;
      setFiles(nextFiles);
      if (options.adjustSelection ?? true) {
        updateSelectedCode((selected) =>
          selected && nextFiles.some((file) => file.code === selected)
            ? selected
            : null,
        );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "File refresh failed");
    } finally {
      setFilesLoading(false);
    }
  }

  async function prependSelectedFile(listedFiles: FileItem[], code: string): Promise<FileItem[]> {
    try {
      const selected = await getFile(code);
      return [selected, ...listedFiles.filter((file) => file.code !== selected.code)];
    } catch {
      return listedFiles;
    }
  }

  async function copyValue(value: string, label: string, sourceCode?: string) {
    if (sourceCode && selectedCodeRef.current !== sourceCode) return;
    try {
      await navigator.clipboard.writeText(value);
      if (sourceCode && selectedCodeRef.current !== sourceCode) return;
      flash(label);
    } catch {
      if (sourceCode && selectedCodeRef.current !== sourceCode) return;
      setError("Clipboard unavailable");
    }
  }

  function flash(message: string) {
    if (noticeTimeoutRef.current !== null) {
      window.clearTimeout(noticeTimeoutRef.current);
    }
    setNotice(message);
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimeoutRef.current = null;
    }, 1800);
  }

  function handleUploaded(uploaded: FileItem[]) {
    void refreshFiles();
    updateSelectedCode(uploaded[0]?.code ?? selectedCodeRef.current);
    flash(uploaded.length === 1 ? `${uploaded[0]?.code} uploaded` : `${uploaded.length} files uploaded`);
  }

  function updateSelectedCode(next: string | null | ((current: string | null) => string | null)) {
    const resolved = typeof next === "function" ? next(selectedCodeRef.current) : next;
    selectedCodeRef.current = resolved;
    setSelectedCode(resolved);
  }

  function handleFileMutation(actedCode: string, file: FileItem | null) {
    const actionStillSelected = selectedCodeRef.current === actedCode;

    if (file) {
      setFiles((current) => current.map((item) => (item.code === actedCode ? file : item)));
      if (actionStillSelected) {
        updateSelectedCode(file.code);
      }
    } else {
      setFiles((current) => current.filter((item) => item.code !== actedCode));
      if (actionStillSelected) {
        updateSelectedCode(null);
      }
    }
    void refreshFiles({ adjustSelection: actionStillSelected });
  }

  if (sessionLoading) {
    return (
      <main className="boot-shell">
        <span className="loader" />
      </main>
    );
  }

  if (!principal) {
    return <Login error={loginError} loading={loginLoading} onLogin={handleLogin} />;
  }

  const selectedInlineDetail =
    activeTab !== "settings" && compact ? (
      <FileDetail
        key={`${selectedFile?.code ?? "empty"}-inline`}
        file={selectedFile}
        onClose={() => updateSelectedCode(null)}
        onCopy={copyValue}
        onError={setError}
        onMutated={handleFileMutation}
      />
    ) : null;
  const selectedDesktopDetail =
    activeTab !== "settings" && !compact && selectedFile ? (
      <FileDetail
        key={`${selectedFile?.code ?? "empty"}-desktop`}
        file={selectedFile}
        onClose={() => updateSelectedCode(null)}
        onCopy={copyValue}
        onError={setError}
        onMutated={handleFileMutation}
      />
    ) : null;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <h1>AgentFiles</h1>
          <p>Your files, ready to hand off.</p>
        </div>
        <div className="header-actions">
          <div className="principal-pill">{principal.name}</div>
          <button type="button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <div hidden={activeTab === "settings"}>
        <UploadPanel onError={setError} onUploaded={handleUploaded} />
      </div>

      <nav className="tabs" aria-label="Primary views">
        {(["gallery", "list", "settings"] as const).map((tab) => (
          <button
            aria-pressed={activeTab === tab}
            className={activeTab === tab ? "active" : ""}
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {error ? (
        <div className="notice error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {notice ? <div className="notice success" role="status">{notice}</div> : null}

      <div className={`workbench ${selectedDesktopDetail ? "has-selection" : ""}`}>
        <section className="main-pane">
          <div className="pane-head">
            <div className="library-heading"><h2>{activeTab === "settings" ? "Settings" : "Files"}</h2>
              {activeTab !== "settings" ? <span>{files.length} files · {formatBytes(totalBytes)} · {files.filter((file) => file.durable).length} kept</span> : null}
            </div>
            {activeTab !== "settings" ? (
              <button disabled={filesLoading} type="button" onClick={() => void refreshFiles()}>
                {filesLoading ? "Refreshing..." : "Refresh"}
              </button>
            ) : null}
          </div>
          {activeTab !== "settings" ? <div className="library-tools">
            <label className="search-field"><span className="sr-only">Search files</span><input type="search" placeholder="Search by filename or code" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
            <label className="filter-field"><span className="sr-only">Filter files</span><select value={fileType} onChange={(event) => setFileType(event.target.value)}>
              <option value="all">All files</option><option value="video">Videos</option><option value="image">Images</option><option value="audio">Audio</option><option value="durable">Kept files</option>
            </select></label>
            {search || fileType !== "all" ? <button type="button" onClick={() => { setSearch(""); setFileType("all"); }}>Clear filters</button> : null}
          </div> : null}
          {!showInitialFilesLoading && files.length > 0 && visibleFiles.length === 0 && activeTab !== "settings" ? <div className="empty-state"><h3>No matching files</h3><p>Try another filename or clear the filters.</p></div> : null}
          {showInitialFilesLoading ? <div className="empty-state">Loading files…</div> : null}
          {!showInitialFilesLoading && (visibleFiles.length > 0 || files.length === 0) && activeTab === "gallery" ? (
            <GalleryView
              files={visibleFiles}
              selectedCode={selectedCode}
              selectedDetail={selectedInlineDetail}
              onCopy={copyValue}
              onSelect={(file) => updateSelectedCode(file.code)}
            />
          ) : null}
          {!showInitialFilesLoading && (visibleFiles.length > 0 || files.length === 0) && activeTab === "list" ? (
            <ListView
              files={visibleFiles}
              selectedCode={selectedCode}
              selectedDetail={selectedInlineDetail}
              onCopy={copyValue}
              onSelect={(file) => updateSelectedCode(file.code)}
            />
          ) : null}
          {activeTab === "settings" ? <Settings principal={principal} onCopy={copyValue} /> : null}
        </section>
        {selectedDesktopDetail ? <div className="desktop-detail">{selectedDesktopDetail}</div> : null}
      </div>
    </main>
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

function initialFileCodeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/files\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}
