#!/usr/bin/env bash
# Drafted from source; application runtime verification is pending D1.
# Requires Bash, curl, jq, realpath, and sha256sum or shasum. Never run with shell tracing.
set +x
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
for tool in curl jq mktemp realpath; do command -v "$tool" >/dev/null || fail "Missing command: $tool"; done
if command -v sha256sum >/dev/null; then
    hash_file() { sha256sum -- "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null; then
    hash_file() { shasum -a 256 -- "$1" | cut -d ' ' -f 1; }
else
    fail 'Install sha256sum or shasum for checksum verification.'
fi
[[ $# -le 1 ]] || fail 'Usage: bash examples/upload.sh [file]; omitted creates synthetic text.'
base=${AGENTFILES_BASE_URL:?Set AGENTFILES_BASE_URL to the instance origin}
key=${AGENTFILES_API_KEY:?Set AGENTFILES_API_KEY through a secret environment provider}
[[ ! $key =~ [[:cntrl:][:space:]] && ${#key} -le 1024 ]] || fail 'Invalid API key header characters.'

# Accept origins only, with no userinfo, path, query, fragment, or backslash.
origin_pattern='^([Hh][Tt][Tt][Pp][Ss]?)://(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)(:([0-9]{1,5}))?/?$'
[[ $base =~ $origin_pattern ]] || fail 'Base URL must be an HTTP(S) origin without credentials, query, fragment, or path.'
scheme=${BASH_REMATCH[1],,}
host=${BASH_REMATCH[2],,}
port=${BASH_REMATCH[5]}
[[ $host != *..* && $host != *.-* && $host != *-.* ]] || fail 'Invalid hostname.'
if [[ -n $port ]]; then
    port=$((10#$port))
    ((port >= 1 && port <= 65535)) || fail 'Invalid port.'
fi
if [[ $scheme == http ]]; then
    # A conservative subset of loopback addresses keeps shell validation simple.
    [[ $host == localhost || $host == 127.0.0.1 || $host == '[::1]' ]] || fail 'HTTP requires localhost, 127.0.0.1, or [::1].'
fi
if [[ ($scheme == https && $port == 443) || ($scheme == http && $port == 80) ]]; then port=; fi
base="$scheme://$host${port:+:$port}"

private=$(mktemp -d)
chmod 700 "$private"
download_dir=
success=false
cleanup() {
    rm -rf -- "$private"
    if [[ $success != true && -n $download_dir ]]; then rm -rf -- "$download_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Keys never enter curl's argv. Escape curl config string syntax explicitly.
escaped_key=${key//\\/\\\\}
escaped_key=${escaped_key//\"/\\\"}
printf 'header = "Authorization: Bearer %s"\n' "$escaped_key" > "$private/curl.conf"
chmod 600 "$private/curl.conf"
unset key escaped_key AGENTFILES_API_KEY

request() {
    local method=$1 url=$2 output=$3 status
    shift 3
    [[ $url == "$base/"* ]] || fail 'Refusing a request outside the configured origin.'
    # --disable must be first: ignore ambient curl configs, cookies, redirects, retries.
    if ! status=$(curl --disable --config "$private/curl.conf" --silent --show-error \
        --noproxy '*' --proto '=http,https' --max-redirs 0 --connect-timeout 10 --max-time 120 \
        --request "$method" --url "$url" --output "$output" --dump-header "$private/headers" \
        --write-out '%{http_code}' "$@" 2> "$private/transport-error"); then
        [[ $method != POST ]] || printf '%s\n' 'Upload outcome is unknown. Do not repeat POST; reconcile with authorized metadata/list access.' >&2
        fail 'Network request failed; transport details withheld to keep credentials private.'
    fi
    case "$status" in
        2??) ;;
        3??) fail 'Redirect rejected; credentials were not forwarded.' ;;
        401|403) fail "HTTP $status: stop and check credentials or permissions." ;;
        404) fail 'HTTP 404: file is missing or removed.' ;;
        410) fail 'HTTP 410: file or share has expired or is unavailable.' ;;
        413) fail 'HTTP 413: reduce file size or ask the operator to review upload settings.' ;;
        429)
            printf '%s\n' 'HTTP 429: wait before a new attempt; do not retry an uncertain upload.' >&2
            # Only a bounded printable header is emitted; no response bodies or URLs.
            awk 'tolower($0) ~ /^retry-after:/ {sub(/\r$/, ""); if (length($0) <= 120 && $0 !~ /[^ -~]/) print}' "$private/headers" >&2
            exit 1 ;;
        507) fail 'HTTP 507: capacity rejection is planned; ask the operator to free capacity.' ;;
        *)
            [[ $method != POST ]] || printf '%s\n' 'Upload outcome may be unknown. Do not repeat POST without reconciliation.' >&2
            fail "HTTP $status: inspect the instance before another attempt." ;;
    esac
}

request GET "$base/api/auth/session" "$private/session.json"
jq -e '.authenticated == true and .principal.type == "api_key" and .principal.canUpload == true and .principal.canDownload == true' \
    "$private/session.json" >/dev/null || fail 'Session must authenticate this key with upload and download permissions; HTTP 200 alone is insufficient.'

if [[ $# == 1 ]]; then
    [[ -f $1 && -r $1 ]] || fail 'Input must be a readable regular file.'
    input=$(realpath -- "$1")
else
    input="$private/synthetic.txt"
    printf '%s\n' 'AgentFiles synthetic round trip' > "$input"
fi
[[ ! $input =~ [[:cntrl:]] ]] || fail 'Input path contains control characters.'
source_sha=$(hash_file "$input")
form_path=${input//\\/\\\\}
form_path=${form_path//\"/\\\"}
request POST "$base/api/files" "$private/upload.json" \
    --form "file=@\"$form_path\";filename=\"upload.bin\";type=application/octet-stream"
jq -e 'type == "object" and (.code | type == "string") and (.created_at | type == "string")' \
    "$private/upload.json" >/dev/null || fail 'Unverifiable upload response: do not repeat POST.'
code=$(jq -r '.code' "$private/upload.json")
[[ $code =~ ^F-[A-Z2-9]+$ ]] || fail 'Unexpected code: inspect the upload response before further action.'
[[ $(jq -r '.api_download_url' "$private/upload.json") == "$base/api/files/$code/download" ]] || fail 'Upload download URL does not match the configured origin and code.'
[[ $(jq -r '.private_url' "$private/upload.json") == "$base/files/$code" ]] || fail 'Upload private URL does not match the configured origin and code.'
jq '{uploaded: {name, code, private_url, expires_at, sha256}}' "$private/upload.json"
request GET "$base/api/files/$code" "$private/metadata.json"
jq -e --slurpfile uploaded "$private/upload.json" \
    '.code == $uploaded[0].code and .created_at == $uploaded[0].created_at' \
    "$private/metadata.json" >/dev/null || fail 'Metadata does not match this upload.'
remote_sha=$(jq -r '.sha256 // empty' "$private/metadata.json")
[[ -z $remote_sha || $remote_sha == "$source_sha" ]] || fail 'Upload checksum mismatch.'
download_url=$(jq -r '.api_download_url' "$private/metadata.json")
# Exact route comparison also rejects query/fragment/userinfo and origin lookalikes.
[[ $download_url == "$base/api/files/$code/download" ]] || fail 'Returned download URL does not match the configured origin and code.'
private_url=$(jq -r '.private_url' "$private/metadata.json")
[[ $private_url == "$base/files/$code" ]] || fail 'Returned private URL does not match the configured origin and code.'
download_dir=$(mktemp -d './agentfiles-download.XXXXXXXX')
chmod 700 "$download_dir"
# No remote filename or Content-Disposition can choose a local path.
destination="$download_dir/download.bin"
(set -o noclobber; : > "$destination")
request GET "$download_url" "$destination" --max-filesize 1073741824
download_sha=$(hash_file "$destination")
[[ $download_sha == "$source_sha" ]] || fail 'Download checksum mismatch; partial output removed.'
jq --arg path "$destination" --arg sha "$download_sha" \
    '{name, code, private_url, expires_at, sha256, downloaded_to: $path, verified_sha256: $sha}' "$private/metadata.json"
success=true
