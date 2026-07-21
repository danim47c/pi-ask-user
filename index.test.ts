import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	onTestFinished,
	test,
} from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let editorInputs: string[] = [];
let editorText = "";
let emittedEvents: Array<{ name: string; payload: any }> = [];

const DEFAULT_TEST_HOME = join(
	tmpdir(),
	"pi-telegram-notify-test-home-default",
	String(process.pid),
);

function installInertTestHome(): void {
	rmSync(DEFAULT_TEST_HOME, { recursive: true, force: true });
	const agentDir = join(DEFAULT_TEST_HOME, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), "{}\n");
	process.env.HOME = DEFAULT_TEST_HOME;
}

function blockUnexpectedNetworkCalls(): void {
	globalThis.fetch = mock((input: RequestInfo | URL) => {
		throw new Error(`Unexpected network call in test: ${String(input)}`);
	}) as any;
}

class MockText {
	constructor(private text: string) {}
	render() {
		return [this.text];
	}
	setText(text: string) {
		this.text = text;
	}
}

class MockContainer {
	addChild() {}
	clear() {}
	invalidate() {}
	render() {
		return [];
	}
}

class MockEditor {
	disableSubmit = false;
	onSubmit?: (text: string) => void;

	constructor(_tui: any, theme: any) {
		if (!theme?.borderColor) {
			throw new TypeError(
				"Cannot read properties of undefined (reading 'borderColor')",
			);
		}
	}

	handleInput(data?: string) {
		if (typeof data === "string") {
			editorInputs.push(data);
		}
		if (data === "enter") {
			this.onSubmit?.(editorText);
		}
	}
	getText() {
		return editorText;
	}
	setText(text = "") {
		editorText = text;
	}
}

function createKeybindings(overrides: Partial<Record<string, string[]>> = {}) {
	const bindings: Record<string, string[]> = {
		"tui.input.submit": ["enter"],
		"tui.input.newLine": ["shift+enter"],
		"tui.select.confirm": ["enter"],
		"tui.select.cancel": ["escape", "ctrl+c"],
		"tui.select.up": ["up"],
		"tui.select.down": ["down"],
		"tui.editor.deleteCharBackward": ["backspace"],
		...overrides,
	};

	return {
		matches(data: string, keybinding: string) {
			return (bindings[keybinding] ?? []).includes(data);
		},
		getKeys(keybinding: string) {
			return bindings[keybinding] ?? [];
		},
	};
}

beforeAll(() => {
	installInertTestHome();
	blockUnexpectedNetworkCalls();

	// Model the failure mode from https://github.com/edlsh/pi-telegram-notify/issues/17.
	// `getMarkdownTheme()` returns a bag of closures that read through a Proxy
	// over the host's theme singleton. When the extension's bundled copy of
	// `@earendil-works/pi-coding-agent` is a different module instance than
	// the host's (e.g. legacy `@mariozechner/*` host ≤ Pi 0.73.1, where npm
	// cannot dedupe across scopes), our copy's singleton is never initialised
	// and any property read throws "Theme not initialized. Call initTheme()
	// first." Constructing the bag itself succeeds; the throw surfaces lazily
	// on `mdTheme.bold(...)` from inside pi-tui's `Markdown.render`. The
	// extension MUST detect this and fall back to plain `Text` rendering.
	const uninitialisedTheme = new Proxy(
		{},
		{
			get(_target, prop) {
				throw new Error(
					`Theme not initialized. Call initTheme() first. (read ${String(prop)})`,
				);
			},
		},
	);
	const brokenMarkdownTheme = {
		bold: (text: string) => (uninitialisedTheme as any).bold(text),
		italic: (text: string) => (uninitialisedTheme as any).italic(text),
		heading: (text: string) =>
			(uninitialisedTheme as any).fg("mdHeading", text),
	};

	mock.module("@earendil-works/pi-coding-agent", () => ({
		DynamicBorder: class {},
		getMarkdownTheme: () => brokenMarkdownTheme,
		rawKeyHint: (key: string, description: string) => `${key} ${description}`,
	}));

	mock.module("@earendil-works/pi-tui", () => ({
		Container: MockContainer,
		Editor: MockEditor,
		Key: {
			escape: "escape",
			enter: "enter",
			up: "up",
			down: "down",
			space: "space",
			backspace: "backspace",
			ctrl: (key: string) => `ctrl+${key}`,
			alt: (key: string) => `alt+${key}`,
			shift: (key: string) => `shift+${key}`,
			tab: "tab",
		},
		Markdown: class extends MockText {
			private mdTheme: any;
			constructor(text: string, _a: number, _b: number, theme: any) {
				super(text);
				this.mdTheme = theme;
			}
			render() {
				// Mirror pi-tui Markdown.render: invoke theme.bold during render
				// so #17-style regressions surface as render-time crashes in
				// tests instead of silently passing.
				return super.render().map((line) => this.mdTheme.bold(line));
			}
		},
		matchesKey: (data: string, key: string) => data === key,
		Spacer: class {},
		Text: MockText,
		truncateToWidth: (text: string) => text,
		wrapTextWithAnsi: (text: string) => [text],
		decodeKittyPrintable: (data: string) =>
			data.length === 1 ? data : undefined,
		fuzzyFilter: <T>(
			items: T[],
			query: string,
			getText: (item: T) => string,
		) => {
			const normalized = query.trim().toLowerCase();
			if (!normalized) return items;
			return items.filter((item) =>
				getText(item).toLowerCase().includes(normalized),
			);
		},
	}));

	mock.module("@sinclair/typebox", () => ({
		Type: {
			Object: (value: unknown) => value,
			String: (value?: unknown) => value,
			Optional: (value: unknown) => value,
			Array: (value: unknown) => value,
			Union: (value: unknown) => value,
			Literal: (value: unknown) => value,
			Boolean: (value?: unknown) => value,
			Number: (value?: unknown) => value,
			Unsafe: (value: unknown) => value,
		},
	}));
});

type RegisteredTool = {
	execute: (...args: any[]) => Promise<any>;
	renderResult: (result: any, options: any, theme: any) => any;
};

type RegisteredExtension = {
	tool: RegisteredTool;
	handlers: Map<string, Array<(event?: any, ctx?: any) => Promise<any>>>;
	eventHandlers: Map<string, Array<(event?: any) => any>>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
};

beforeEach(() => {
	process.env.HOME = DEFAULT_TEST_HOME;
	rmSync(join(DEFAULT_TEST_HOME, ".pi", "agent", "ask-user-presence.json"), {
		force: true,
	});
	rmSync(join(DEFAULT_TEST_HOME, ".pi", "agent", "ask-user-presence.lock"), {
		recursive: true,
		force: true,
	});
	blockUnexpectedNetworkCalls();
});

function stubEnv(key: string, value: string): void {
	const original = process.env[key];
	process.env[key] = value;
	onTestFinished(() => {
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	});
}

function cleanupTelegramStore(botToken: string, chatId: string): void {
	const key = createHash("sha256")
		.update(`https://api.telegram.org\n${botToken}\n${chatId}`)
		.digest("hex")
		.slice(0, 32);
	rmSync(join(tmpdir(), "pi-telegram-notify", key), {
		recursive: true,
		force: true,
	});
}

function stubTelegramSettings(
	botToken: string,
	chatId: string,
	namespaced = false,
): void {
	cleanupTelegramStore(botToken, chatId);
	const homeDir = join(
		tmpdir(),
		"pi-telegram-notify-test-home",
		createHash("sha256")
			.update(`${botToken}\n${chatId}`)
			.digest("hex")
			.slice(0, 16),
	);
	rmSync(homeDir, { recursive: true, force: true });
	const agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify(
			namespaced
				? { piAskUser: { telegram: { botToken, chatId } } }
				: { telegram: { botToken, chatId } },
		)}\n`,
	);
	stubEnv("HOME", homeDir);
	stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "0");
	onTestFinished(() => {
		rmSync(homeDir, { recursive: true, force: true });
	});
}

function stubAskAvailabilitySettings(
	awayTimeoutMs: number,
	ignoredNormalTimeoutMs?: number,
): void {
	const homeDir = join(
		tmpdir(),
		"pi-telegram-notify-availability-test-home",
		`${process.pid}-${awayTimeoutMs}-${ignoredNormalTimeoutMs ?? "none"}`,
	);
	rmSync(homeDir, { recursive: true, force: true });
	const agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({
			askUser: {
				availability: { awayTimeoutMs, ...(ignoredNormalTimeoutMs ? { normalTimeoutMs: ignoredNormalTimeoutMs } : {}) },
			},
		})}\n`,
	);
	stubEnv("HOME", homeDir);
	onTestFinished(() => rmSync(homeDir, { recursive: true, force: true }));
}

function stubFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): void {
	const original = globalThis.fetch;
	globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) =>
		handler(String(input), init),
	) as any;
	onTestFinished(() => {
		globalThis.fetch = original;
	});
}

function telegramOk(result: unknown): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function jsonBody(init?: RequestInit): any {
	try {
		return JSON.parse(String(init?.body ?? "{}"));
	} catch {
		return {};
	}
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for test condition");
}

async function setupExtension(moduleSuffix = ""): Promise<RegisteredExtension> {
	const { default: askUserExtension } = await import(`./index${moduleSuffix}`);
	let registeredTool: RegisteredTool | undefined;
	const handlers = new Map<
		string,
		Array<(event?: any, ctx?: any) => Promise<any>>
	>();
	const eventHandlers = new Map<string, Array<(event?: any) => any>>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	emittedEvents = [];
	const pi = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		on(eventName: string, handler: (event?: any, ctx?: any) => Promise<any>) {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler);
			handlers.set(eventName, existing);
		},
		events: {
			emit(name: string, payload: any) {
				emittedEvents.push({ name, payload });
				for (const handler of eventHandlers.get(name) ?? []) handler(payload);
			},
			on(name: string, handler: (payload?: any) => any) {
				const existing = eventHandlers.get(name) ?? [];
				existing.push(handler);
				eventHandlers.set(name, existing);
				return () => {
					const current = eventHandlers.get(name) ?? [];
					eventHandlers.set(
						name,
						current.filter((candidate) => candidate !== handler),
					);
				};
			},
		},
	} as any;

	askUserExtension(pi);

	if (!registeredTool) {
		throw new Error("Tool was not registered");
	}

	return { tool: registeredTool, handlers, eventHandlers, commands };
}

async function setupTool(moduleSuffix = ""): Promise<RegisteredTool> {
	return (await setupExtension(moduleSuffix)).tool;
}

async function runExtensionHandlers(
	extension: RegisteredExtension,
	eventName: string,
	event?: any,
	ctx?: any,
): Promise<void> {
	for (const handler of extension.handlers.get(eventName) ?? []) {
		await handler(event, ctx);
	}
}

function emitExtensionEvent(
	extension: RegisteredExtension,
	eventName: string,
	payload?: any,
): void {
	for (const handler of extension.eventHandlers.get(eventName) ?? []) {
		handler(payload);
	}
}

function createTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

