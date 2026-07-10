# pi-proxy

Route **selected** pi models through an HTTP(S) proxy. **Off by default** — opt-in only.

```bash
pi install git:github.com/nounder/pi-proxy
```

Needs local **HTTP** proxy (`http://host:port`). SOCKS/PAC not supported.

## Enable

1. Write rules + proxy URL in config (still disabled)
2. Turn on:
   - `/proxy on` — this session, or
   - `"enabled": true` in config — every session

Unmatched models always stay direct. Matched models stay direct until enabled.

## Config

`~/.pi/agent/pi-proxy.json` (hot-reloaded):

```json
{
  "enabled": false,
  "proxy": "http://127.0.0.1:7890",
  "notify": true,
  "status": true,
  "probe": true,
  "rules": [
    { "match": ["openai/*", "openai-codex/*", "anthropic/*"] }
  ]
}
```

| field | meaning |
|-------|---------|
| `enabled` | **opt-in** (default `false`) |
| `proxy` | default HTTP proxy URL |
| `rules[].match` | glob: `provider/model`, `provider/*`, `*` |
| `rules[].proxy` | optional override per rule |
| `models` | shorthand list of globs |
| `probe` | test proxy on activate |

Env opt-in (enables immediately):

```bash
export PI_PROXY=http://127.0.0.1:7890
export PI_PROXY_MODELS=openai/*,anthropic/*
# or config path only (still needs enabled:true in file):
export PI_PROXY_CONFIG=/path/to.json
```

## Commands

```
/proxy          status
/proxy on       enable this session
/proxy off      disable this session
/proxy reload   reread config (honors enabled in file)
/proxy probe    test proxy
```

Status bar: `⇄ http://host:port` only when active.

## How it works

- undici `setGlobalDispatcher` + host routing (OpenAI/Anthropic/fetch)
- only hosts of matched models go through proxy
- Bedrock: also sets `HTTP(S)_PROXY` while that model is active

---

## Proxy backends

pi-proxy talks to a local HTTP proxy. Pick one:

### wireproxy + WireGuard

[wireproxy](https://github.com/pufferffish/wireproxy) — userspace WG → local HTTP/SOCKS. No root/tun needed.

```bash
# macOS
brew install wireproxy
# or: go install github.com/pufferffish/wireproxy/cmd/wireproxy@latest
```

`~/.config/wireproxy.conf`:

```ini
# from your WG client config ([Interface] + [Peer])
[Interface]
Address = 10.x.x.x/32
PrivateKey = <your private key>
DNS = 1.1.1.1

[Peer]
PublicKey = <server public key>
PresharedKey = <optional>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0

# expose HTTP proxy for pi
[http]
BindAddress = 127.0.0.1:7890
```

```bash
wireproxy -c ~/.config/wireproxy.conf
# pi-proxy.json → "proxy": "http://127.0.0.1:7890"
```

Convert official WG conf → wireproxy: copy `[Interface]`/`[Peer]`, add `[http]` block.

systemd user unit (linux):

```ini
# ~/.config/systemd/user/wireproxy.service
[Service]
ExecStart=%h/go/bin/wireproxy -c %h/.config/wireproxy.conf
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now wireproxy
```

### Clash / Clash Meta / mihomo

```yaml
# config.yaml
mixed-port: 7890   # HTTP + SOCKS on same port — use HTTP for pi
# or:
port: 7890         # HTTP only
socks-port: 7891
```

```json
"proxy": "http://127.0.0.1:7890"
```

### V2Ray / Xray / sing-box

Inbound HTTP:

```json
{
  "inbounds": [{
    "type": "http",
    "listen": "127.0.0.1",
    "listen_port": 7890
  }]
}
```

sing-box same idea: `type: "http"` inbound.

### Tailscale

Exit node → whole machine routes via TS (no local HTTP proxy). Options:

1. **Userspace SOCKS + convert** — Tailscale `--socks5-server=localhost:1055`, then front with something that speaks HTTP (or run a tiny HTTP→SOCKS bridge).
2. **Subnet router / exit node** — system-wide; no pi-proxy needed (all traffic already exits via node).
3. **tsnet / proxies** — corporate setups sometimes expose HTTP on a sidecar.

If traffic already goes through Tailscale exit node, skip pi-proxy.

### Cloudflare WARP

WARP is a tunnel, not an HTTP proxy. Use:

- WARP **with** a local proxy client in front, or
- `cloudflared access` for specific hostnames (not general LLM APIs), or
- system-wide WARP (then pi-proxy unnecessary)

### Corporate HTTP proxy

```json
{
  "proxy": "http://user:pass@proxy.corp.example:8080",
  "rules": [{ "match": ["openai/*", "anthropic/*"] }]
}
```

Or env: `PI_PROXY=http://user:pass@proxy.corp:8080`.

PAC files: not supported. Resolve PAC once, hardcode resulting `http://…` URL.

### SSH dynamic forward (SOCKS) → HTTP

SSH gives SOCKS only:

```bash
ssh -D 1080 -N bastion
```

Bridge to HTTP with [gost](https://github.com/go-gost/gost) / [microsocks+privoxy] / [sshuttle] alternatives:

```bash
# gost: SOCKS upstream → local HTTP
gost -L http://127.0.0.1:7890 -F socks5://127.0.0.1:1080
```

```json
"proxy": "http://127.0.0.1:7890"
```

### OpenVPN / WireGuard system tunnel

If VPN installs a utun/tun and routes `0.0.0.0/0`, traffic already exits via VPN — **pi-proxy not needed**.

Use pi-proxy when you want **only LLM API hosts** via proxy (split), not full tunnel.

### Docker / remote proxy

```json
"proxy": "http://192.168.1.50:7890"
```

Ensure proxy allows CONNECT to `api.openai.com:443`, `api.anthropic.com:443`, etc.

---

## Minimal setups

**WireGuard laptop, only OpenAI via WG:**

```bash
wireproxy -c wg.conf   # [http] 127.0.0.1:7890
```

```json
{
  "enabled": false,
  "proxy": "http://127.0.0.1:7890",
  "rules": [{ "match": "openai/*" }]
}
```

Then `/proxy on` when you want it.

**Clash already running:**

```json
{
  "enabled": true,
  "proxy": "http://127.0.0.1:7890",
  "rules": [{ "match": ["openai/*", "anthropic/*", "google/*"] }]
}
```

**SSH bastion only:**

```bash
ssh -D 1080 -N bastion &
gost -L :7890 -F socks5://127.0.0.1:1080 &
```

## Limits

- HTTP/HTTPS proxies only (`http://`, `https://`)
- no SOCKS/PAC URLs
- host routing via undici global dispatcher (process-wide, unmatched hosts stay direct)
- Codex websocket: partial (fetch path covered; env-based ws uses proxy only if env set)

## Dev

```bash
pi -e ./extensions/pi-proxy.ts
# or
pi install /Users/you/Projects/pi-proxy
```
