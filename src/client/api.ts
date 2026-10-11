export type Principal =
  | { type: "admin"; name: string }
  | {
      type: "api_key";
      id: string;
      name: string;
      canUpload: boolean;
      canDownload: boolean;
      canList: boolean;
      canDelete: boolean;
      canMarkDurable: boolean;
      canShare: boolean;
    };

export interface SessionResponse {
  authenticated: boolean;
  principal: Principal | null;
}

export interface FileItem {
  code: string;
  name: string;
  mime_type: string;
  size: number;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  expiry: string | null;
  expires_at: string | null;
  durable: boolean;
  is_durable: boolean;
  sha256: string | null;
  private_url: string;
  api_download_url: string;
  uploaded_by: {
    type: "admin" | "api_key";
    name: string | null;
  };
  metadata: Record<string, unknown>;
}

export interface ShareLink {
  id: string;
  file_code: string;
  public_url: string;
  expires_at: string;
  max_downloads: number | null;
  download_count: number;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  canUpload: boolean;
  canDownload: boolean;
  canList: boolean;
  canDelete: boolean;
  canMarkDurable: boolean;
  canShare: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyInput {
  name: string;
  canUpload?: boolean;
  canDownload?: boolean;
  canList?: boolean;
  canDelete?: boolean;
  canMarkDurable?: boolean;
  canShare?: boolean;
}

export interface StorageUsage {
  bytes: number;
  managed_bytes: number;
  reserved_bytes: number;
  max_storage_bytes: number;
  cleanup: {
    pending_expired_bytes: number;
    failed_files: number;
    last_success_at: string | null;
  };
}

export interface InstanceInfo {
  name: "AgentFiles";
  base_url: string;
  retention_days: number;
  max_upload_bytes: number;
  allow_persistent_files: boolean;
  skill_url: string;
}
export function getInstance(): Promise<InstanceInfo> {
  return request<InstanceInfo>("/api/instance");
}
export async function checkAgentConnection(
  key: string,
): Promise<SessionResponse> {
  const response = await fetch("/api/auth/session", {
    credentials: "omit",
    redirect: "error",
    headers: { authorization: `Bearer ${key}` },
  });
  if (!response.ok)
    throw new ApiError("Connection check failed", response.status);
  return response.json() as Promise<SessionResponse>;
}
export function fileError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Sign in again to access this file (401).";
    if (error.status === 403)
      return "Your key lacks permission for this file (403).";
    if (error.status === 404) return "File is missing or removed (404).";
    if (error.status === 410) return "File has expired (410).";
    if (error.status === 507)
      return "Storage is full. Ask the operator to check capacity and cleanup.";
  }
  return error instanceof Error ? error.message : "File request failed";
}