describe("ask_user", () => {
	test("uses overlay mode by default", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions.overlay).toBe(true);
		expect(capturedOptions.overlayOptions.visible).toBeUndefined();
	});

	test("uses non-overlay custom UI when displayMode is inline", async () => {
		const tool = await setupTool();
		let capturedOptions: any;

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions).toBeUndefined();
		expect(result.details.cancelled).toBe(true);
	});

	test("inline mode resolves with the user's selection", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								resolve,
							);
							resolve({ kind: "selection", selections: ["A"] });
						}),
				},
			},
		);

		expect(result.details.cancelled).toBe(false);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["A"],
		});
	});

	test("inline mode still respects timeout cancellation", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "inline",
				timeout: 5,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								resolve,
							);
						}),
				},
			},
		);

		expect(result.details.cancelled).toBe(true);
		expect(result.details.response).toBeNull();
		expect(result.details.timedOut).toBe(true);
		expect(result.content[0].text).toContain("pause_goal");
	});

	test("normal mode has no implicit timeout and explicit timeouts do not enter away", async () => {
		stubAskAvailabilitySettings(7, 5);
		const extension = await setupExtension();
		const resolvingCtx = {
			hasUI: true,
			ui: {
				custom: async (factory: any) => await new Promise((resolve) => {
					factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
					setTimeout(() => resolve({ kind: "selection", selections: ["A"] }), 15);
				}),
			},
		};
		const normal = await extension.tool.execute("normal", { question: "Normal?", options: ["A"] }, undefined, undefined, resolvingCtx);
		expect(normal.details.timedOut).toBeUndefined();
		expect(normal.details.response).toEqual({ kind: "selection", selections: ["A"] });

		const timeoutCtx = { hasUI: true, ui: { custom: async (factory: any) => await new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
		}) } };
		const timedOut = await extension.tool.execute("explicit", { question: "Explicit?", options: ["A"], timeout: 5 }, undefined, undefined, timeoutCtx);
		expect(timedOut.details.timedOut).toBe(true);
		expect(timedOut.details.timeoutMs).toBe(5);
		const notifications: string[] = [];
		await extension.commands.get("ask")?.handler("", { ui: { notify: (message: string) => notifications.push(message) } });
		expect(notifications.at(-1)).toContain("availability: normal");
	});

	test("manual away caps timeouts and reset restores no implicit timeout", async () => {
		stubAskAvailabilitySettings(7);
		const extension = await setupExtension();
		const pendingCtx = { hasUI: true, ui: { custom: async (factory: any) => await new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
		}) } };
		await extension.commands.get("ask")?.handler("away", { ui: { notify() {} } });
		const away = await extension.tool.execute("away", { question: "Away?", options: ["A"], timeout: 50 }, undefined, undefined, pendingCtx);
		expect(away.details.timeoutMs).toBe(7);
		await extension.commands.get("ask")?.handler("reset", { ui: { notify() {} } });
		const reset = await extension.tool.execute("reset", { question: "Reset?", options: ["A"] }, undefined, undefined, {
			hasUI: true,
			ui: { custom: async (factory: any) => await new Promise((resolve) => {
				factory({ requestRender() {}, terminal: { rows: 24 } }, createTheme(), createKeybindings(), resolve);
				setTimeout(() => resolve({ kind: "selection", selections: ["A"] }), 15);
			}) },
		});
		expect(reset.details.timedOut).toBeUndefined();
	});

	test("registers only the unified ask availability command", async () => {
		const extension = await setupExtension();
		expect([...extension.commands.keys()]).toEqual(["ask"]);
		expect(extension.commands.has("ask-status")).toBe(false);
		expect(extension.commands.has("ask-away")).toBe(false);
		expect(extension.commands.has("ask-reset")).toBe(false);
	});

	test("ask with no argument and status show the same availability", async () => {
		stubAskAvailabilitySettings(60_000);
		const extension = await setupExtension();
		const notifications: string[] = [];
		const ctx = { ui: { notify(message: string) { notifications.push(message); } } };
		const ask = extension.commands.get("ask")!;
		await ask.handler("", ctx);
		const noArgument = notifications.at(-1);
		await ask.handler(" status ", ctx);
		expect(notifications.at(-1)).toBe(noArgument);
		expect(noArgument).toContain("availability: normal");
	});

	test("ask away and reset accept whitespace and case", async () => {
		const extension = await setupExtension();
		const notifications: string[] = [];
		const ctx = { ui: { notify(message: string) { notifications.push(message); } } };
		const ask = extension.commands.get("ask")!;
		await ask.handler(" AWAY ", ctx);
		expect(notifications.at(-1)).toBe("ask_user availability set to away");
		await ask.handler(" RESET ", ctx);
		expect(notifications.at(-1)).toBe("ask_user availability reset to normal");
	});

	test("ask invalid input reports usage without mutating availability", async () => {
		const extension = await setupExtension();
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = { ui: { notify(message: string, level: string) { notifications.push({ message, level }); } } };
		const ask = extension.commands.get("ask")!;
		await ask.handler("away", ctx);
		await ask.handler("unknown", ctx);
		expect(notifications.at(-1)).toEqual({ message: "Usage: /ask [status|away|reset]", level: "warning" });
		await ask.handler("status now", ctx);
		expect(notifications.at(-1)).toEqual({ message: "Usage: /ask [status|away|reset]", level: "warning" });
		await ask.handler("status", ctx);
		expect(notifications.at(-1)?.message).toContain("availability: away");
	});

	test("availability state is shared across extension instances", async () => {
		const extensionA = await setupExtension();
		const extensionB = await setupExtension();
		const notificationsA: string[] = [];
		const notificationsB: string[] = [];
		const ctxA = { ui: { notify(message: string) { notificationsA.push(message); } } };
		const ctxB = { ui: { notify(message: string) { notificationsB.push(message); } } };
		await extensionA.commands.get("ask")!.handler("away", ctxA);
		await extensionB.commands.get("ask")!.handler("status", ctxB);
		expect(notificationsB.at(-1)).toContain("availability: away");
		await extensionB.commands.get("ask")!.handler("reset", ctxB);
		await extensionA.commands.get("ask")!.handler("status", ctxA);
		expect(notificationsA.at(-1)).toContain("availability: normal");
	});

	test("uses PI_ASK_USER_DISPLAY_MODE env var when call-level displayMode is omitted", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions).toBeUndefined();
	});

	test("call-level displayMode overrides PI_ASK_USER_DISPLAY_MODE env var", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "inline");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				displayMode: "overlay",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions.overlay).toBe(true);
	});

	test("ignores unrecognised PI_ASK_USER_DISPLAY_MODE value and falls back to overlay", async () => {
		stubEnv("PI_ASK_USER_DISPLAY_MODE", "fullscreen");
		const tool = await setupTool();
		let capturedOptions: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (_factory: any, options: any) => {
						capturedOptions = options;
						return null;
					},
				},
			},
		);

		expect(capturedOptions.overlay).toBe(true);
	});

	test("shows a local notification when ask_user is requested", async () => {
		const tool = await setupTool();
		const notifications: Array<{ message: string; type?: string }> = [];

		await tool.execute(
			"tool-call-id",
			{
				question: "Approve the rollout?",
				context: "The build is green.",
				options: ["Yes", "No"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async () => null,
					notify: (message: string, type?: string) => {
						notifications.push({ message, type });
					},
				},
			},
		);

		expect(notifications[0]?.type).toBe("info");
		expect(notifications[0]?.message).toContain("Approve the rollout?");
		expect(notifications[0]?.message).toContain("The build is green.");
		expect(notifications[0]?.message).toContain("Yes, No");
	});

	test("reports ask_user as blocked to Herdr until the prompt closes", async () => {
		const tool = await setupTool();
		let closePrompt: ((value: null) => void) | undefined;

		const execution = tool.execute(
			"ask-herdr-1",
			{ question: "Approve deployment?", options: ["Yes", "No"] },
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async () =>
						await new Promise<null>((resolve) => {
							closePrompt = resolve;
						}),
				},
			},
		);

		await waitUntil(
			() =>
				closePrompt !== undefined &&
				emittedEvents.some(
					(event) => event.name === "herdr:blocked" && event.payload.active,
				),
		);
		expect(
			emittedEvents.find(
				(event) => event.name === "herdr:blocked" && event.payload.active,
			)?.payload,
		).toMatchObject({
			active: true,
			id: "ask-herdr-1",
			kind: "ask_user",
			label: "Approve deployment?",
		});

		closePrompt?.(null);
		await execution;
		expect(
			emittedEvents.filter((event) => event.name === "herdr:blocked").at(-1)
				?.payload,
		).toMatchObject({ active: false, id: "ask-herdr-1" });
	});

	describe("Telegram lease ownership", () => {
		async function hooks() {
			return (await import("./index")).__telegramTestHooks;
		}

		test("delivers busy Telegram free text as steer, never followUp", async () => {
			const lease = await hooks();
			const sent: Array<{ text: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
			const pi = { sendUserMessage: async (text: string, options?: { deliverAs?: "steer" | "followUp" }) => { sent.push({ text, options }); } } as any;
			expect(await lease.deliverFreeText(pi, "busy message", false)).toBe("steer");
			expect(await lease.deliverFreeText(pi, "idle message", true)).toBe("idle");
			expect(sent).toEqual([
				{ text: "busy message", options: { deliverAs: "steer" } },
				{ text: "idle message", options: undefined },
			]);
			expect(sent.some(({ options }) => options?.deliverAs === "followUp")).toBe(false);
		});

		function testLock(name: string): string {
			const root = join(tmpdir(), "pi-telegram-lease-tests", name, String(process.pid));
			rmSync(root, { recursive: true, force: true });
			mkdirSync(root, { recursive: true });
			return join(root, "lock");
		}

		test("a reclaimed owner cannot refresh or release its replacement", async () => {
			const lease = await hooks();
			const lockDir = testLock("stale-owner");
			const old = await lease.tryAcquireLease(lockDir, -1);
			expect(old).not.toBeNull();
			expect(await lease.tryAcquireLease(lockDir, -1)).toBeNull(); // retire A
			const replacement = await lease.tryAcquireLease(lockDir, -1);
			expect(replacement).not.toBeNull();
			const before = await lease.readLeaseOwner(lockDir);
			await old!.refresh();
			expect(await lease.readLeaseOwner(lockDir)).toEqual(before);
			await old!.release();
			expect(await lease.readLeaseOwner(lockDir)).toEqual(before);
			await replacement!.release();
		});

		test("competing reclaimers and old cleanup retain the token fence", async () => {
			const lease = await hooks();
			const lockDir = testLock("reclaim-race");
			const old = await lease.tryAcquireLease(lockDir, -1);
			const owner = await lease.readLeaseOwner(lockDir);
			expect(await Promise.all([lease.tryAcquireLease(lockDir, -1), lease.tryAcquireLease(lockDir, -1)])).toEqual([null, null]);
			await lease.cleanupLeaseTombstones(lockDir, -1);
			expect(existsSync(lease.tombstonePath(lockDir, owner.token))).toBe(true);
			expect(existsSync(lease.leasePath(lockDir, owner.token))).toBe(false);
			const replacement = await lease.tryAcquireLease(lockDir, -1);
			const before = await lease.readLeaseOwner(lockDir);
			await old!.release();
			expect(await lease.readLeaseOwner(lockDir)).toEqual(before);
			await replacement!.release();
		});

		test("removes a provisional fence when a refreshed owner makes reclaim abort", async () => {
			const lease = await hooks();
			const lockDir = testLock("refresh-during-reclaim");
			const a = await lease.tryAcquireLease(lockDir, 100);
			const owner = await lease.readLeaseOwner(lockDir);
			writeFileSync(join(lease.leasePath(lockDir, owner.token), "owner.json"), JSON.stringify({ ...owner, heartbeatAt: Date.now() - 1_000 }));
			let resume!: () => void;
			const reserved = new Promise<void>((resolve) => { resume = resolve; });
			lease.setLeaseBarrier(async (phase: string) => { if (phase === "reserved") await reserved; });
			try {
				const reclaim = lease.tryAcquireLease(lockDir, 100);
				await waitUntil(() => existsSync(lease.tombstonePath(lockDir, owner.token)));
				await a!.refresh();
				resume();
				expect(await reclaim).toBeNull();
				expect(existsSync(lease.tombstonePath(lockDir, owner.token))).toBe(false);
				const b = await lease.tryAcquireLease(lockDir, 100);
				expect(b).toBeNull(); // A is fresh after the aborted reclaim.
				const refreshed = await lease.readLeaseOwner(lockDir);
				writeFileSync(join(lease.leasePath(lockDir, refreshed.token), "owner.json"), JSON.stringify({ ...refreshed, heartbeatAt: Date.now() - 1_000 }));
				expect(await lease.tryAcquireLease(lockDir, 100)).toBeNull();
				const c = await lease.tryAcquireLease(lockDir, 100);
				expect(c).not.toBeNull(); // A later becomes stale and B can acquire.
				await c!.release();
			} finally { lease.setLeaseBarrier(undefined); }
		});

		test("synchronizes competing reclaimers without letting either retire B", async () => {
			const lease = await hooks();
			const lockDir = testLock("synchronized-reclaimers");
			const a = await lease.tryAcquireLease(lockDir, -1);
			expect(a).not.toBeNull();
			let resume!: () => void;
			const pause = new Promise<void>((resolve) => { resume = resolve; });
			let firstPaused = false;
			let secondSawTombstone = false;
			lease.setLeaseBarrier(async (phase: string) => {
				if (phase === "beforeRename" && !firstPaused) {
					firstPaused = true;
					await pause;
				}
				if (phase === "tombstoneExists") secondSawTombstone = true;
			});
			try {
				const first = lease.tryAcquireLease(lockDir, -1);
				await waitUntil(() => firstPaused);
				const second = lease.tryAcquireLease(lockDir, -1);
				await waitUntil(() => secondSawTombstone);
				resume();
				const [firstResult, secondResult] = await Promise.all([first, second]);
				expect(firstResult).toBeNull();
				expect(secondResult).toBeNull();
				const b = await lease.tryAcquireLease(lockDir, -1);
				expect(b).not.toBeNull();
				const bOwner = await lease.readLeaseOwner(lockDir);
				await a!.release();
				expect(await lease.readLeaseOwner(lockDir)).toEqual(bOwner);
				await b!.release();
			} finally { lease.setLeaseBarrier(undefined); }
		});

		test("publishes only pointers whose owner payload is initialized", async () => {
			const lease = await hooks();
			const lockDir = testLock("atomic-publication");
			let releaseReturn!: () => void;
			const returnPaused = new Promise<void>((resolve) => { releaseReturn = resolve; });
			let published = false;
			lease.setLeaseBarrier(async (phase: string) => {
				if (phase === "published") { published = true; await returnPaused; }
			});
			try {
				const acquiring = lease.tryAcquireLease(lockDir, 10_000);
				await waitUntil(() => published);
				// The fixed pointer is visible while acquire is still blocked; every
				// such observation must resolve to a complete immutable owner payload.
				expect(await lease.readLeaseOwner(lockDir)).toMatchObject({ token: expect.any(String), heartbeatAt: expect.any(Number) });
				releaseReturn();
				const lock = await acquiring;
				await lock!.release();
			} finally { lease.setLeaseBarrier(undefined); }
		});

		test("Telegram send replaces a definitively rejected persisted topic", async () => {
			const lease = await hooks();
			const config = { botToken: "rejected-topic-send-test", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config);
			const key = "test-session";
			rmSync(store.rootDir, { recursive: true, force: true });
			mkdirSync(store.rootDir, { recursive: true });
			writeFileSync(store.topicFile, JSON.stringify({ version: 2, topics: { [key]: { threadId: 41, title: "pi-ask-user · test", createdAt: 0 } }, threads: { "41": key } }));
			const calls: Array<{ method: string; body: any }> = [];
			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init); calls.push({ method, body });
				if (method === "getMe") return telegramOk({ has_topics_enabled: true });
				if (method === "createForumTopic") return telegramOk({ message_thread_id: 42 });
				if (method === "sendRichMessage" && body.message_thread_id === 41) {
					return new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread was not found" }), { status: 400 });
				}
				if (method === "sendRichMessage") return telegramOk({ message_id: 7 });
				return telegramOk({});
			});
			const poller = lease.createPoller(config); poller.setRouting({ sessionId: key, sessionName: "test", cwd: process.cwd() });
			await poller.sendNotificationMessage("hello");
			expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
			expect(calls.filter((call) => call.method === "sendRichMessage").map((call) => call.body.message_thread_id)).toEqual([41, 42]);
			expect(readFileSync(store.topicFile, "utf8")).toContain('"threadId":42');
		});

		test("Telegram send retries only explicit missing-topic errors and preserves newer mappings", async () => {
			const lease = await hooks();
			const config = { botToken: "topic-send-test", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config);
			rmSync(store.rootDir, { recursive: true, force: true });
			const calls: Array<{ method: string; body: any }> = [];
			let topic = 11;
			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init); calls.push({ method, body });
				if (method === "getMe") return telegramOk({ has_topics_enabled: true });
				if (method === "createForumTopic") return telegramOk({ message_thread_id: topic++ });
				if (method === "sendRichMessage" && body.message_thread_id === 11) {
					const key = "test-session";
					writeFileSync(store.topicFile, JSON.stringify({ version: 2, topics: { [key]: { threadId: 99, title: "test", createdAt: 0 } }, threads: { "99": key } }));
					return new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread was not found" }), { status: 400 });
				}
				if (method === "sendRichMessage") return telegramOk({ message_id: 7 });
				return telegramOk({});
			});
			const poller = lease.createPoller(config); const key = "test-session";
			poller.setRouting({ sessionId: key, sessionName: "test", cwd: process.cwd() });
			await poller.sendNotificationMessage("hello");
			expect(calls.filter((call) => call.method === "sendRichMessage").map((call) => call.body.message_thread_id)).toEqual([11, 99]);
			expect(readFileSync(store.topicFile, "utf8")).toContain('"threadId":99');
			calls.length = 0;
			const genericConfig = { ...config, botToken: "generic-send-test" };
			const genericStore = lease.storeForConfig(genericConfig);
			mkdirSync(genericStore.rootDir, { recursive: true });
			writeFileSync(genericStore.topicFile, JSON.stringify({ version: 2, topics: { [key]: { threadId: 33, title: "test", createdAt: 0 } }, threads: { "33": key } }));
			stubFetch((url, init) => {
				const method = url.split("/").pop()!; calls.push({ method, body: jsonBody(init) });
				if (method === "getMe") return telegramOk({ has_topics_enabled: true });
				if (method === "createForumTopic") return telegramOk({ message_thread_id: 33 });
				if (method === "sendRichMessage") return new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread rejected" }), { status: 400 });
				return telegramOk({});
			});
			const genericPoller = lease.createPoller(genericConfig); genericPoller.setRouting({ sessionId: key, sessionName: "test", cwd: process.cwd() });
			await expect(genericPoller.sendNotificationMessage("hello")).rejects.toThrow("message thread rejected");
			expect(calls.filter((call) => call.method === "sendRichMessage")).toHaveLength(1);
			expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(0);
		});
			test("uses session identity for topic creation, resume, legacy maps, and dynamic names", async () => {
			const lease = await hooks();
			const config = { botToken: "session-topic-identity", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config);
			rmSync(store.rootDir, { recursive: true, force: true });
			const calls: Array<{ method: string; body: any }> = [];
			let thread = 10;
			stubFetch((url, init) => {
				const method = url.split("/").pop()!; const body = jsonBody(init); calls.push({ method, body });
				if (method === "getMe") return telegramOk({ has_topics_enabled: true });
				if (method === "createForumTopic") return telegramOk({ message_thread_id: thread++ });
				return telegramOk({ message_id: thread });
			});
			const a = lease.createPoller(config); a.setRouting({ sessionId: "session-alpha-123", getSessionName: () => "Named session", cwd: process.cwd() });
			const b = lease.createPoller(config); b.setRouting({ sessionId: "session-beta-456", cwd: process.cwd() });
			await a.sendNotificationMessage("a"); await b.sendNotificationMessage("b");
			const resumed = lease.createPoller(config); resumed.setRouting({ sessionId: "session-alpha-123", cwd: process.cwd() });
			await resumed.sendNotificationMessage("again");
			const created = calls.filter((call) => call.method === "createForumTopic");
			expect(created).toHaveLength(2);
			expect(created.map((call) => call.body.name)).toEqual(["pi-ask-user · Named session", "pi-ask-user · session-"]);
			let map: any;
			try { map = JSON.parse(readFileSync(store.topicFile, "utf8")); } catch { throw new Error("topic map was not valid JSON"); }
			expect(map.threads[String(map.topics["session-alpha-123"].threadId)]).toBe("session-alpha-123");
			writeFileSync(store.topicFile, JSON.stringify({ version: 1, topics: { legacy: 77 }, threads: { "77": "legacy" } }));
			const legacy = lease.createPoller(config); legacy.setRouting({ sessionId: "legacy", cwd: process.cwd() });
			await legacy.sendNotificationMessage("replace legacy");
			expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(3);
			const resolved = await lease.resolveTopicName("abcdef123", undefined, process.cwd());
			expect(resolved).toBe("pi-ask-user · abcdef12");
		});

		test("routes free topic text once, preserves ask precedence, and reacts using inbound ids", async () => {
			const lease = await hooks();
			const config = { botToken: "session-inbound-routing", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			const calls: Array<{ method: string; body: any }> = [];
			stubFetch((url, init) => {
				const method = url.split("/").pop()!; const body = jsonBody(init); calls.push({ method, body });
				if (method === "getUpdates") return new Promise<Response>((resolve) => (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(telegramOk([])), { once: true }));
				if (method === "getMe") return telegramOk({ has_topics_enabled: true });
				if (method === "createForumTopic") return telegramOk({ message_thread_id: 31 });
				return telegramOk({ message_id: 1 });
			});
			const delivered: string[] = [];
			const poller = lease.createPoller(config);
			poller.setRouting({ sessionId: "inbound-session", cwd: process.cwd() });
			await poller.sendNotificationMessage("create topic");
			await poller.activateSession({ sessionId: "inbound-session", cwd: process.cwd() }, async (text: string) => { delivered.push(text); return delivered.length === 1 ? "idle" : "steer"; });
			await lease.handleUpdate(poller, { update_id: 501, message: { message_id: 91, message_thread_id: 31, chat: { id: 4242 }, text: "first" } });
			await lease.consumeInbox(poller);
			await lease.handleUpdate(poller, { update_id: 502, message: { message_id: 92, message_thread_id: 31, chat: { id: 4242 }, text: "second" } });
			await lease.consumeInbox(poller);
			expect(delivered).toEqual(["first", "second"]);
			expect(calls.filter((call) => call.method === "setMessageReaction").map((call) => [call.body.message_id, call.body.reaction[0].emoji])).toEqual([[91, "👀"], [91, "✅"], [92, "👀"], [92, "⏳"]]);
			await poller.createPendingAsk({ id: "ask", request: { question: "q", options: [], allowFreeform: true, allowMultiple: false, allowComment: false }, createdAt: Date.now(), updatedAt: Date.now(), status: "pending", messageId: 93, messageThreadId: 31 });
			await lease.handleUpdate(poller, { update_id: 503, message: { message_id: 94, message_thread_id: 31, chat: { id: 4242 }, reply_to_message: { message_id: 93 }, text: "answer" } });
			expect(delivered).toEqual(["first", "second"]);
			await poller.removePendingAsk("ask");
			await lease.handleUpdate(poller, { update_id: 503, message: { message_id: 94, message_thread_id: 31, chat: { id: 4242 }, text: "replay" } });
			expect(delivered).toEqual(["first", "second"]);
			await poller.deactivateSession();
		});

		test("keeps fresh owners fenced and lets a stale replacement recover queued inbox", async () => {
			const lease = await hooks();
			const config = { botToken: "session-owner-recovery", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				if (method === "getUpdates") return new Promise<Response>((resolve) => (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => resolve(telegramOk([])), { once: true }));
				return telegramOk({ has_topics_enabled: true, message_id: 1 });
			});
			const first: string[] = []; const second: string[] = [];
			const a = lease.createPoller(config); await a.activateSession({ sessionId: "same", cwd: process.cwd() }, async (text: string) => { first.push(text); return "idle"; });
			const b = lease.createPoller(config); await b.activateSession({ sessionId: "same", cwd: process.cwd() }, async (text: string) => { second.push(text); return "idle"; });
			await lease.handleUpdate(a, { update_id: 601, message: { message_id: 1, message_thread_id: 99, chat: { id: 4242 }, text: "ignored" } });
			expect(first).toEqual([]); expect(second).toEqual([]);
			const registrationFile = join(store.registrationsDir, readdirSync(store.registrationsDir)[0]!);
			let registration: any;
			try { registration = JSON.parse(readFileSync(registrationFile, "utf8")); } catch { throw new Error("registration was not valid JSON"); }
			writeFileSync(registrationFile, JSON.stringify({ ...registration, heartbeatAt: Date.now() - 71_000 }));
			await b.activateSession({ sessionId: "same", cwd: process.cwd() }, async (text: string) => { second.push(text); return "idle"; });
			const inbox = join(store.inboxDir, createHash("sha256").update("same").digest("hex")); mkdirSync(inbox, { recursive: true });
			writeFileSync(join(inbox, "602.json"), JSON.stringify({ updateId: 602, text: "recovered", messageId: 2, threadId: 99, createdAt: Date.now() }));
			// Simulate A crashing after rename but before durable completion. B owns
			// the recovered claim; A remains fenced by B's fresh registration.
			writeFileSync(join(inbox, "603.json.claimed.crashed-A"), JSON.stringify({ updateId: 603, text: "claimed recovery", messageId: 3, threadId: 99, createdAt: Date.now() }));
			await lease.consumeInbox(b);
			expect(second.slice().sort((a, b) => a.localeCompare(b))).toEqual(["claimed recovery", "recovered"]);
			await lease.consumeInbox(a);
			expect(first).toEqual([]);
			expect(readdirSync(inbox).some((entry) => entry.startsWith("603.json.done"))).toBe(true);
			await a.deactivateSession(); await b.deactivateSession();
		});

		test("deactivation fences an in-flight lease publication", async () => {
			const lease = await hooks();
			const config = { botToken: "deactivate-acquire-race", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			let published = false; let resume!: () => void;
			const paused = new Promise<void>((resolve) => { resume = resolve; });
			const calls: string[] = [];
			stubFetch((url, init) => { const method = url.split("/").pop()!; calls.push(method); if (method === "getUpdates") return new Promise<Response>((resolve) => (init?.signal as AbortSignal).addEventListener("abort", () => resolve(telegramOk([])), { once: true })); return telegramOk({ has_topics_enabled: true }); });
			lease.setPollingBarrier(async () => { published = true; await paused; });
			try {
				const poller = lease.createPoller(config);
				await poller.activateSession({ sessionId: "race", cwd: process.cwd() }, async () => "idle");
				await waitUntil(() => published);
				const stopping = poller.deactivateSession();
				await new Promise((resolve) => setTimeout(resolve, 2));
				resume(); await stopping;
				expect(calls.filter((method) => method === "getUpdates")).toEqual([]);
				expect(existsSync(store.lockDir)).toBe(false);
				lease.setPollingBarrier(undefined);
				await poller.activateSession({ sessionId: "race", cwd: process.cwd() }, async () => "idle");
				await waitUntil(() => calls.includes("getUpdates"));
				await poller.deactivateSession();
			} finally { lease.setPollingBarrier(undefined); }
		});

		test("deactivation removes a registration written before local publication", async () => {
			const lease = await hooks();
			const config = { botToken: "deactivate-registration-race", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			stubEnv("PI_TELEGRAM_REGISTRATION_INTERVAL_MS", "5");
			const calls: string[] = [];
			stubFetch((url) => { calls.push(url.split("/").pop()!); return telegramOk([]); });
			let written = false; let resume!: () => void;
			const paused = new Promise<void>((resolve) => { resume = resolve; });
			lease.setRegistrationBarrier(async () => { written = true; await paused; });
			try {
				const poller = lease.createPoller(config);
				const activating = poller.activateSession({ sessionId: "race", cwd: process.cwd() }, async () => "idle");
				await waitUntil(() => written);
				const stopping = poller.deactivateSession();
				resume(); await Promise.all([activating, stopping]);
				expect(existsSync(join(store.registrationsDir, readdirSync(store.registrationsDir)[0] ?? "missing"))).toBe(false);
				await new Promise((resolve) => setTimeout(resolve, 15));
				expect(calls).toEqual([]);
			} finally { lease.setRegistrationBarrier(undefined); }
		});

		test("repeated activation cannot re-register after final deactivation", async () => {
			const lease = await hooks();
			const config = { botToken: "repeated-deactivation", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			stubEnv("PI_TELEGRAM_REGISTRATION_INTERVAL_MS", "5");
			stubFetch((url, init) => {
				if (url.split("/").pop() === "getUpdates") return new Promise<Response>((resolve) => (init?.signal as AbortSignal).addEventListener("abort", () => resolve(telegramOk([])), { once: true }));
				return telegramOk([]);
			});
			const poller = lease.createPoller(config);
			await poller.activateSession({ sessionId: "first", cwd: process.cwd() }, async () => "idle");
			await poller.activateSession({ sessionId: "second", cwd: process.cwd() }, async () => "idle");
			await poller.deactivateSession();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(readdirSync(store.registrationsDir)).toEqual([]);
		});

		test("durable completion prevents replay after acknowledgement failure", async () => {
			const lease = await hooks(); const config = { botToken: "ack-failure", chatId: "4242", apiBaseUrl: "https://telegram.test" };
			const store = lease.storeForConfig(config); rmSync(store.rootDir, { recursive: true, force: true });
			let reactions = 0; stubFetch((url, init) => { const method = url.split("/").pop()!; if (method === "getUpdates") return new Promise<Response>((resolve) => (init?.signal as AbortSignal).addEventListener("abort", () => resolve(telegramOk([])), { once: true })); if (method === "setMessageReaction") { reactions++; throw new Error("ack unavailable"); } return telegramOk({}); });
			const delivered: string[] = []; const poller = lease.createPoller(config);
			await poller.activateSession({ sessionId: "ack", cwd: process.cwd() }, async (text: string) => { delivered.push(text); return "idle"; });
			const inbox = join(store.inboxDir, createHash("sha256").update("ack").digest("hex")); mkdirSync(inbox, { recursive: true }); writeFileSync(join(inbox, "1.json"), JSON.stringify({ updateId: 1, text: "once", messageId: 1, threadId: 1, createdAt: Date.now() }));
			await lease.consumeInbox(poller); await lease.consumeInbox(poller);
			expect(delivered).toEqual(["once"]); expect(reactions).toBe(1);
			await poller.deactivateSession();
		});

		test("globally removes only expired durable inbox completions", async () => {
			const lease = await hooks();
			const store = lease.storeForConfig({ botToken: "inbox-cleanup", chatId: "4242", apiBaseUrl: "https://telegram.test" });
			rmSync(store.rootDir, { recursive: true, force: true });
			const old = join(store.inboxDir, "old"); const live = join(store.inboxDir, "live"); const empty = join(store.inboxDir, "empty");
			mkdirSync(old, { recursive: true }); mkdirSync(live, { recursive: true }); mkdirSync(empty, { recursive: true });
			const oldDone = join(old, "1.json.done"); writeFileSync(oldDone, "{}");
			utimesSync(oldDone, new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000), new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000));
			writeFileSync(join(live, "2.json.done"), "{}"); writeFileSync(join(live, "3.json"), "{}"); writeFileSync(join(live, "4.json.claimed.owner"), "{}");
			await lease.cleanupInboxDone(store);
			expect(existsSync(oldDone)).toBe(false); expect(existsSync(old)).toBe(false); expect(existsSync(empty)).toBe(false);
			expect(existsSync(join(live, "2.json.done"))).toBe(true); expect(existsSync(join(live, "3.json"))).toBe(true); expect(existsSync(join(live, "4.json.claimed.owner"))).toBe(true);
		});

		test("sweeps every expired completion beyond former directory and entry prefixes", async () => {
			const lease = await hooks();
			const store = lease.storeForConfig({ botToken: "inbox-cleanup-large", chatId: "4242", apiBaseUrl: "https://telegram.test" });
			rmSync(store.rootDir, { recursive: true, force: true });
			const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
			const expired: string[] = [];
			for (let i = 0; i <= 100; i++) {
				const path = join(store.inboxDir, `session-${String(i).padStart(3, "0")}`, "done.json.done");
				mkdirSync(join(store.inboxDir, `session-${String(i).padStart(3, "0")}`), { recursive: true });
				writeFileSync(path, "{}"); utimesSync(path, expiredAt, expiredAt); expired.push(path);
			}
			const target = join(store.inboxDir, "many-expired"); mkdirSync(target, { recursive: true });
			for (let i = 0; i <= 500; i++) {
				const path = join(target, `entry-${String(i).padStart(3, "0")}.json.done`);
				writeFileSync(path, "{}"); utimesSync(path, expiredAt, expiredAt); expired.push(path);
			}
			await lease.cleanupInboxDone(store);
			expect(expired).toHaveLength(602);
			expect(expired.filter(existsSync)).toEqual([]);
		});
	});

	describe("Telegram notifications", () => {
		test("accelerates Telegram delivery when the response timeout is short", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_SHORT_TIMEOUT", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "100");
			const extension = await setupExtension();
			const calls: string[] = [];

			stubFetch((url) => {
				const method = url.split("/").pop()!;
				calls.push(method);
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					return telegramOk({ message_id: 76, chat: { id: 4242 } });
				}
				return telegramOk([]);
			});

			const result = await extension.tool.execute(
				"short-timeout-call",
				{
					question: "Quick decision?",
					options: ["A", "B"],
					timeout: 40,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (factory: any) =>
							await new Promise((resolve) => {
								factory(
									{ requestRender() {}, terminal: { rows: 24 } },
									createTheme(),
									createKeybindings(),
									resolve,
								);
							}),
					},
				},
			);

			expect(result.details.timedOut).toBe(true);
			expect(calls).toContain("sendRichMessage");
		});

		test("accepts the legacy piAskUser.telegram settings namespace", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_NAMESPACED", "4242", true);
			const tool = await setupTool();
			const calls: string[] = [];

			stubFetch((url) => {
				const method = url.split("/").pop()!;
				calls.push(method);
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					return telegramOk({ message_id: 77, chat: { id: 4242 } });
				}
				return telegramOk([]);
			});

			await tool.execute(
				"tool-call-id",
				{ question: "Still configured?", options: ["Yes"] },
				undefined,
				undefined,
				{ hasUI: true, ui: { custom: async () => null } },
			);

			expect(calls).toContain("sendRichMessage");
		});

		test("sends the full question payload with quick-reply buttons", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_SEND", "4242");
			const tool = await setupTool();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				calls.push({ method, body });
				if ((method === "sendMessage" || method === "sendRichMessage"))
					return telegramOk({ message_id: 77, chat: { id: 4242 } });
				if (method === "getUpdates") return telegramOk([]);
				return telegramOk(true);
			});

			await tool.execute(
				"tool-call-id",
				{
					question: "Which deployment target?",
					context: "Staging has already passed smoke tests.",
					options: [
						"Staging",
						{ title: "Production", description: "Customer-facing environment" },
					],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => null,
					},
				},
			);

			const sendMessage = calls.find((call) => (call.method === "sendMessage" || call.method === "sendRichMessage"));
			expect(sendMessage?.body.chat_id).toBe("4242");
			expect((sendMessage?.body.rich_message?.html ?? sendMessage?.body.text)).toContain("Which deployment target?");
			expect((sendMessage?.body.rich_message?.html ?? sendMessage?.body.text)).toContain(
				"Staging has already passed smoke tests.",
			);
			expect((sendMessage?.body.rich_message?.html ?? sendMessage?.body.text)).toContain("A. Staging");
			expect((sendMessage?.body.rich_message?.html ?? sendMessage?.body.text)).toContain(
				"B. Production — Customer-facing environment",
			);
			expect((sendMessage?.body.rich_message?.html ?? sendMessage?.body.text)).not.toContain("Request ID:");
			expect(
				sendMessage?.body.reply_markup.inline_keyboard[0].map(
					(button: any) => button.text,
				),
			).toEqual(["A. Staging", "B. Production"]);
			expect(sendMessage?.body.reply_markup.inline_keyboard[1][0].text).toBe(
				"✏️ Custom answer",
			);
		});

		test("uses a clean regular payload only after a definitive rich rejection", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_CLEAN_FALLBACK", "4242");
			const tool = await setupTool();
			const calls: Array<{ method: string; body: any }> = [];
			stubFetch((url, init) => {
				const method = url.split("/").pop()!; const body = jsonBody(init); calls.push({ method, body });
				if (method === "sendRichMessage") return new Response(JSON.stringify({ ok: false, description: "Bad Request: rich_message is unsupported" }), { status: 400 });
				if (method === "sendMessage") return telegramOk({ message_id: 78, chat: { id: 4242 } });
				return telegramOk([]);
			});
			await tool.execute("fallback", { question: "<>&\"".repeat(2000), options: ["<>&\""] }, undefined, undefined, { hasUI: true, ui: { custom: async () => null } });
			const regular = calls.find((call) => call.method === "sendMessage")?.body;
			expect(regular?.rich_message).toBeUndefined();
			expect(regular?.parse_mode).toBe("HTML");
			expect(regular?.text.length).toBeLessThanOrEqual(3900);
			expect(regular?.text).not.toMatch(/&(amp|lt|gt)(?!;)/);
			expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
		});

		test("does not retry an ambiguous rich send failure", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_NO_DUPLICATE", "4242");
			const tool = await setupTool(); const calls: string[] = [];
			stubFetch((url) => { const method = url.split("/").pop()!; calls.push(method); if (method === "sendRichMessage") throw new Error("network timeout"); return telegramOk([]); });
			await tool.execute("ambiguous", { question: "No duplicate", options: ["A"] }, undefined, undefined, { hasUI: true, ui: { custom: async () => null } });
			expect(calls).toContain("sendRichMessage");
			expect(calls).not.toContain("sendMessage");
		});

		test("does not fall back for a generic unsupported rich send error", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_GENERIC_UNSUPPORTED", "4242");
			const tool = await setupTool(); const calls: string[] = [];
			stubFetch((url) => { const method = url.split("/").pop()!; calls.push(method); if (method === "sendRichMessage") return new Response(JSON.stringify({ ok: false, description: "Bad Request: unsupported" }), { status: 400 }); return telegramOk([]); });
			await tool.execute("generic-unsupported", { question: "No fallback", options: ["A"] }, undefined, undefined, { hasUI: true, ui: { custom: async () => null } });
			expect(calls).toContain("sendRichMessage");
			expect(calls).not.toContain("sendMessage");
		});

		test("suppresses an ask_user Telegram message when answered before the delay", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_DELAY_SUPPRESS", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "25");
			const tool = await setupTool();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				calls.push({ method, body: jsonBody(init) });
				return telegramOk({ message_id: 77, chat: { id: 4242 } });
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Approve quickly?",
					options: ["Yes", "No"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => ({
							kind: "selection",
							selections: ["Yes"],
						}),
					},
				},
			);

			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Yes"],
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(calls.some((call) => (call.method === "sendMessage" || call.method === "sendRichMessage"))).toBe(false);
		});

		test("edits the Telegram ask message when answered from the local UI", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_LOCAL_EDIT", "4242");
			const tool = await setupTool();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				calls.push({ method, body });
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					return telegramOk({ message_id: 177, chat: { id: 4242 } });
				}
				if (method === "getUpdates") return telegramOk([]);
				return telegramOk(true);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "<>&\"".repeat(2_000),
					options: ["<>&\"".repeat(2_000), "Remote"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => ({
							kind: "selection",
							selections: ["<>&\"".repeat(2_000)],
						}),
					},
				},
			);

			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["<>&\"".repeat(2_000)],
			});
			const editMessage = calls.find(
				(call) => call.method === "editMessageText",
			);
			expect(editMessage?.body.message_id).toBe(177);
			const editedHtml = editMessage?.body.rich_message?.html ?? editMessage?.body.text;
			expect(editedHtml).toContain("Answered:");
			expect(editedHtml).toContain("&lt;&gt;&amp;");
			expect(editedHtml.length).toBeLessThanOrEqual(3900);
			expect(editedHtml).not.toMatch(/&(amp|lt|gt)(?!;)/);
			expect(editMessage?.body.reply_markup).toEqual({ inline_keyboard: [] });
		});

		test("warns safely and keeps the UI flow when Telegram send fails", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_FAIL", "4242");
			const tool = await setupTool();
			const notifications: Array<{ message: string; type?: string }> = [];

			stubFetch((url) => {
				const method = url.split("/").pop()!;
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					return new Response(
						JSON.stringify({
							ok: false,
							description: "Bad token bot123456:TEST_TOKEN",
						}),
						{ status: 401 },
					);
				}
				return telegramOk([]);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => null,
						notify: (message: string, type?: string) => {
							notifications.push({ message, type });
						},
					},
				},
			);

			const warning = notifications.find(
				(notification) => notification.type === "warning",
			);
			expect(result.details.cancelled).toBe(true);
			expect(warning?.message).toContain("bot<redacted>");
			expect(warning?.message).not.toContain("TEST_TOKEN");
		});

		test("resolves the matching ask_user request from a Telegram callback", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_CALLBACK", "4242");
			const tool = await setupTool();
			let callbackData = "";
			let updateDelivered = false;
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch(async (url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				calls.push({ method, body });
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					callbackData = body.reply_markup.inline_keyboard[0][1].callback_data;
					return telegramOk({ message_id: 88, chat: { id: 4242 } });
				}
				if (method === "getUpdates") {
					await waitUntil(() => callbackData.length > 0);
					if (updateDelivered) return telegramOk([]);
					updateDelivered = true;
					return telegramOk([
						{
							update_id: 100,
							callback_query: {
								id: "callback-1",
								data: callbackData,
								message: { message_id: 88, chat: { id: 4242 } },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue", "Green"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (factory: any) =>
							await new Promise((resolve) => {
								factory(
									{ requestRender() {}, terminal: { rows: 24 } },
									createTheme(),
									createKeybindings(),
									resolve,
								);
							}),
					},
				},
			);

			expect(result.details.cancelled).toBe(false);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Blue"],
			});
			const editMessage = calls.find(
				(call) => call.method === "editMessageText",
			);
			expect(editMessage?.body.chat_id).toBe("4242");
			expect(editMessage?.body.message_id).toBe(88);
			expect((editMessage?.body.rich_message?.html ?? editMessage?.body.text)).toContain("Answered:");
			expect((editMessage?.body.rich_message?.html ?? editMessage?.body.text)).toContain("Blue");
			expect(editMessage?.body.reply_markup).toEqual({ inline_keyboard: [] });
		});

		test("prompts for a Telegram custom answer from the quick button", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_CUSTOM", "4242");
			const tool = await setupTool();
			let customCallbackData = "";
			let updateDelivered = false;
			let promptSent = false;
			const initialMessageId = 92;

			stubFetch(async (url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					if (body.reply_to_message_id === initialMessageId) {
						promptSent = true;
						return telegramOk({ message_id: 93, chat: { id: 4242 } });
					}
					customCallbackData =
						body.reply_markup.inline_keyboard[1][0].callback_data;
					return telegramOk({
						message_id: initialMessageId,
						chat: { id: 4242 },
					});
				}
				if (method === "getUpdates") {
					await waitUntil(() => customCallbackData.length > 0);
					if (updateDelivered) return telegramOk([]);
					updateDelivered = true;
					return telegramOk([
						{
							update_id: 120,
							callback_query: {
								id: "callback-custom",
								data: customCallbackData,
								message: { message_id: initialMessageId, chat: { id: 4242 } },
							},
						},
						{
							update_id: 121,
							message: {
								message_id: 122,
								chat: { id: 4242 },
								text: "Ship it next week instead.",
								reply_to_message: { message_id: initialMessageId },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a rollout option",
					options: ["Now", "Later"],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (factory: any) =>
							await new Promise((resolve) => {
								factory(
									{ requestRender() {}, terminal: { rows: 24 } },
									createTheme(),
									createKeybindings(),
									resolve,
								);
							}),
					},
				},
			);

			expect(promptSent).toBe(true);
			expect(result.details.response).toEqual({
				kind: "freeform",
				text: "Ship it next week instead.",
			});
		});

		test("accepts reply-to-message option letters for multi-select Telegram answers", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_REPLY", "4242");
			const tool = await setupTool();
			let messageId = 0;
			let updateDelivered = false;

			stubFetch(async (url) => {
				const method = url.split("/").pop()!;
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					messageId = 91;
					return telegramOk({ message_id: messageId, chat: { id: 4242 } });
				}
				if (method === "getUpdates") {
					await waitUntil(() => messageId > 0);
					if (updateDelivered) return telegramOk([]);
					updateDelivered = true;
					return telegramOk([
						{
							update_id: 150,
							message: {
								message_id: 151,
								chat: { id: 4242 },
								text: "A,C",
								reply_to_message: { message_id: messageId },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick colors",
					options: ["Red", "Blue", "Green"],
					allowMultiple: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (factory: any) =>
							await new Promise((resolve) => {
								factory(
									{ requestRender() {}, terminal: { rows: 24 } },
									createTheme(),
									createKeybindings(),
									resolve,
								);
							}),
					},
				},
			);

			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Red", "Green"],
			});
		});

		test("accepts Telegram selection comments in reply text", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_COMMENT", "4242");
			const tool = await setupTool();
			let messageId = 0;
			let updateDelivered = false;
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch(async (url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				calls.push({ method, body });
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					messageId = 94;
					return telegramOk({ message_id: messageId, chat: { id: 4242 } });
				}
				if (method === "getUpdates") {
					await waitUntil(() => messageId > 0);
					if (updateDelivered) return telegramOk([]);
					updateDelivered = true;
					return telegramOk([
						{
							update_id: 160,
							message: {
								message_id: 161,
								chat: { id: 4242 },
								text: "B - Keep audit logging enabled.",
								reply_to_message: { message_id: messageId },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowComment: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (factory: any) =>
							await new Promise((resolve) => {
								factory(
									{ requestRender() {}, terminal: { rows: 24 } },
									createTheme(),
									createKeybindings(),
									resolve,
								);
							}),
					},
				},
			);

			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Blue"],
				comment: "Keep audit logging enabled.",
			});
			const editMessage = calls.find(
				(call) => call.method === "editMessageText",
			);
			expect(editMessage?.body.message_id).toBe(messageId);
			expect((editMessage?.body.rich_message?.html ?? editMessage?.body.text)).toContain(
				"Blue — Keep audit logging enabled.",
			);
		});

		test("keeps simultaneous Telegram answers mapped to their own ask_user request", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_SAME_PROCESS", "4242");
			const tool = await setupTool();
			const callbackDataByQuestion = new Map<string, string>();
			let sendCount = 0;
			let updatesDelivered = false;

			stubFetch(async (url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					sendCount += 1;
					const question = String(body.rich_message?.html ?? body.text).includes("First question")
						? "first"
						: "second";
					const selectedButton =
						question === "first"
							? body.reply_markup.inline_keyboard[0][0]
							: body.reply_markup.inline_keyboard[0][1];
					callbackDataByQuestion.set(question, selectedButton.callback_data);
					return telegramOk({
						message_id: question === "first" ? 201 : 202,
						chat: { id: 4242 },
					});
				}
				if (method === "getUpdates") {
					await waitUntil(() => sendCount === 2);
					if (updatesDelivered) return telegramOk([]);
					updatesDelivered = true;
					return telegramOk([
						{
							update_id: 201,
							callback_query: {
								id: "callback-first",
								data: callbackDataByQuestion.get("first"),
								message: { message_id: 201, chat: { id: 4242 } },
							},
						},
						{
							update_id: 202,
							callback_query: {
								id: "callback-second",
								data: callbackDataByQuestion.get("second"),
								message: { message_id: 202, chat: { id: 4242 } },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const createCtx = () => ({
				hasUI: true,
				ui: {
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								resolve,
							);
						}),
				},
			});

			const [first, second] = await Promise.all([
				tool.execute(
					"first-tool-call",
					{ question: "First question", options: ["A1", "B1"] },
					undefined,
					undefined,
					createCtx(),
				),
				tool.execute(
					"second-tool-call",
					{ question: "Second question", options: ["A2", "B2"] },
					undefined,
					undefined,
					createCtx(),
				),
			]);

			expect(first.details.response).toEqual({
				kind: "selection",
				selections: ["A1"],
			});
			expect(second.details.response).toEqual({
				kind: "selection",
				selections: ["B2"],
			});
		});

		test("shares Telegram polling across independent module sessions", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_SESSIONS", "9999");
			const firstTool = await setupTool("?session=first");
			const secondTool = await setupTool("?session=second");
			const callbackDataByQuestion = new Map<string, string>();
			let sendCount = 0;
			let updatesDelivered = false;

			stubFetch(async (url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					sendCount += 1;
					const question = String(body.rich_message?.html ?? body.text).includes("Session one")
						? "first"
						: "second";
					const selectedButton =
						question === "first"
							? body.reply_markup.inline_keyboard[0][0]
							: body.reply_markup.inline_keyboard[0][1];
					callbackDataByQuestion.set(question, selectedButton.callback_data);
					return telegramOk({
						message_id: question === "first" ? 301 : 302,
						chat: { id: 9999 },
					});
				}
				if (method === "getUpdates") {
					await waitUntil(() => sendCount === 2);
					if (updatesDelivered) return telegramOk([]);
					updatesDelivered = true;
					return telegramOk([
						{
							update_id: 301,
							callback_query: {
								id: "callback-session-one",
								data: callbackDataByQuestion.get("first"),
								message: { message_id: 301, chat: { id: 9999 } },
							},
						},
						{
							update_id: 302,
							callback_query: {
								id: "callback-session-two",
								data: callbackDataByQuestion.get("second"),
								message: { message_id: 302, chat: { id: 9999 } },
							},
						},
					]);
				}
				return telegramOk(true);
			});

			const createCtx = () => ({
				hasUI: true,
				ui: {
					custom: async (factory: any) =>
						await new Promise((resolve) => {
							factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								resolve,
							);
						}),
				},
			});

			const firstPromise = firstTool.execute(
				"first-session-tool-call",
				{ question: "Session one question", options: ["One-A", "One-B"] },
				undefined,
				undefined,
				createCtx(),
			);
			const secondPromise = secondTool.execute(
				"second-session-tool-call",
				{ question: "Session two question", options: ["Two-A", "Two-B"] },
				undefined,
				undefined,
				createCtx(),
			);
			const [first, second] = await Promise.all([firstPromise, secondPromise]);

			expect(first.details.response).toEqual({
				kind: "selection",
				selections: ["One-A"],
			});
			expect(second.details.response).toEqual({
				kind: "selection",
				selections: ["Two-B"],
			});
		});
	});

	describe("agent_end Telegram notifications", () => {
		test("reconciles async runs when their start event was missed", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_AGENT_END_RECONCILE", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "10");
			const extension = await setupExtension();
			const calls: string[] = [];

			extension.eventHandlers.set("subagents:rpc:v1:request", [
				(request) => {
					emitExtensionEvent(
						extension,
						`subagents:rpc:v1:reply:${request.requestId}`,
						{
							success: true,
							data: {
								text: "Active async runs: 1\n\n- restored-run | running | single | step 1/1 | /tmp",
							},
						},
					);
				},
			]);
			emitExtensionEvent(extension, "subagents:rpc:v1:ready");
			stubFetch((url) => {
				calls.push(url.split("/").pop()!);
				return telegramOk({ message_id: 506, chat: { id: 4242 } });
			});

			await runExtensionHandlers(extension, "agent_end", {
				messages: [{ role: "assistant", content: "Root turn ended" }],
			});
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(calls).toEqual([]);
			await runExtensionHandlers(extension, "session_shutdown");
		});

		test("waits for all async subagents before sending the idle notification", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_AGENT_END_ASYNC", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "10");
			const extension = await setupExtension();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				calls.push({ method: url.split("/").pop()!, body: jsonBody(init) });
				return telegramOk({ message_id: 504, chat: { id: 4242 } });
			});

			emitExtensionEvent(extension, "subagent:async-started", {
				id: "async-run-1",
			});
			await runExtensionHandlers(extension, "agent_end", {
				messages: [{ role: "assistant", content: "Background work continues" }],
			});
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(calls.some((call) => call.method === "sendRichMessage" || (call.method === "sendMessage" || call.method === "sendRichMessage"))).toBe(false);

			emitExtensionEvent(extension, "subagent:async-complete", {
				runId: "async-run-1",
			});
			await waitUntil(() => calls.some((call) => call.method === "sendRichMessage" || (call.method === "sendMessage" || call.method === "sendRichMessage")));
			await runExtensionHandlers(extension, "session_shutdown");
		});

		test("does not send Telegram notifications from subagent processes", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_CHILD_PROCESS", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "0");
			stubEnv("PI_SUBAGENT_CHILD", "1");
			const extension = await setupExtension(
				`?subagent-process=${Date.now()}`,
			);
			const calls: string[] = [];

			stubFetch((url) => {
				calls.push(url.split("/").pop()!);
				return telegramOk({ message_id: 505, chat: { id: 4242 } });
			});

			await runExtensionHandlers(extension, "agent_end", {
				messages: [{ role: "assistant", content: "Child done" }],
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(calls).toEqual([]);
		});

		test("sends an idle Telegram message only after the configured delay", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_AGENT_END_DELAY", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "15");
			const extension = await setupExtension();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				const body = jsonBody(init);
				calls.push({ method, body });
				return telegramOk({ message_id: 501, chat: { id: 4242 } });
			});

			await runExtensionHandlers(
				extension,
				"agent_end",
				{
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "All done. Ready?" }],
						},
					],
				},
				{
					cwd: "/tmp/project",
					model: { provider: "test", name: "Model" },
					sessionManager: { getSessionId: () => "session-1" },
				},
			);

			expect(calls.some((call) => call.method === "sendRichMessage" || (call.method === "sendMessage" || call.method === "sendRichMessage"))).toBe(false);
			await waitUntil(() => calls.some((call) => call.method === "sendRichMessage" || (call.method === "sendMessage" || call.method === "sendRichMessage")));
			const notification = calls.find((call) => call.method === "sendRichMessage" || (call.method === "sendMessage" || call.method === "sendRichMessage"));
			expect(notification?.body.chat_id).toBe("4242");
			expect(notification?.body.rich_message?.html ?? (notification?.body.rich_message?.html ?? notification?.body.text)).toContain("Pi agent idle");
			expect(notification?.body.rich_message?.html ?? (notification?.body.rich_message?.html ?? notification?.body.text)).toContain("project");
			expect(notification?.body.rich_message?.html ?? (notification?.body.rich_message?.html ?? notification?.body.text)).toContain("All done. Ready?");
			await runExtensionHandlers(extension, "session_shutdown");
		});

		test("suppresses the idle Telegram message when the user responds before the delay", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_AGENT_END_SUPPRESS", "4242");
			stubEnv("PI_TELEGRAM_NOTIFY_DELAY_MS", "25");
			const extension = await setupExtension();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				calls.push({ method: url.split("/").pop()!, body: jsonBody(init) });
				return telegramOk({ message_id: 502, chat: { id: 4242 } });
			});

			await runExtensionHandlers(extension, "agent_end", {
				messages: [{ role: "assistant", content: "Done" }],
			});
			await runExtensionHandlers(extension, "before_agent_start", {
				prompt: "Thanks",
			});
			await new Promise((resolve) => setTimeout(resolve, 40));

			expect(calls.some((call) => (call.method === "sendMessage" || call.method === "sendRichMessage"))).toBe(false);
			await runExtensionHandlers(extension, "session_shutdown");
		});

		test("marks an already-sent idle Telegram message as resumed", async () => {
			stubTelegramSettings("123456:TEST_TOKEN_AGENT_END_RESUME", "4242");
			const extension = await setupExtension();
			const calls: Array<{ method: string; body: any }> = [];

			stubFetch((url, init) => {
				const method = url.split("/").pop()!;
				calls.push({ method, body: jsonBody(init) });
				if ((method === "sendMessage" || method === "sendRichMessage")) {
					return telegramOk({ message_id: 503, chat: { id: 4242 } });
				}
				return telegramOk(true);
			});

			await runExtensionHandlers(extension, "agent_end", {
				messages: [{ role: "assistant", content: "Done" }],
			});
			await waitUntil(() =>
				calls.some((call) => (call.method === "sendMessage" || call.method === "sendRichMessage")),
			);
			await runExtensionHandlers(extension, "before_agent_start", {
				prompt: "Continuemos",
			});

			const editMessage = calls.find(
				(call) => call.method === "editMessageText",
			);
			expect(editMessage?.body.message_id).toBe(503);
			expect((editMessage?.body.rich_message?.html ?? editMessage?.body.text)).toContain("✅ Resumed");
			await runExtensionHandlers(extension, "session_shutdown");
		});
	});

	describe("overlay hide/show toggle (alt+o)", () => {
		function createOverlayHandle() {
			let hidden = false;
			const calls: boolean[] = [];
			return {
				handle: {
					hide() {},
					setHidden(value: boolean) {
						hidden = value;
						calls.push(value);
					},
					isHidden() {
						return hidden;
					},
					focus() {},
					unfocus() {},
					isFocused() {
						return false;
					},
				},
				calls,
			};
		}

		test("registers an onTerminalInput listener and passes onHandle in overlay mode", async () => {
			const tool = await setupTool();
			let capturedOptions: any;
			let inputHandler: ((data: string) => any) | undefined;
			let unsubscribed = false;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							capturedOptions = options;
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {
								unsubscribed = true;
							};
						},
						notify: () => {},
					},
				},
			);

			expect(typeof capturedOptions.onHandle).toBe("function");
			expect(typeof inputHandler).toBe("function");
			expect(unsubscribed).toBe(true);
		});

		test("does not register onTerminalInput in inline mode", async () => {
			const tool = await setupTool();
			let registered = false;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], displayMode: "inline" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => null,
						onTerminalInput: () => {
							registered = true;
							return () => {};
						},
					},
				},
			);

			expect(registered).toBe(false);
		});

		test("alt+o toggles overlay visibility via OverlayHandle.setHidden", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;
			const notifications: Array<{ message: string; type?: string }> = [];

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							// Simulate the user pressing alt+o twice while the overlay is shown.
							const firstResult = inputHandler?.("alt+o");
							const secondResult = inputHandler?.("alt+o");
							expect(firstResult).toEqual({ consume: true });
							expect(secondResult).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: (message: string, type?: string) => {
							notifications.push({ message, type });
						},
					},
				},
			);

			const hideNotifications = notifications.filter((notification) =>
				notification.message.includes("ask_user hidden"),
			);
			expect(calls).toEqual([true, false]);
			expect(hideNotifications).toHaveLength(1);
			expect(hideNotifications[0]?.message).toContain("alt+o");
			expect(hideNotifications[0]?.type).toBe("info");
		});

		test("does not consume ctrl+o from the terminal listener", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const result = inputHandler?.("ctrl+o");
							expect(result).toBeUndefined();
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: () => {},
					},
				},
			);

			expect(calls).toEqual([]);
		});

		test("does not force a hidden overlay visible during cleanup", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							// Hide and resolve while still hidden.
							inputHandler?.("alt+o");
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: () => {},
					},
				},
			);

			expect(calls).toEqual([true]);
		});

		test("per-call overlayToggleKey replaces the default alt+o binding", async () => {
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;
			const notifications: Array<{ message: string; type?: string }> = [];

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "alt+h" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const ignored = inputHandler?.("alt+o");
							const consumed = inputHandler?.("alt+h");
							expect(ignored).toBeUndefined();
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: (message: string, type?: string) => {
							notifications.push({ message, type });
						},
					},
				},
			);

			const hideNotifications = notifications.filter((notification) =>
				notification.message.includes("ask_user hidden"),
			);
			expect(calls).toEqual([true]);
			expect(hideNotifications).toHaveLength(1);
			expect(hideNotifications[0]?.message).toContain("alt+h");
		});

		test("PI_ASK_USER_OVERLAY_TOGGLE_KEY env var overrides default", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"] },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const ignored = inputHandler?.("alt+o");
							const consumed = inputHandler?.("alt+h");
							expect(ignored).toBeUndefined();
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: () => {},
					},
				},
			);

			expect(calls).toEqual([true]);
		});

		test("per-call overlayToggleKey wins over env var", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "alt+x" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const ignoredEnv = inputHandler?.("alt+h");
							const consumed = inputHandler?.("alt+x");
							expect(ignoredEnv).toBeUndefined();
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: () => {},
					},
				},
			);

			expect(calls).toEqual([true]);
		});

		test("overlayToggleKey 'off' disables the listener entirely", async () => {
			const tool = await setupTool();
			let registered = false;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "off" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => null,
						onTerminalInput: () => {
							registered = true;
							return () => {};
						},
					},
				},
			);

			expect(registered).toBe(false);
		});

		test("invalid overlayToggleKey falls through to env var", async () => {
			stubEnv("PI_ASK_USER_OVERLAY_TOGGLE_KEY", "alt+h");
			const tool = await setupTool();
			const { handle, calls } = createOverlayHandle();
			let inputHandler: ((data: string) => any) | undefined;

			await tool.execute(
				"tool-call-id",
				{ question: "Q", options: ["A"], overlayToggleKey: "++bad++" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async (_factory: any, options: any) => {
							options.onHandle?.(handle);
							const consumed = inputHandler?.("alt+h");
							expect(consumed).toEqual({ consume: true });
							return null;
						},
						onTerminalInput: (handler: (data: string) => any) => {
							inputHandler = handler;
							return () => {};
						},
						notify: () => {},
					},
				},
			);

			expect(calls).toEqual([true]);
		});
	});

	test("renders partial updates as waiting state instead of a successful empty answer", async () => {
		const tool = await setupTool();
		let partialUpdate: any;

		await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			(update: any) => {
				partialUpdate = update;
			},
			{
				hasUI: true,
				ui: {
					custom: async () => null,
				},
			},
		);

		const component = tool.renderResult(
			partialUpdate,
			{ expanded: false, isPartial: true },
			createTheme(),
		) as any;
		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("Waiting for user input...");
		expect(rendered).not.toContain("✓");
	});

	test("marks each selected option in expanded multi-select results", async () => {
		const tool = await setupTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User answered: A, B" }],
				details: {
					question: "Choose one or more",
					options: [{ title: "A" }, { title: "B" }, { title: "C" }],
					response: { kind: "selection", selections: ["A", "B"] },
					cancelled: false,
				},
			},
			{ expanded: true, isPartial: false },
			createTheme(),
		) as any;

		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("● A");
		expect(rendered).toContain("● B");
		expect(rendered).toContain("○ C");
	});

	test("renders selection comments separately in expanded results", async () => {
		const tool = await setupTool();
		const component = tool.renderResult(
			{
				content: [{ type: "text", text: "User answered: Blue" }],
				details: {
					question: "Pick a color",
					options: [{ title: "Red" }, { title: "Blue" }, { title: "Green" }],
					response: {
						kind: "selection",
						selections: ["Blue"],
						comment: "Match the current brand palette.",
					},
					cancelled: false,
				},
			},
			{ expanded: true, isPartial: false },
			createTheme(),
		) as any;

		const rendered = component.render(120).join("\n");

		expect(rendered).toContain("● Blue");
		expect(rendered).toContain("Comment:");
		expect(rendered).toContain("Match the current brand palette.");
	});

	test("enters freeform mode without editor theme crashes", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");

						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
	});

	test("uses shared confirm keybinding in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.confirm": ["x"] }),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("x");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["A"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("forwards ctrl+enter to the editor instead of submitting freeform mode", async () => {
		const tool = await setupTool();
		editorInputs = [];
		editorText = "draft answer";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["A", "B"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						component.handleInput("ctrl+enter");

						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.cancelled).toBe(true);
		expect(editorInputs).toEqual(["ctrl+enter"]);
	});

	test("filters single-select options from typed search before confirming", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("b");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Beta"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("navigates single-select options with ctrl+j (vim down)", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+j");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Beta"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("wraps to last option when ctrl+k (vim up) is pressed at the top", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowFreeform: false,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+k");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Gamma"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("treats bare j as fuzzy-search input rather than navigation", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "June", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("j");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["June"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("navigates multi-select options with ctrl+j before toggling", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which options should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowMultiple: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+j");
						component.handleInput("space");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Beta"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("keeps single-select search usable when comment toggling is enabled", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Chrome", "Firefox", "Safari"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("c");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Chrome"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("treats out-of-range number keys as search input in single-select mode", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta 7", "Gamma"],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("7");
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Beta 7"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("keeps freeform available when search filters out every option", async () => {
		const tool = await setupTool();
		editorInputs = [];

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: string | null | undefined;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: string | null) => {
								resolved = value;
							},
						);

						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("z");
						component.handleInput("enter");
						editorText = "custom from editor";
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		const answeredEvent = emittedEvents.find(
			(event) => event.name === "ask:answered",
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "freeform",
			text: "custom from editor",
		});
		expect(result.details.cancelled).toBe(false);
		expect(answeredEvent?.payload.response).toEqual({
			kind: "freeform",
			text: "custom from editor",
		});
		expect(editorInputs).toEqual(["enter"]);
	});

	test("shows the remapped cancel key in freeform help text", async () => {
		const tool = await setupTool();
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings({ "tui.select.cancel": ["q"] }),
							() => {},
						);

						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("enter");
						helpText = (component as any).helpText.render().join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(helpText).toContain("alt+o hide");
		expect(helpText).toContain("q cancel");
		expect(helpText).not.toContain("ctrl+c cancel");
	});

	test("renders a details pane for wide single-select layouts", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{
						title: "Alpha",
						description: "The alpha option keeps the rollout conservative.",
					},
					{
						title: "Beta",
						description: "The beta option favors faster iteration.",
					},
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any)
							.render(120)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("## Alpha");
		expect(rendered).toContain(
			"The alpha option keeps the rollout conservative.",
		);
	});

	test("shows a custom response preview in the wide details pane", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowFreeform: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						component.handleInput("down");
						component.handleInput("down");
						rendered = ((component as any).singleSelectList as any)
							.render(120)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).toContain("Custom response");
		expect(rendered).toContain("Open the editor to write **any** answer.");
	});

	test("falls back to the single-column list on narrow widths", async () => {
		const tool = await setupTool();
		let rendered = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: [
					{
						title: "Alpha",
						description: "The alpha option keeps the rollout conservative.",
					},
					{
						title: "Beta",
						description: "The beta option favors faster iteration.",
					},
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						rendered = ((component as any).singleSelectList as any)
							.render(60)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(rendered).not.toContain("Details");
		expect(rendered).not.toContain(" │ ");
		expect(rendered).toContain(
			"The alpha option keeps the rollout conservative.",
		);
	});
	test("submits immediately when the comment toggle is off", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha"],
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("toggles extra context with the ctrl+g key and shows it in help text", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfter = "";
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						renderedBefore = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						helpText = (component as any).helpText.render().join("\n");
						component.handleInput("ctrl+g");
						renderedAfter = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfter).toContain("[✓] Add extra context after selection");
		expect(helpText).toContain("ctrl+g toggle context");
	});

	test("uses custom commentToggleKey for comment toggling and help text", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfterIgnored = "";
		let renderedAfterCustom = "";
		let helpText = "";

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
				commentToggleKey: "alt+c",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);

						renderedBefore = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						helpText = (component as any).helpText.render().join("\n");
						// Default ctrl+g should no longer toggle.
						component.handleInput("ctrl+g");
						renderedAfterIgnored = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						// Configured alt+c should toggle.
						component.handleInput("alt+c");
						renderedAfterCustom = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfterIgnored).toContain(
			"[ ] Add extra context after selection",
		);
		expect(renderedAfterCustom).toContain(
			"[✓] Add extra context after selection",
		);
		expect(helpText).toContain("alt+c toggle context");
		expect(helpText).not.toContain("ctrl+g toggle context");
	});

	test("commentToggleKey 'off' hides the toggle hint and ignores ctrl+g", async () => {
		const tool = await setupTool();
		let renderedBefore = "";
		let renderedAfter = "";
		let helpText = "";

		await tool.execute(
			"tool-call-id",
			{
				question: "Q",
				options: ["Alpha", "Beta"],
				allowComment: true,
				commentToggleKey: "off",
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							() => {},
						);
						renderedBefore = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						helpText = (component as any).helpText.render().join("\n");
						component.handleInput("ctrl+g");
						renderedAfter = ((component as any).singleSelectList as any)
							.render(80)
							.join("\n");
						return null;
					},
				},
			},
		);

		expect(renderedBefore).toContain("[ ] Add extra context after selection");
		expect(renderedAfter).toContain("[ ] Add extra context after selection");
		expect(helpText).not.toContain("toggle context");
	});

	test("collects an optional comment after a single selection before resolving", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which option should we use?",
				options: ["Alpha", "Beta"],
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("ctrl+g");
						component.handleInput("enter");
						expect(resolved).toBeUndefined();
						editorText = "Needs audit logging before rollout.";
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha"],
			comment: "Needs audit logging before rollout.",
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("collects an optional comment for multi-select answers", async () => {
		const tool = await setupTool();

		const result = await tool.execute(
			"tool-call-id",
			{
				question: "Which options should we use?",
				options: ["Alpha", "Beta", "Gamma"],
				allowMultiple: true,
				allowComment: true,
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let resolved: any;
						const component = factory(
							{ requestRender() {}, terminal: { rows: 24 } },
							createTheme(),
							createKeybindings(),
							(value: any) => {
								resolved = value;
							},
						);

						component.handleInput("space");
						component.handleInput("down");
						component.handleInput("down");
						component.handleInput("space");
						component.handleInput("ctrl+g");
						component.handleInput("enter");
						expect(resolved).toBeUndefined();
						editorText = "Roll out both behind the same flag.";
						component.handleInput("enter");
						return resolved ?? null;
					},
				},
			},
		);

		expect(result.isError).not.toBe(true);
		expect(result.details.response).toEqual({
			kind: "selection",
			selections: ["Alpha", "Gamma"],
			comment: "Roll out both behind the same flag.",
		});
		expect(result.details.cancelled).toBe(false);
	});

	test("does not crash when host theme singleton is uninitialised (regression for #17)", async () => {
		// The shared `getMarkdownTheme` mock above returns a bag of closures
		// that throw on every property read of the underlying theme proxy,
		// mirroring what happens on pre-rename hosts where our bundled copy of
		// pi-coding-agent has its own (uninitialised) `globalThis` slot. The
		// `Markdown` mock above also calls `theme.bold` during render. So if
		// the extension ever stops gating through `safeMarkdownTheme()`, the
		// throw surfaces at one of the two callsites: the constructor's
		// context branch, or the split-pane preview built by
		// `buildPreviewLines` — both must remain quiet.
		const tool = await setupTool();
		let constructionError: unknown;
		let previewError: unknown;
		let preview = "";

		await tool.execute(
			"tool-call-id",
			{
				question: "Pick one",
				context: "Some **markdown** context",
				options: [
					{ title: "Alpha", description: "First **emphasised** option" },
					{ title: "Beta", description: "Second option" },
				],
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					custom: async (factory: any) => {
						let component: any;
						try {
							component = factory(
								{ requestRender() {}, terminal: { rows: 24 } },
								createTheme(),
								createKeybindings(),
								() => {},
							);
						} catch (err) {
							constructionError = err;
							return null;
						}
						try {
							// Width 120 forces the split-pane preview, which is the
							// path that constructs and renders the Markdown
							// component over the option description.
							preview = (component.singleSelectList as any)
								.render(120)
								.join("\n");
						} catch (err) {
							previewError = err;
						}
						return null;
					},
				},
			},
		);

		expect(constructionError).toBeUndefined();
		expect(previewError).toBeUndefined();
		// Confirm the raw markdown fell through to plain Text rendering rather
		// than getting silently dropped when the theme proxy was unavailable.
		expect(preview).toContain("## Alpha");
		expect(preview).toContain("First **emphasised** option");
	});

	describe("RPC fallback (custom() returns undefined)", () => {
		test("single-select falls back to ctx.ui.select()", async () => {
			const tool = await setupTool();
			let selectTitle = "";
			let selectOptions: string[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: false,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async (title: string, opts: string[]) => {
							selectTitle = title;
							selectOptions = opts;
							return "Blue";
						},
						input: async () => undefined,
					},
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Blue"],
			});
			expect(result.details.cancelled).toBe(false);
			expect(selectTitle).toContain("Pick a color");
			expect(selectOptions).toEqual(["Red", "Blue"]);
		});

		test("single-select with freeform appends sentinel option", async () => {
			const tool = await setupTool();
			let selectOptions: string[] = [];

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async (_title: string, opts: string[]) => {
							selectOptions = opts;
							return "Red";
						},
						input: async () => undefined,
					},
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Red"],
			});
			// Last option should be the freeform sentinel
			expect(selectOptions).toHaveLength(3);
			expect(selectOptions[2]).toContain("Type custom response");
		});

		test("selecting freeform sentinel follows up with input()", async () => {
			const tool = await setupTool();
			let inputCalled = false;
			const sentinel = "\u270f\ufe0f Type custom response...";

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async () => sentinel,
						input: async () => {
							inputCalled = true;
							return "Purple";
						},
					},
				},
			);

			expect(result.isError).not.toBe(true);
			expect(inputCalled).toBe(true);
			expect(result.details.response).toEqual({
				kind: "freeform",
				text: "Purple",
			});
		});

		test("multi-select degrades to input() with options in prompt", async () => {
			const tool = await setupTool();
			let inputTitle = "";

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick colors",
					options: ["Red", "Blue", "Green"],
					allowMultiple: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async () => undefined,
						input: async (title: string) => {
							inputTitle = title;
							return "Red, Green";
						},
					},
				},
			);

			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Red", "Green"],
			});
			// Prompt should list the options for the user
			expect(inputTitle).toContain("1. Red");
			expect(inputTitle).toContain("2. Blue");
			expect(inputTitle).toContain("3. Green");
		});

		test("single-select can collect an optional comment after choosing an option", async () => {
			const tool = await setupTool();
			let inputCalls = 0;

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowComment: true,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async () => "Blue",
						input: async () => {
							inputCalls += 1;
							return "Keep it aligned with the settings screen.";
						},
					},
				},
			);

			expect(inputCalls).toBe(1);
			expect(result.isError).not.toBe(true);
			expect(result.details.response).toEqual({
				kind: "selection",
				selections: ["Blue"],
				comment: "Keep it aligned with the settings screen.",
			});
			expect(result.details.cancelled).toBe(false);
		});

		test("returns cancelled when select() returns undefined", async () => {
			const tool = await setupTool();

			const result = await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async () => undefined,
						input: async () => undefined,
					},
				},
			);

			expect(result.details.cancelled).toBe(true);
			expect(result.details.response).toBeNull();
		});

		test("passes context into the dialog prompt", async () => {
			const tool = await setupTool();
			let selectTitle = "";

			await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					context: "The sky is blue today.",
					options: ["Red", "Blue"],
					allowFreeform: false,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async (title: string) => {
							selectTitle = title;
							return "Blue";
						},
						input: async () => undefined,
					},
				},
			);

			expect(selectTitle).toContain("Pick a color");
			expect(selectTitle).toContain("The sky is blue today.");
		});

		test("passes timeout to dialog methods", async () => {
			const tool = await setupTool();
			let capturedOpts: any;

			await tool.execute(
				"tool-call-id",
				{
					question: "Pick a color",
					options: ["Red", "Blue"],
					allowFreeform: false,
					timeout: 5000,
				},
				undefined,
				undefined,
				{
					hasUI: true,
					ui: {
						custom: async () => undefined,
						select: async (_title: string, _opts: string[], opts: any) => {
							capturedOpts = opts;
							return "Red";
						},
						input: async () => undefined,
					},
				},
			);

			expect(capturedOpts).toEqual({ timeout: 5000 });
		});
	});
});
