/**
 * pi-proxy — route selected models through an HTTP(S) proxy.
 *
 * Config: ~/.pi/agent/pi-proxy.json  (see config.example.json)
 * Override path via PI_PROXY_CONFIG.
 *
 * Implementation:
 * - undici RoutingDispatcher via setGlobalDispatcher (covers Anthropic/OpenAI SDKs + fetch)
 * - process.env HTTP(S)_PROXY for Bedrock / env-based clients
 * - only hosts of matched models are proxied; everything else stays direct
 */

import { readFile, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	Agent,
	Dispatcher,
	ProxyAgent,
	getGlobalDispatcher,
	setGlobalDispatcher,
} from "undici";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const readFileAsync = promisify(readFile);

const STATUS_KEY = "pi-proxy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProxyRule {
	/** Glob(s) like "openai/*", "anthropic/claude-opus*", or "provider/model" */
	match: string | string[];
	/** Optional per-rule proxy URL; falls back to top-level proxy */
	proxy?: string;
}

interface ProxyConfig {
	/**
	 * Opt-in. Default false — nothing is proxied until set true
	 * in config or via `/proxy on`.
	 */
	enabled?: boolean;
	/** Default HTTP(S) proxy URL, e.g. "http://127.0.0.1:7890" */
	proxy?: string;
	/** Friendly notify on connect / error (default true) */
	notify?: boolean;
	/** Footer status indicator (default true) */
	status?: boolean;
	/** TCP probe proxy when activating (default true) */
	probe?: boolean;
	/** Model match rules */
	rules?: ProxyRule[];
	/**
	 * Flat list of match globs using top-level proxy.
	 * Convenience alternative / addition to rules.
	 */
	models?: string[];
}

interface ActiveRoute {
	modelKey: string;
	proxyUrl: string;
	/** Hostnames (lowercased, no port) routed through the proxy */
	hosts: Set<string>;
	/** Origins like "https://api.openai.com" for display */
	origins: string[];
}

// ---------------------------------------------------------------------------
// Glob match (simple * wildcards)
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesGlob(value: string, glob: string): boolean {
	return globToRegExp(glob).test(value);
}

// ---------------------------------------------------------------------------
// Config load
// ---------------------------------------------------------------------------

function configPath(): string {
	if (process.env.PI_PROXY_CONFIG) return process.env.PI_PROXY_CONFIG;
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "pi-proxy.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeConfig(raw: unknown): ProxyConfig {
	if (!isRecord(raw)) return { enabled: false, rules: [] };
	const rules: ProxyRule[] = [];
	if (Array.isArray(raw.rules)) {
		for (const r of raw.rules) {
			if (!isRecord(r) || r.match === undefined) continue;
			rules.push({
				match: r.match as string | string[],
				proxy: typeof r.proxy === "string" ? r.proxy : undefined,
			});
		}
	}
	if (Array.isArray(raw.models)) {
		for (const m of raw.models) {
			if (typeof m === "string") rules.push({ match: m });
		}
	}
	return {
		// Opt-in only: missing/undefined/false → off
		enabled: raw.enabled === true,
		proxy: typeof raw.proxy === "string" ? raw.proxy : process.env.PI_PROXY || undefined,
		notify: raw.notify !== false,
		status: raw.status !== false,
		probe: raw.probe !== false,
		rules,
		models: Array.isArray(raw.models)
			? raw.models.filter((m): m is string => typeof m === "string")
			: undefined,
	};
}

