import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import discoveryExtension, { buildModel } from "../src/index.ts";

test("locales catalog provides zh-CN and en-US for every key", () => {
	const catalog = JSON.parse(
		readFileSync(new URL("../locales/index.json", import.meta.url), "utf-8"),
	) as Record<string, Record<string, string>>;
	for (const [key, entry] of Object.entries(catalog)) {
		assert.ok(typeof entry["zh-CN"] === "string" && entry["zh-CN"].length > 0, `${key} missing zh-CN`);
		assert.ok(typeof entry["en-US"] === "string" && entry["en-US"].length > 0, `${key} missing en-US`);
	}
});

test("default export is an extension factory", async () => {
	const mod = await import("../index.ts");
	assert.equal(typeof mod.default, "function");
});

/** 隔离 agent 配置目录与网络；通过扩展入口验证读取、注册和缓存。 */
async function discoveryHarness(t: TestContext, entries?: Array<Record<string, unknown>>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-models-discovery-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	const requests: Array<{ url: string; headers: RequestInit["headers"] }> = [];
	t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
		requests.push({ url, headers: init.headers });
		return Response.json({ data: entries ?? [{ id: `model-${requests.length}` }] });
	});
	const registrations = new Map<string, Parameters<ExtensionAPI["registerProvider"]>[1]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const pi: Pick<ExtensionAPI, "registerCommand" | "on"> & {
		registerProvider(id: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]): void;
	} = {
		registerProvider: (id, config) => {
			registrations.set(id, config);
		},
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		on: () => {},
	};
	return {
		dir,
		requests,
		registrations,
		commands,
		configure: (providers: Record<string, unknown>) =>
			writeFile(join(dir, "models.json"), JSON.stringify({ providers })),
		start: () => discoveryExtension(pi as ExtensionAPI),
	};
}

const refreshContext = (allowNetwork: boolean) => ({
	allowNetwork,
	signal: new AbortController().signal,
	publish: async () => true,
});

const discoveryProvider = {
	baseUrl: "https://api.example.com/v1///",
	api: "openai-completions",
	discoverModels: true,
};

test("discovery defaults to baseUrl/models when modelsUrl is absent or empty", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		absent: discoveryProvider,
		empty: { ...discoveryProvider, modelsUrl: "" },
		nonString: { ...discoveryProvider, modelsUrl: 123 },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://api.example.com/v1/models"]);
	assert.equal(h.registrations.size, 3);
	for (const config of h.registrations.values()) assert.equal(config.models?.[0].id, "model-1");
});

test("modelsUrl is used verbatim with existing authentication and refresh behavior", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/custom/models?region=test";
	await h.configure({ foo: {
		...discoveryProvider,
		modelsUrl,
		apiKey: "test-key",
		headers: { "X-Catalog": "test" },
	} });
	await h.start();
	const config = h.registrations.get("foo")!;
	assert.equal(config.baseUrl, discoveryProvider.baseUrl);
	assert.equal("modelsUrl" in config, false);
	assert.deepEqual(h.requests, [{ url: modelsUrl, headers: { "X-Catalog": "test", Authorization: "Bearer test-key" } }]);
	assert.equal((await config.refreshModels!(refreshContext(false)))[0].id, "model-1");
	assert.equal(h.requests.length, 1);
	assert.equal((await config.refreshModels!(refreshContext(true)))[0].id, "model-2");
	assert.equal(h.requests[1].url, modelsUrl);
	await h.commands.get("config:model-discovery-refresh")!.handler("", {
		hasUI: true,
		ui: { notify: () => {} },
	} as unknown as Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1]);
	assert.equal(h.requests[2].url, modelsUrl);
});

test("request cache separates different modelsUrl values and shares identical endpoints", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/first" },
		bar: { ...discoveryProvider, modelsUrl: "https://catalog.example.com/second" },
		shared: { ...discoveryProvider, baseUrl: "https://other.example.com/v1", modelsUrl: "https://catalog.example.com/first" },
	});
	await h.start();
	assert.deepEqual(h.requests.map((r) => r.url), ["https://catalog.example.com/first", "https://catalog.example.com/second"]);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "model-1");
	assert.equal(h.registrations.get("bar")!.models?.[0].id, "model-2");
	assert.equal(h.registrations.get("shared")!.models?.[0].id, "model-1");
});