export interface UploadProgress {
  file: File;
  loaded: number;
  total: number;
  percent: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = options;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const response = await fetch(path, {
    ...rest,
    credentials: "include",
    headers: {
      ...(hasBody && !(rest.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    throw new ApiError(await errorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : response.statusText;
  } catch {
    return response.statusText;
  }
}

function apiKeyPayload(input: Partial<ApiKeyInput>) {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name;
  if (input.canUpload !== undefined) payload.can_upload = input.canUpload;
  if (input.canDownload !== undefined) payload.can_download = input.canDownload;
  if (input.canList !== undefined) payload.can_list = input.canList;
  if (input.canDelete !== undefined) payload.can_delete = input.canDelete;
  if (input.canMarkDurable !== undefined)
    payload.can_mark_durable = input.canMarkDurable;
  if (input.canShare !== undefined) payload.can_share = input.canShare;
  return payload;
}

export function getSession(): Promise<SessionResponse> {
  return request<SessionResponse>("/api/auth/session");
}

export function login(
  username: string,
  password: string,
): Promise<SessionResponse> {
  return request<SessionResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<SessionResponse> {
  return request<SessionResponse>("/api/auth/logout", { method: "POST" });
}

export async function listFiles(): Promise<FileItem[]> {
  const body = await request<{ files: FileItem[] }>("/api/files?limit=200");
  return body.files;
}

export function getFile(code: string): Promise<FileItem> {
  return request<FileItem>(`/api/files/${encodeURIComponent(code)}`);
}

export function downloadUrl(code: string): string {
  return `/api/files/${encodeURIComponent(code)}/download`;
}

export function absoluteDownloadUrl(code: string): string {
  return new URL(downloadUrl(code), window.location.origin).toString();
}

export function uploadFile(
  file: File,
  options: {
    durable?: boolean;
    onProgress?: (progress: UploadProgress) => void;
  } = {},
): Promise<FileItem> {
  const data = new FormData();
  data.append("file", file);
  if (options.durable) {
    data.append("durable", "true");
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.withCredentials = true;
    xhr.responseType = "json";

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      const loaded = event.loaded;
      const percent = clampProgressPercent(
        total > 0 ? Math.round((loaded / total) * 100) : 0,
      );
      options.onProgress?.({ file, loaded, total, percent });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const file = xhr.response as FileItem | null;
        if (
          !file ||
          !/^F-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(file.code) ||
          typeof file.private_url !== "string" ||
          typeof file.name !== "string"
        ) {
          reject(
            new ApiError(
              "Upload outcome unknown. Reconcile before uploading again.",
              0,
            ),
          );
          return;
        }
        resolve(xhr.response as FileItem);
        return;
      }

      const message =
        typeof xhr.response?.error === "string"
          ? xhr.response.error
          : xhr.statusText;
      reject(new ApiError(message || "Upload failed", xhr.status));
    };

    xhr.onerror = () =>
      reject(
        new ApiError(
          "Upload outcome unknown. Refresh and reconcile name, creation time, size and checksum before uploading again.",
          0,
        ),
      );
    xhr.onabort = () =>
      reject(
        new ApiError(
          "Upload outcome unknown. Reconcile before uploading again.",
          0,
        ),
      );
    xhr.send(data);
  });
}

function clampProgressPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

export function setFileDurable(
  code: string,
  durable: boolean,
): Promise<FileItem> {
  return request<FileItem>(`/api/files/${encodeURIComponent(code)}`, {
    method: "PATCH",
    body: JSON.stringify({ durable }),
  });
}

export function deleteFile(
  code: string,
): Promise<{ deleted: boolean; code: string }> {
  return request<{ deleted: boolean; code: string }>(
    `/api/files/${encodeURIComponent(code)}`,
    {
      method: "DELETE",
    },
  );
}

export function createShareLink(
  code: string,
  input: { expiresAt: string; maxDownloads?: number | null },
): Promise<ShareLink> {
  return request<ShareLink>(`/api/files/${encodeURIComponent(code)}/share`, {
    method: "POST",
    body: JSON.stringify({
      expires_at: input.expiresAt,
      max_downloads: input.maxDownloads ?? null,
    }),
  });
}

export function revokeShareLink(
  id: string,
): Promise<{ revoked: boolean; id: string }> {
  return request<{ revoked: boolean; id: string }>(
    `/api/share-links/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const body = await request<{ apiKeys: ApiKeyRecord[] }>(
    "/api/admin/api-keys",
  );
  return body.apiKeys;
}

export function createApiKey(
  input: ApiKeyInput,
): Promise<{ apiKey: ApiKeyRecord; secret: string }> {
  return request<{ apiKey: ApiKeyRecord; secret: string }>(
    "/api/admin/api-keys",
    {
      method: "POST",
      body: JSON.stringify(apiKeyPayload(input)),
    },
  );
}

export function updateApiKey(
  id: string,
  input: Partial<ApiKeyInput>,
): Promise<{ apiKey: ApiKeyRecord }> {
  return request<{ apiKey: ApiKeyRecord }>(
    `/api/admin/api-keys/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(apiKeyPayload(input)),
    },
  );
}

export function revokeApiKey(id: string): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(
    `/api/admin/api-keys/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
}

export async function getStorageUsage(): Promise<StorageUsage | null> {
  try {
    return await request<StorageUsage>("/api/admin/storage-usage");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