async function loadConfig(): Promise<{ config: ProxyConfig; error?: string }> {
	const path = configPath();
	try {
		const text = await readFileAsync(path, "utf8");
		return { config: normalizeConfig(JSON.parse(text)) };
	} catch (err) {
		const code = isRecord(err) ? err.code : undefined;
		if (code === "ENOENT") {
			// No config file: allow env-only mode if PI_PROXY + PI_PROXY_MODELS set
			const envProxy = process.env.PI_PROXY;
			const envModels = process.env.PI_PROXY_MODELS;
			if (envProxy && envModels) {
				// Env pair is an explicit opt-in (no config file)
				return {
					config: normalizeConfig({
						enabled: true,
						proxy: envProxy,
						models: envModels.split(",").map((s) => s.trim()).filter(Boolean),
					}),
				};
			}
			return {
				config: { enabled: false, rules: [] },
				error: `no config at ${path} — see README / config.example.json`,
			};
		}
		return {
			config: { enabled: false, rules: [] },
			error: `failed to read config: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Rule resolution
// ---------------------------------------------------------------------------

function resolveProxyForModel(
	config: ProxyConfig,
	provider: string,
	modelId: string,
): string | undefined {
	if (config.enabled !== true) return undefined;
	const key = `${provider}/${modelId}`;
	const rules = config.rules ?? [];
	for (const rule of rules) {
		const patterns = Array.isArray(rule.match) ? rule.match : [rule.match];
		for (const pat of patterns) {
			if (matchesGlob(key, pat) || matchesGlob(provider, pat) || matchesGlob(modelId, pat)) {
				const url = rule.proxy ?? config.proxy;
				if (url) return url;
			}
		}
	}
	return undefined;
}

function hostFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function originFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		return u.origin;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// undici routing dispatcher
// ---------------------------------------------------------------------------

class RoutingDispatcher extends Dispatcher {
	#direct: Agent;
	#proxies = new Map<string, ProxyAgent>();
	/** host -> proxyUrl */
	#hostRoutes = new Map<string, string>();
	#closed = false;

	constructor() {
		super();
		this.#direct = new Agent();
	}

	/** Replace all host routes. proxyUrl may be shared across hosts. */
	setRoutes(hosts: Iterable<string>, proxyUrl: string | undefined): void {
		this.#hostRoutes.clear();
		if (!proxyUrl) return;
		for (const h of hosts) {
			this.#hostRoutes.set(h.toLowerCase(), proxyUrl);
		}
	}

	clearRoutes(): void {
		this.#hostRoutes.clear();
	}

	#agentFor(proxyUrl: string | undefined): Dispatcher {
		if (!proxyUrl) return this.#direct;
		let agent = this.#proxies.get(proxyUrl);
		if (!agent) {
			agent = new ProxyAgent(proxyUrl);
			this.#proxies.set(proxyUrl, agent);
		}
		return agent;
	}

	#pick(options: Dispatcher.DispatchOptions): Dispatcher {
		const origin = options.origin;
		let hostname: string | undefined;
		if (typeof origin === "string") {
			try {
				hostname = new URL(origin).hostname.toLowerCase();
			} catch {
				hostname = origin.toLowerCase();
			}
		} else if (origin instanceof URL) {
			hostname = origin.hostname.toLowerCase();
		}
		const proxyUrl = hostname ? this.#hostRoutes.get(hostname) : undefined;
		return this.#agentFor(proxyUrl);
	}

	dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
		return this.#pick(options).dispatch(options, handler);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const closers: Promise<unknown>[] = [this.#direct.close()];
		for (const p of this.#proxies.values()) closers.push(p.close());
		await Promise.allSettled(closers);
	}

	async destroy(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const closers: Promise<unknown>[] = [this.#direct.destroy()];
		for (const p of this.#proxies.values()) closers.push(p.destroy());
		await Promise.allSettled(closers);
	}
}

// ---------------------------------------------------------------------------
// Env proxy helpers (Bedrock / resolveHttpProxyUrlForTarget)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function snapshotEnv(): EnvSnapshot {
	const snap: EnvSnapshot = {};
	for (const k of ENV_KEYS) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
	for (const k of ENV_KEYS) {
		const v = snap[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function applyEnvProxy(proxyUrl: string): void {
	process.env.HTTP_PROXY = proxyUrl;
	process.env.HTTPS_PROXY = proxyUrl;
	process.env.ALL_PROXY = proxyUrl;
	process.env.http_proxy = proxyUrl;
	process.env.https_proxy = proxyUrl;
	process.env.all_proxy = proxyUrl;
}

// ---------------------------------------------------------------------------
// Proxy probe
// ---------------------------------------------------------------------------

async function probeProxy(proxyUrl: string, timeoutMs = 2500): Promise<{ ok: boolean; detail: string }> {
	let url: URL;
	try {
		url = new URL(proxyUrl);
	} catch {
		return { ok: false, detail: `invalid proxy URL: ${proxyUrl}` };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, detail: `unsupported proxy protocol ${url.protocol} (use http:// or https://)` };
	}

	const host = url.hostname;
	const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);

	// TCP connect probe via undici CONNECT through ProxyAgent itself
	const agent = new ProxyAgent(proxyUrl);
	try {
		// Hit a cheap endpoint via the proxy; any response (even 4xx) means proxy works
		const res = await agent.request({
			origin: "https://api.openai.com",
			method: "HEAD",
			path: "/",
			headersTimeout: timeoutMs,
			bodyTimeout: timeoutMs,
			// some proxies reject HEAD to openai — treat network success as ok
		});
		res.body.destroy();
		return { ok: true, detail: `${host}:${port} reachable (HTTP ${res.statusCode})` };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// ECONNREFUSED / ENOTFOUND on proxy itself
		if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|connect/i.test(msg)) {
			return { ok: false, detail: `cannot reach proxy ${host}:${port} — ${msg}` };
		}
		// Proxy reached but upstream failed: still "connected" to proxy
		if (/UND_ERR|socket|TLS|certificate|status/i.test(msg)) {
			return { ok: true, detail: `${host}:${port} accepting connections` };
		}
		return { ok: false, detail: msg };
	} finally {
		await agent.close().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function shortProxy(proxyUrl: string): string {
	try {
		const u = new URL(proxyUrl);
		const auth = u.username ? `${u.username}@` : "";
		return `${u.protocol}//${auth}${u.host}`;
	} catch {
		return proxyUrl;
	}
}

function modelLabel(provider: string, id: string): string {
	return `${provider}/${id}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const router = new RoutingDispatcher();
	const previousDispatcher = getGlobalDispatcher();
	setGlobalDispatcher(router);

	const originalEnv = snapshotEnv();
	let config: ProxyConfig = { enabled: false, rules: [] };
	let active: ActiveRoute | null = null;
	let lastNotifiedKey: string | undefined;
	let configError: string | undefined;
	let watcher: FSWatcher | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	function clearStatus(ctx?: ExtensionContext): void {
		ctx?.ui.setStatus(STATUS_KEY, undefined);
	}

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		if (config.status === false) {
			clearStatus(ctx);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info"): void {
		if (config.notify === false) return;
		if (!ctx.hasUI) return;
		ctx.ui.notify(msg, level);
	}

	function deactivate(ctx?: ExtensionContext): void {
		active = null;
		router.clearRoutes();
		restoreEnv(originalEnv);
		if (ctx) {
			clearStatus(ctx);
		}
	}

	async function activateForModel(
		ctx: ExtensionContext,
		provider: string,
		modelId: string,
		baseUrl: string | undefined,
		source: string,
	): Promise<void> {
		const modelKey = modelLabel(provider, modelId);
		const proxyUrl = resolveProxyForModel(config, provider, modelId);

		if (!proxyUrl) {
			if (active) {
				deactivate(ctx);
				if (source !== "restore") {
					// silent when leaving proxy model — only noise if user cares
				}
			}
			return;
		}

		const host = hostFromUrl(baseUrl);
		const origin = originFromUrl(baseUrl);
		const hosts = new Set<string>();
		if (host) hosts.add(host);

		// Common provider hosts if baseUrl missing / incomplete
		const fallbackHosts: Record<string, string[]> = {
			openai: ["api.openai.com"],
			anthropic: ["api.anthropic.com"],
			google: ["generativelanguage.googleapis.com"],
			"google-vertex": ["aiplatform.googleapis.com"],
			xai: ["api.x.ai"],
			groq: ["api.groq.com"],
			mistral: ["api.mistral.ai"],
			openrouter: ["openrouter.ai"],
			deepseek: ["api.deepseek.com"],
			together: ["api.together.xyz"],
			fireworks: ["api.fireworks.ai"],
			"openai-codex": ["chatgpt.com", "api.openai.com"],
			"github-copilot": ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com"],
		};
		for (const h of fallbackHosts[provider] ?? []) hosts.add(h);

		const same =
			active &&
			active.modelKey === modelKey &&
			active.proxyUrl === proxyUrl &&
			hosts.size === active.hosts.size &&
			[...hosts].every((h) => active!.hosts.has(h));

		if (same) {
			setStatus(ctx, ` ent ${shortProxy(proxyUrl)}`);
			return;
		}

		active = {
			modelKey,
			proxyUrl,
			hosts,
			origins: origin ? [origin] : [...hosts],
		};
		router.setRoutes(hosts, proxyUrl);
		// Env proxy only for SDKs that read HTTP(S)_PROXY (e.g. Bedrock).
		// Fetch/OpenAI/Anthropic go through undici RoutingDispatcher.
		if (provider === "amazon-bedrock") {
			applyEnvProxy(proxyUrl);
		} else {
			restoreEnv(originalEnv);
		}

		const proxyLabel = shortProxy(proxyUrl);
		setStatus(ctx, `⇄ ${proxyLabel}`);

		// Avoid spam on session restore of same model repeatedly
		const notifyKey = `${modelKey}|${proxyUrl}`;
		const shouldNotify = source !== "restore" || lastNotifiedKey !== notifyKey;
		lastNotifiedKey = notifyKey;

		if (config.probe !== false) {
			const result = await probeProxy(proxyUrl);
			if (result.ok) {
				if (shouldNotify) {
					notify(
						ctx,
						`pi-proxy: ${modelKey} → ${proxyLabel}\n${result.detail}`,
						"info",
					);
				}
			} else {
				notify(
					ctx,
					`pi-proxy: connected route for ${modelKey} → ${proxyLabel}\n⚠ ${result.detail}`,
					"warning",
				);
			}
		} else if (shouldNotify) {
			notify(ctx, `pi-proxy: ${modelKey} via ${proxyLabel}`, "info");
		}
	}

	async function reloadConfig(ctx?: ExtensionContext): Promise<void> {
		const { config: next, error } = await loadConfig();
		config = next;
		configError = error;
		if (error && ctx) {
			notify(ctx, `pi-proxy: ${error}`, "warning");
		}
		// Re-apply for current model if any
		if (ctx?.model) {
			await activateForModel(
				ctx,
				ctx.model.provider,
				ctx.model.id,
				ctx.model.baseUrl,
				"reload",
			);
		} else if (!config.enabled || !(config.rules?.length)) {
			deactivate(ctx);
		}
	}

	// Load config eagerly so first model_select is ready
	void loadConfig().then(({ config: c, error }) => {
		config = c;
		configError = error;
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadConfig(ctx);

		if (configError && config.enabled !== false) {
			// already notified in reloadConfig when ctx present
		}

		// Watch config for hot reload
		try {
			watcher?.close();
			watcher = watch(configPath(), { persistent: false }, () => {
				if (reloadTimer) clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => {
					void reloadConfig(ctx);
				}, 150);
			});
			watcher.on("error", () => {
				/* file may not exist yet */
			});
		} catch {
			/* no watch if missing */
		}

		if (ctx.model) {
			await activateForModel(
				ctx,
				ctx.model.provider,
				ctx.model.id,
				ctx.model.baseUrl,
				"restore",
			);
		}
	});

	pi.on("model_select", async (event, ctx) => {
		await activateForModel(
			ctx,
			event.model.provider,
			event.model.id,
			event.model.baseUrl,
			event.source,
		);
	});

	// Friendly errors when a proxied request fails
	pi.on("message_end", async (event, ctx) => {
		if (!active) return;
		const msg = event.message;
		if (!msg || typeof msg !== "object") return;
		const m = msg as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			provider?: string;
			model?: string;
		};
		if (m.role !== "assistant") return;
		if (m.stopReason !== "error" || !m.errorMessage) return;

		const err = m.errorMessage;
		const proxyish =
			/proxy|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|tunnel|CONNECT|UND_ERR|socket hang up|network/i.test(
				err,
			);
		if (!proxyish && !/fetch failed|Connect Timeout|network/i.test(err)) return;

		notify(
			ctx,
			`pi-proxy error for ${active.modelKey} via ${shortProxy(active.proxyUrl)}\n${err}`,
			"error",
		);
		setStatus(ctx, `⇄ err ${shortProxy(active.proxyUrl)}`);
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!active) return;
		if (event.status >= 200 && event.status < 400) {
			setStatus(ctx, `⇄ ${shortProxy(active.proxyUrl)}`);
		} else if (event.status === 407) {
			notify(
				ctx,
				`pi-proxy: proxy authentication required (HTTP 407) for ${shortProxy(active.proxyUrl)}`,
				"error",
			);
			setStatus(ctx, `⇄ auth? ${shortProxy(active.proxyUrl)}`);
		} else if (event.status >= 500) {
			setStatus(ctx, `⇄ ${event.status} ${shortProxy(active.proxyUrl)}`);
		}
	});

	pi.on("session_shutdown", async () => {
		if (reloadTimer) clearTimeout(reloadTimer);
		watcher?.close();
		watcher = undefined;
		deactivate();
		// Keep global dispatcher until process exit — other sessions may reuse.
		// On full exit, restore.
	});

	pi.registerCommand("proxy", {
		description: "Show or control pi-proxy (off by default; /proxy on to enable)",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			if (sub === "reload") {
				await reloadConfig(ctx);
				ctx.ui.notify(
					`pi-proxy: config reloaded (enabled=${config.enabled === true})`,
					"info",
				);
				return;
			}
			if (sub === "off") {
				config = { ...config, enabled: false };
				deactivate(ctx);
				ctx.ui.notify("pi-proxy: off (session)", "info");
				return;
			}
			if (sub === "on") {
				// Keep rules/proxy from disk, force enable for this session only
				const prevEnabled = config.enabled;
				const { config: next, error } = await loadConfig();
				config = { ...next, enabled: true };
				configError = error;
				if (!config.proxy && !(config.rules?.some((r) => r.proxy))) {
					ctx.ui.notify(
						"pi-proxy: no proxy URL configured — set proxy in pi-proxy.json",
						"error",
					);
					return;
				}
				if (ctx.model) {
					await activateForModel(
						ctx,
						ctx.model.provider,
						ctx.model.id,
						ctx.model.baseUrl,
						"set",
					);
				}
				if (!active) {
					ctx.ui.notify(
						"pi-proxy: on, but current model not in rules (direct)",
						"warning",
					);
				} else if (prevEnabled !== true) {
					// activateForModel already notified on connect
				} else {
					ctx.ui.notify("pi-proxy: on", "info");
				}
				return;
			}
			if (sub === "probe") {
				const url = active?.proxyUrl ?? config.proxy;
				if (!url) {
					ctx.ui.notify("pi-proxy: no proxy configured", "warning");
					return;
				}
				const result = await probeProxy(url);
				ctx.ui.notify(
					result.ok
						? `pi-proxy probe ok: ${result.detail}`
						: `pi-proxy probe failed: ${result.detail}`,
					result.ok ? "info" : "error",
				);
				return;
			}

			const lines = [
				`config: ${configPath()}`,
				`enabled: ${config.enabled === true}  (opt-in; /proxy on)`,
				`default proxy: ${config.proxy ? shortProxy(config.proxy) : "(none)"}`,
				`rules: ${config.rules?.length ?? 0}`,
			];
			if (configError) lines.push(`config note: ${configError}`);
			if (active) {
				lines.push(`active: ${active.modelKey}`);
				lines.push(`via: ${shortProxy(active.proxyUrl)}`);
				lines.push(`hosts: ${[...active.hosts].join(", ")}`);
			} else {
				lines.push("active: (direct — current model not matched)");
			}
			if (ctx.model) {
				const match = resolveProxyForModel(config, ctx.model.provider, ctx.model.id);
				lines.push(
					`current model: ${ctx.model.provider}/${ctx.model.id} → ${match ? shortProxy(match) : "direct"}`,
				);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Best-effort restore on process exit (do not hook SIGINT — pi owns that)
	process.once("exit", () => {
		try {
			restoreEnv(originalEnv);
			setGlobalDispatcher(previousDispatcher);
			void router.close();
		} catch {
			/* ignore */
		}
	});
}

export { RoutingDispatcher, resolveProxyForModel, matchesGlob, normalizeConfig };