test("shared modelsUrl does not mix provider compatibility settings", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	await h.configure({
		foo: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: true } },
		bar: { ...discoveryProvider, modelsUrl, compat: { supportsDeveloperRole: false } },
	});
	await h.start();
	assert.equal(h.requests.length, 2);
	assert.deepEqual(h.registrations.get("foo")!.models?.[0].compat, { supportsDeveloperRole: true });
	assert.deepEqual(h.registrations.get("bar")!.models?.[0].compat, { supportsDeveloperRole: false });
});

test("a failing modelsUrl keeps fallback registration without retrying baseUrl", async (t) => {
	const h = await discoveryHarness(t);
	const modelsUrl = "https://catalog.example.com/models";
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		requests.push(url);
		return url === modelsUrl ? new Response(null, { status: 401 }) : Response.json({ data: [{ id: "healthy" }] });
	});
	await h.configure({
		failed: { ...discoveryProvider, modelsUrl, models: [{ id: "handwritten" }] },
		healthy: discoveryProvider,
	});
	await h.start();
	assert.deepEqual(requests, [modelsUrl, "https://api.example.com/v1/models"]);
	const failed = h.registrations.get("failed")!;
	assert.equal(failed.baseUrl, discoveryProvider.baseUrl);
	assert.equal(failed.models, undefined, "do not override handwritten fallback models");
	await assert.rejects(() => failed.refreshModels!(refreshContext(false)));
	assert.equal(h.registrations.get("healthy")!.models?.[0].id, "healthy");
});

test("providers without modelsUrl reuse cache fingerprints from before this feature", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			fetchedAt: "2026-01-01T00:00:00.000Z",
			models: [buildModel({ id: "cached" })],
		} },
	}));
	await h.start();
	assert.equal(h.requests.length, 0);
	assert.equal(h.registrations.get("foo")!.models?.[0].id, "cached");
});

test("persistent cache is reused and invalidated when modelsUrl is added, changed or removed", async (t) => {
	const h = await discoveryHarness(t);
	for (const modelsUrl of [undefined, "https://catalog.example.com/first", "https://catalog.example.com/second", undefined]) {
		await h.configure({ foo: { ...discoveryProvider, modelsUrl } });
		await h.start();
		const count = h.requests.length;
		await h.start();
		assert.equal(h.requests.length, count, "unchanged configuration must not fetch again");
		assert.equal(h.registrations.get("foo")!.models?.[0].id, `model-${count}`);
	}
	assert.deepEqual(h.requests.map((r) => r.url), [
		"https://api.example.com/v1/models",
		"https://catalog.example.com/first",
		"https://catalog.example.com/second",
		"https://api.example.com/v1/models",
	]);
});

test("context window falls back to vLLM max_model_len", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "vllm", max_model_len: 200_000 },
		{ id: "explicit", context_window: 128_000, max_model_len: 200_000 },
		{ id: "bare" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	const windows = h.registrations.get("foo")!.models!.map((m) => [m.id, m.contextWindow]);
	assert.deepEqual(windows, [["vllm", 200_000], ["explicit", 128_000], ["bare", 1_000_000]]);
});

test("discovery reads gateway and Anthropic token limits without replacing existing aliases", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "gateway", context_length: 1_050_000, max_context_length: 2_000_000, max_output_tokens: 128_000, max_completion_tokens: 4096 },
		{ id: "anthropic", max_input_tokens: 200_000, max_tokens: 32_000 },
		{ id: "groq", context_window: 131_072, max_completion_tokens: 32_768 },
		{ id: "mistral", max_context_length: 32_768, max_input_tokens: 64_000 },
		{ id: "snake", context_window: 128_000, context_length: 256_000, max_tokens: 4096, max_output_tokens: 8192 },
		{ id: "camel", contextWindow: 64_000, context_length: 256_000, maxTokens: 2048, max_output_tokens: 8192 },
		{ id: "vllm", max_model_len: 48_000, context_length: 256_000, max_output_tokens: 1024 },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.id, m.contextWindow, m.maxTokens]), [
		["gateway", 1_050_000, 128_000],
		["anthropic", 200_000, 32_000],
		["groq", 131_072, 32_768],
		["mistral", 32_768, 65_536],
		["snake", 128_000, 4096],
		["camel", 64_000, 2048],
		["vllm", 48_000, 1024],
	]);
});

test("invalid token limits fall through to a valid alias or the existing defaults", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "fallback", context_window: 0, contextWindow: -1, max_model_len: "broken", context_length: 256_000,
			max_tokens: -1, maxTokens: "broken", max_output_tokens: 8192 },
		{ id: "invalid", context_length: 1.5, max_input_tokens: null, max_output_tokens: 0 },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.contextWindow, m.maxTokens]), [
		[256_000, 8192], [1_000_000, 65_536],
	]);
});

test("discovery uses display_name only when name is absent or invalid", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "named", name: "Explicit name", display_name: "Display name" },
		{ id: "display", display_name: "Display name" },
		{ id: "invalid", name: 123, display_name: "Valid display name" },
		{ id: "bare", name: "", display_name: null },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => m.name), [
		"Explicit name", "Display name", "Valid display name", "bare",
	]);
});

test("discovery maps advertised image and reasoning capabilities, preserving explicit false", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "text", capabilities: { vision: false, reasoning: false } },
		{ id: "anthropic", capabilities: { image_input: { supported: true }, thinking: { supported: true } } },
		{ id: "disabled", capabilities: { image_input: { supported: false }, thinking: { supported: false } } },
		{ id: "explicit", input: ["text"], reasoning: false, capabilities: { vision: true, thinking: { supported: true } } },
		{ id: "image-only", input: ["image", "audio"], capabilities: { vision: false } },
		{ id: "unknown" },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => [m.id, m.input, m.reasoning]), [
		["text", ["text"], false],
		["anthropic", ["text", "image"], true],
		["disabled", ["text"], false],
		["explicit", ["text"], false],
		["image-only", ["text", "image"], true],
		["unknown", ["text", "image"], true],
	]);
});

test("discovery maps per-million prices directly into Pi token costs", async (t) => {
	const h = await discoveryHarness(t, [{
		id: "priced",
		pricing: {
			input_per_million: 1.36,
			output_per_million: 6.8,
			cache_read_input_per_million: 0.068,
			cache_creation_input_per_million: 1.7,
		},
	}]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models![0].cost, {
		input: 1.36, output: 6.8, cacheRead: 0.068, cacheWrite: 1.7,
	});
});

test("explicit costs win over pricing and invalid prices never become negative or unknown-unit costs", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "explicit", cost: { input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			pricing: { input_per_million: 3, output_per_million: 4 } },
		{ id: "snake", cost: { input: -1, cache_read: 0.3, cache_write: 0.4 },
			pricing: { input_per_million: 1, output_per_million: 2 } },
		{ id: "invalid", pricing: { input_per_million: -1, output_per_million: "broken",
			cache_read_input_per_million: null, prompt: "0.000001", completion: "0.000002" } },
	]);
	await h.configure({ foo: discoveryProvider });
	await h.start();
	assert.deepEqual(h.registrations.get("foo")!.models!.map((m) => m.cost), [
		{ input: 0, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		{ input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4 },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	]);
});

test("advertised metadata survives cached startup, offline reads and online refresh", async (t) => {
	const entries = [{ id: "metadata", display_name: "Metadata", context_length: 256_000,
		max_output_tokens: 8192, input: ["text"], reasoning: false,
		pricing: { input_per_million: 1, output_per_million: 2 } }];
	const h = await discoveryHarness(t, entries);
	await h.configure({ foo: discoveryProvider });
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		const config = h.registrations.get("foo")!;
		for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
			assert.equal(models[0].name, "Metadata");
			assert.equal(models[0].contextWindow, 256_000);
			assert.equal(models[0].maxTokens, 8192);
			assert.deepEqual(models[0].input, ["text"]);
			assert.equal(models[0].reasoning, false);
			assert.deepEqual(models[0].cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
		}
	}
	assert.equal(h.requests.length, 1, "cached startup and offline reads must not fetch");
	entries[0].max_output_tokens = 16_384;
	entries[0].pricing.input_per_million = 3;
	const refreshed = await h.registrations.get("foo")!.refreshModels!(refreshContext(true));
	assert.equal(refreshed[0].maxTokens, 16_384);
	assert.equal(refreshed[0].cost.input, 3);
	assert.equal(h.requests.length, 2);
});

test("provider reasoning overrides take priority over advertised metadata", async (t) => {
	const h = await discoveryHarness(t, [
		{ id: "disabled", reasoning: false },
		{ id: "enabled", capabilities: { thinking: { supported: true } } },
	]);
	await h.configure({
		on: { ...discoveryProvider, compat: { reasoning: true } },
		off: { ...discoveryProvider, compat: { reasoning: false } },
	});
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		for (const [id, config] of h.registrations) {
			for (const models of [config.models!, await config.refreshModels!(refreshContext(false)), await config.refreshModels!(refreshContext(true))]) {
				assert.deepEqual(models.map((m) => m.reasoning), id === "on" ? [true, true] : [false, false]);
			}
		}
	}
});

test("discovered models do not assume xhigh and max support", () => {
	const model = buildModel({ id: "some-model" }) as unknown as Model<Api>;
	assert.deepEqual(model.thinkingLevelMap, { xhigh: null, max: null });
	assert.deepEqual(getSupportedThinkingLevels(model), [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);
});

test("provider thinking overrides apply to discovery, cache and online refresh", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({
		local: { ...discoveryProvider, compat: {
			reasoning: false,
			thinkingLevelMap: { minimal: null, high: null, xhigh: null, max: null },
			supportsReasoningEffort: false,
			thinkingFormat: "qwen",
		} },
		optIn: { ...discoveryProvider, compat: { thinkingLevelMap: { xhigh: "high", max: "max" } } },
	});
	for (let startup = 0; startup < 2; startup++) {
		await h.start();
		for (const [id, config] of h.registrations) {
			for (const models of [config.models!, await config.refreshModels!(refreshContext(false)), await config.refreshModels!(refreshContext(true))]) {
				const model = models[0] as unknown as Model<Api>;
				if (id === "local") {
					assert.equal(model.reasoning, false);
					assert.deepEqual(getSupportedThinkingLevels(model), ["off"]);
					assert.deepEqual(model.thinkingLevelMap, { minimal: null, high: null, xhigh: null, max: null });
					assert.deepEqual(model.compat, { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen" });
				} else {
					assert.equal(model.reasoning, true);
					assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
					assert.deepEqual(model.thinkingLevelMap, { xhigh: "high", max: "max" });
				}
			}
		}
	}
	assert.equal(h.requests.length, 6, "second startup must reuse the persistent cache");
});

test("legacy cached thinking defaults are corrected without network access", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			models: [{ ...buildModel({ id: "cached", name: "Cached", contextWindow: 128_000, maxTokens: 4096 }), thinkingLevelMap: { xhigh: "xhigh", max: "max" } }],
		} },
	}));
	await h.start();
	const config = h.registrations.get("foo")!;
	for (const models of [config.models!, await config.refreshModels!(refreshContext(false))]) {
		assert.deepEqual(models[0].thinkingLevelMap, { xhigh: null, max: null });
		assert.equal(models[0].name, "Cached");
		assert.equal(models[0].contextWindow, 128_000);
		assert.equal(models[0].maxTokens, 4096);
	}
	assert.equal(h.requests.length, 0);
});

test("cached startup ignores non-boolean reasoning values", async (t) => {
	const h = await discoveryHarness(t);
	await h.configure({ foo: discoveryProvider });
	const cacheDir = join(h.dir, "extensions", "pi-models-discovery");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, "cache.json"), JSON.stringify({
		version: 1,
		providers: { foo: {
			fingerprint: JSON.stringify([discoveryProvider.baseUrl, discoveryProvider.api, "", {}, {}]),
			models: [{ ...buildModel({ id: "cached" }), reasoning: "no" }],
		} },
	}));
	await h.start();
	assert.equal(h.registrations.get("foo")!.models![0].reasoning, true);
	assert.equal(h.requests.length, 0);
});
