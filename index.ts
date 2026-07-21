/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
	Container,
	type Component,
	decodeKittyPrintable,
	Editor,
	type EditorTheme,
	fuzzyFilter,
	Key,
	type Keybinding,
	type KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type OverlayHandle,
	type SizeValue,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	renderSingleSelectRows,
	type QuestionOption,
} from "./single-select-layout";

import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (
	_require("./package.json") as { version: string }
).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 */
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: [...values],
		...(options?.description ? { description: options.description } : {}),
		...(options?.default !== undefined ? { default: options.default } : {}),
	});
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-telegram-notify/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
	try {
		const md = getMarkdownTheme();
		if (!md) return undefined;
		md.bold("");
		return md;
	} catch {
		return undefined;
	}
}

type AskOptionInput = QuestionOption | string;

type AskDisplayMode = "overlay" | "inline";

interface AskParams {
	question: string;
	context?: string;
	options?: AskOptionInput[];
	allowMultiple?: boolean;
	allowFreeform?: boolean;
	allowComment?: boolean;
	displayMode?: AskDisplayMode;
	overlayToggleKey?: string | null;
	commentToggleKey?: string | null;
	timeout?: number;
}

type AskResponse =
	| {
			kind: "selection";
			selections: string[];
			comment?: string;
	  }
	| {
			kind: "freeform";
			text: string;
	  };

interface AskToolDetails {
	question: string;
	context?: string;
	options: QuestionOption[];
	response: AskResponse | null;
	cancelled: boolean;
	timedOut?: boolean;
	presenceMode?: "normal" | "away";
	timeoutMs?: number;
}

type AskUIResult = AskResponse;

type AskNotificationRequest = Pick<
	AskParams,
	"question" | "allowMultiple" | "allowFreeform" | "allowComment" | "timeout"
> & {
	context?: string;
	options: QuestionOption[];
};

interface TelegramConfig {
	botToken: string;
	chatId: string;
	apiBaseUrl: string;
}

interface TelegramNotifySettingsFile {
	askUser?: {
		availability?: {
			enabled?: boolean;
			awayTimeoutMs?: number;
		};
	};
	telegram?: {
		botToken?: string;
		chatId?: string | number;
	};
	piAskUser?: {
		telegram?: {
			botToken?: string;
			chatId?: string | number;
		};
	};
}

interface AskAvailabilityConfig {
	enabled: boolean;
	awayTimeoutMs: number;
}

interface AskPresenceState {
	mode: "normal" | "away";
	updatedAt: number;
	lastHumanActivityAt?: number;
	awaySince?: number;
}

interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	chat?: { id?: string | number };
}

interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		message_thread_id?: number;
		chat?: { id?: string | number };
		from?: { is_bot?: boolean };
		text?: string;
		reply_to_message?: { message_id?: number };
	};
	callback_query?: {
		id: string;
		data?: string;
		message?: TelegramMessage;
	};
}

interface TelegramAskHandle {
	response: Promise<AskUIResult | null>;
	answer: (response: AskUIResult) => Promise<void>;
	close: () => void;
}

type SharedTelegramAskStatus = "pending" | "answered" | "cancelled";

interface SharedTelegramAskRecord {
	id: string;
	request: AskNotificationRequest;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	messageId?: number;
	messageThreadId?: number;
	status: SharedTelegramAskStatus;
	response?: AskResponse | null;
}

interface TelegramSharedStore {
	rootDir: string;
	pendingDir: string;
	lockDir: string;
	lockFile: string;
	offsetFile: string;
	topicFile: string;
	topicLockDir: string;
	registrationsDir: string;
	inboxDir: string;
	updatesDir: string;
}

interface TelegramPollLock {
	refresh: () => Promise<void>;
	release: () => Promise<void>;
}

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_CALLBACK_PREFIX = "ptn";
const TELEGRAM_DEFAULT_NOTIFY_DELAY_MS = 60_000;
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;
const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const TELEGRAM_RETRY_DELAY_MS = 3_000;
const TELEGRAM_RESPONSE_POLL_MS = 50;
const TELEGRAM_LOCK_STALE_MS = 70_000;
const TELEGRAM_INBOX_DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function telegramRegistrationIntervalMs(): number {
	const value = Number.parseInt(process.env.PI_TELEGRAM_REGISTRATION_INTERVAL_MS ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : 5_000;
}
// Keep token tombstone directories forever as ownership fences, while removing
// their obsolete payloads after this long grace period.
const TELEGRAM_LOCK_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 3_900;
const TELEGRAM_MAX_BUTTON_TEXT_LENGTH = 52;
const ASK_AVAILABILITY_DEFAULT_AWAY_TIMEOUT_MS = 60_000;
const ASK_PRESENCE_LOCK_STALE_MS = 5_000;
const ASK_PRESENCE_LOCK_WAIT_MS = 2_000;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_RPC_TIMEOUT_MS = 500;

let telegramRequestCounter = 0;

function resolveTelegramNotifyDelayMs(): number {
	const raw = process.env.PI_TELEGRAM_NOTIFY_DELAY_MS;
	if (raw !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return TELEGRAM_DEFAULT_NOTIFY_DELAY_MS;
}

function createTelegramRequestId(): string {
	telegramRequestCounter = (telegramRequestCounter + 1) % 1_000_000;
	return `${Date.now().toString(36)}${telegramRequestCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function getPiAgentSettingsPath(): string {
	return join(process.env.HOME || homedir(), ".pi", "agent", "settings.json");
}

function validTimeoutMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

async function resolveAskAvailabilityConfig(): Promise<AskAvailabilityConfig> {
	const settings = await readJsonFile<TelegramNotifySettingsFile>(
		getPiAgentSettingsPath(),
	);
	const availability = settings?.askUser?.availability;
	return {
		enabled: availability?.enabled !== false,
		awayTimeoutMs: validTimeoutMs(
			availability?.awayTimeoutMs,
			ASK_AVAILABILITY_DEFAULT_AWAY_TIMEOUT_MS,
		),
	};
}

function getAskPresencePaths(): {
	agentDir: string;
	stateFile: string;
	lockDir: string;
} {
	const agentDir = join(process.env.HOME || homedir(), ".pi", "agent");
	return {
		agentDir,
		stateFile: join(agentDir, "ask-user-presence.json"),
		lockDir: join(agentDir, "ask-user-presence.lock"),
	};
}

async function readAskPresenceState(): Promise<AskPresenceState> {
	const state = await readJsonFile<AskPresenceState>(getAskPresencePaths().stateFile);
	if (state?.mode === "away" || state?.mode === "normal") return state;
	return { mode: "normal", updatedAt: Date.now() };
}

async function withAskPresenceLock<T>(operation: () => Promise<T>): Promise<T> {
	const { agentDir, lockDir } = getAskPresencePaths();
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + ASK_PRESENCE_LOCK_WAIT_MS;
	while (true) {
		try {
			await mkdir(lockDir, { mode: 0o700 });
			break;
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			try {
				const info = await stat(lockDir);
				if (Date.now() - info.mtimeMs > ASK_PRESENCE_LOCK_STALE_MS) {
					await rm(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch (statError) {
				if (!isErrno(statError, "ENOENT")) throw statError;
			}
			if (Date.now() >= deadline) throw new Error("Timed out locking ask presence state");
			await delay(25);
		}
	}

	try {
		return await operation();
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
}

async function writeAskPresenceState(state: AskPresenceState): Promise<void> {
	const { stateFile } = getAskPresencePaths();
	const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(tempFile, stateFile);
}

async function recordHumanActivity(): Promise<void> {
	await withAskPresenceLock(async () => {
		const now = Date.now();
		await writeAskPresenceState({
			mode: "normal",
			updatedAt: now,
			lastHumanActivityAt: now,
		});
	});
}

async function setUserAway(): Promise<void> {
	await withAskPresenceLock(async () => {
		const current = await readAskPresenceState();
		const now = Date.now();
		await writeAskPresenceState({
			...current,
			mode: "away",
			updatedAt: now,
			awaySince: now,
		});
	});
}

function formatDurationMs(ms: number): string {
	if (ms % 60_000 === 0) return `${ms / 60_000} min`;
	if (ms % 1_000 === 0) return `${ms / 1_000} sec`;
	return `${ms} ms`;
}

async function resolveTelegramConfig(): Promise<TelegramConfig | null> {
	const settings = await readJsonFile<TelegramNotifySettingsFile>(
		getPiAgentSettingsPath(),
	);
	// Keep accepting the original namespaced setting used by pi-ask-user
	// installations. The top-level key, when present, takes precedence.
	const telegram = settings?.telegram ?? settings?.piAskUser?.telegram;
	const botToken = telegram?.botToken?.trim();
	const rawChatId = telegram?.chatId;
	const chatId =
		typeof rawChatId === "number"
			? String(rawChatId)
			: typeof rawChatId === "string"
				? rawChatId.trim()
				: undefined;
	if (!botToken || !chatId) return null;

	return { botToken, chatId, apiBaseUrl: TELEGRAM_API_BASE_URL };
}

function createTelegramSharedStore(
	config: TelegramConfig,
): TelegramSharedStore {
	const key = createHash("sha256")
		.update(`${config.apiBaseUrl}\n${config.botToken}\n${config.chatId}`)
		.digest("hex")
		.slice(0, 32);
	const rootDir = join(tmpdir(), "pi-telegram-notify", key);
	return {
		rootDir,
		pendingDir: join(rootDir, "pending"),
		lockDir: join(rootDir, "poller.lock"),
		lockFile: join(rootDir, "poller.lock", "owner.json"),
		offsetFile: join(rootDir, "offset.json"),
		topicFile: join(rootDir, "topics.json"),
		topicLockDir: join(rootDir, "topics.lock"),
		registrationsDir: join(rootDir, "registrations"),
		inboxDir: join(rootDir, "inbox"),
		updatesDir: join(rootDir, "updates"),
	};
}

function buildAskNotificationRequest(params: {
	question: string;
	context?: string;
	options: QuestionOption[];
	allowMultiple: boolean;
	allowFreeform: boolean;
	allowComment: boolean;
	timeout?: number;
}): AskNotificationRequest {
	return {
		question: params.question,
		context: params.context,
		options: params.options,
		allowMultiple: params.allowMultiple,
		allowFreeform: params.allowFreeform,
		allowComment: params.allowComment,
		timeout: params.timeout,
	};
}

function truncatePlainText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 1) return "…";
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function telegramHtml(text: string, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH): string {
	if (maxLength <= 0) return "";
	let output = "";
	let truncated = false;
	// Reserve the ellipsis before accepting an atom: never slice escaped HTML.
	for (const character of text) {
		const escaped = escapeTelegramHtml(character);
		if (output.length + escaped.length + 1 > maxLength) {
			truncated = true;
			break;
		}
		output += escaped;
	}
	return truncated ? `${output}…` : output;
}

type TelegramHtmlPart = { html: string } | { text: string };

/** Builds one balanced, bounded HTML message from trusted markup and text atoms. */
function buildBoundedTelegramHtml(parts: TelegramHtmlPart[], maxLength = TELEGRAM_MAX_MESSAGE_LENGTH): string {
	const fixedLength = parts.reduce((length, part) => length + ("html" in part ? part.html.length : 0), 0);
	if (fixedLength > maxLength) throw new Error("Telegram message markup exceeds its limit");
	let remaining = maxLength - fixedLength;
	let output = "";
	let truncated = false;
	for (const part of parts) {
		if ("html" in part) {
			output += part.html;
			continue;
		}
		if (truncated) continue;
		for (const character of part.text) {
			const escaped = telegramHtml(character, maxLength);
			if (remaining < escaped.length + 1) {
				truncated = true;
				break;
			}
			output += escaped;
			remaining -= escaped.length;
		}
	}
	return truncated ? `${output}…` : output;
}

async function resolveTelegramTopicName(sessionId: string, sessionName?: string, cwd = process.cwd()): Promise<string | null> {
	try {
		// The common git directory belongs to the main repository even when cwd is a linked worktree.
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const repository = basename(dirname(stdout.trim())) || "repository";
		const name = sessionName?.trim() || sessionId.slice(0, 8);
		return truncatePlainText(`${repository} · ${name}`, 128);
	} catch {
		return null;
	}
}

function buildLocalAskNotificationText(
	request: AskNotificationRequest,
): string {
	const parts = [`ask_user: ${request.question}`];
	if (request.context) parts.push(`Context: ${request.context}`);
	if (request.options.length > 0) {
		parts.push(
			`${request.options.length} option(s): ${request.options.map((option) => option.title).join(", ")}`,
		);
	} else {
		parts.push("Freeform response requested");
	}
	return truncatePlainText(parts.join("\n"), 700);
}

function notifyAskRequested(
	ctx: unknown,
	request: AskNotificationRequest,
): void {
	const notify = (
		ctx as
			| { ui?: { notify?: (message: string, type?: string) => void } }
			| undefined
	)?.ui?.notify;
	if (typeof notify !== "function") return;

	try {
		notify(buildLocalAskNotificationText(request), "info");
	} catch {
		// Notifications must never block the question flow.
	}
}

function reportHerdrAskBlocked(
	pi: ExtensionAPI,
	active: boolean,
	id: string,
	label: string,
): void {
	try {
		pi.events.emit("herdr:blocked", {
			active,
			id,
			kind: "ask_user",
			label,
		});
	} catch {
		// Herdr integration must never interrupt the question flow.
	}
}

function notifyTelegramWarning(ctx: unknown, error: unknown): void {
	const notify = (
		ctx as
			| { ui?: { notify?: (message: string, type?: string) => void } }
			| undefined
	)?.ui?.notify;
	if (typeof notify !== "function") return;

	try {
		notify(
			`Telegram notification failed: ${safeTelegramErrorMessage(error)}`,
			"warning",
		);
	} catch {
		// Best-effort only.
	}
}

function safeTelegramErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return truncatePlainText(
		raw.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>"),
		220,
	);
}

function telegramOptionLabel(index: number): string {
	let value = Math.max(0, index);
	let label = "";
	do {
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return label;
}

type TelegramCallbackAction =
	| { type: "option"; requestId: string; optionIndex: number }
	| { type: "custom"; requestId: string };

function buildTelegramCallbackData(
	requestId: string,
	optionIndex: number,
): string {
	return `${TELEGRAM_CALLBACK_PREFIX}:${requestId}:${optionIndex.toString(36)}`;
}

function buildTelegramCustomCallbackData(requestId: string): string {
	return `${TELEGRAM_CALLBACK_PREFIX}:${requestId}:custom`;
}

function parseTelegramCallbackData(
	data: string,
): TelegramCallbackAction | null {
	const [prefix, requestId, action] = data.split(":");
	if (prefix !== TELEGRAM_CALLBACK_PREFIX || !requestId || !action) return null;
	if (action === "custom") return { type: "custom", requestId };

	const parsedIndex = Number.parseInt(action, 36);
	if (!Number.isInteger(parsedIndex) || parsedIndex < 0) return null;
	return { type: "option", requestId, optionIndex: parsedIndex };
}

function chunkTelegramButtons<T>(items: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		rows.push(items.slice(i, i + size));
	}
	return rows;
}

function buildTelegramInlineKeyboard(
	requestId: string,
	request: AskNotificationRequest,
) {
	if (request.options.length === 0 && !request.allowFreeform) return undefined;

	const buttons = request.options.map((option, index) => ({
		text: truncatePlainText(
			`${telegramOptionLabel(index)}. ${option.title}`,
			TELEGRAM_MAX_BUTTON_TEXT_LENGTH,
		),
		callback_data: buildTelegramCallbackData(requestId, index),
	}));
	const rows = chunkTelegramButtons(buttons, 3);

	if (request.allowFreeform && request.options.length > 0) {
		rows.push([
			{
				text: "✏️ Custom answer",
				callback_data: buildTelegramCustomCallbackData(requestId),
			},
		]);
	}

	return { inline_keyboard: rows };
}

interface TelegramRenderedMessage { rich: string; regular: string }

function askMessageParts(request: AskNotificationRequest, rich: boolean): TelegramHtmlPart[] {
	const choices = request.options.slice(0, 6);
	const parts: TelegramHtmlPart[] = [
		{ html: "🔔 <b>ask_user</b>\n\n<b>Question</b> " }, { text: request.question },
		{ html: choices.length ? "\n\n<b>Choices</b>\n" : "\n\n<i>Freeform answer requested</i>" },
	];
	for (const [index, option] of choices.entries()) {
		if (index) parts.push({ html: "\n" });
		parts.push({ html: `${telegramOptionLabel(index)}. ` }, { text: option.title });
		if (option.description) parts.push({ html: " — " }, { text: option.description });
	}
	parts.push({ html: "\n\n<i>Use a button or reply to this message.</i>" });
	if (request.context) {
		parts.push({ html: rich ? "\n\n<details><summary>Details</summary>" : "\n\n<b>Details</b>\n" }, { text: request.context });
		if (rich) parts.push({ html: "</details>" });
	}
	return parts;
}

/** Both transports receive independently balanced, whole-message bounded HTML. */
function renderTelegramAskMessage(request: AskNotificationRequest): TelegramRenderedMessage {
	return {
		rich: buildBoundedTelegramHtml(askMessageParts(request, true)),
		regular: buildBoundedTelegramHtml(askMessageParts(request, false)),
	};
}

function buildTelegramAskMessage(requestId: string, request: AskNotificationRequest): string {
	void requestId;
	return renderTelegramAskMessage(request).rich;
}

function buildTelegramAnsweredMessage(record: SharedTelegramAskRecord, response: AskResponse): string {
	return buildBoundedTelegramHtml([
		{ html: "✅ <b>Answered:</b>\n" }, { text: record.request.question },
		{ html: "\n\n<b>Response</b> " }, { text: formatResponseSummary(response) },
	]);
}

function buildTelegramCancelledAskMessage(record: SharedTelegramAskRecord): string {
	return buildBoundedTelegramHtml([{ html: "⚪ <b>Cancelled</b>\n" }, { text: record.request.question }]);
}

function normalizeTelegramToken(value: string): string {
	return value
		.trim()
		.replace(/^[\s"'`]+|[\s"'`.,:;)]+$/g, "")
		.toLowerCase();
}

function resolveTelegramOptionToken(
	token: string,
	options: QuestionOption[],
): string | null {
	const normalized = normalizeTelegramToken(token);
	if (!normalized) return null;

	const labelIndex = options.findIndex(
		(_, index) => telegramOptionLabel(index).toLowerCase() === normalized,
	);
	if (labelIndex >= 0) return options[labelIndex]?.title ?? null;

	if (/^\d+$/.test(normalized)) {
		const numericIndex = Number.parseInt(normalized, 10) - 1;
		if (numericIndex >= 0 && numericIndex < options.length)
			return options[numericIndex]?.title ?? null;
	}

	const titleMatch = options.find(
		(option) => option.title.trim().toLowerCase() === normalized,
	);
	return titleMatch?.title ?? null;
}

function parseTelegramSelectionTokens(
	text: string,
	options: QuestionOption[],
): string[] {
	const primaryTokens = text
		.split(/[,;\n]+/)
		.map((token) => token.trim())
		.filter(Boolean);
	const tokens =
		primaryTokens.length === 1 &&
		/^[a-z](\s+[a-z])+$/.test(primaryTokens[0]!.toLowerCase())
			? primaryTokens[0]!.split(/\s+/)
			: primaryTokens;
	const selections: string[] = [];
	const seenSelections = new Set<string>();

	for (const token of tokens) {
		const selection = resolveTelegramOptionToken(token, options);
		if (!selection || seenSelections.has(selection)) continue;
		seenSelections.add(selection);
		selections.push(selection);
	}

	return selections;
}

function splitTelegramSelectionComment(
	text: string,
	request: AskNotificationRequest,
): { answerText: string; comment?: string } {
	if (!request.allowComment || request.options.length === 0) {
		return { answerText: text };
	}

	const separators = [/\s+[—–-]\s+/, /\s*\|\s*/, /:\s+/];
	for (const separator of separators) {
		const match = separator.exec(text);
		if (!match || match.index <= 0) continue;

		const answerText = text.slice(0, match.index).trim();
		const comment = text.slice(match.index + match[0].length).trim();
		if (!answerText || !comment) continue;
		if (
			parseTelegramSelectionTokens(answerText, request.options).length === 0
		) {
			continue;
		}
		return { answerText, comment };
	}

	return { answerText: text };
}

function parseTelegramTextResponse(
	text: string,
	request: AskNotificationRequest,
): AskResponse | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (request.options.length === 0) return createFreeformResponse(trimmed);

	const { answerText, comment } = splitTelegramSelectionComment(
		trimmed,
		request,
	);
	const selections = parseTelegramSelectionTokens(answerText, request.options);

	if (selections.length > 0) {
		return createSelectionResponse(
			request.allowMultiple ? selections : [selections[0]!],
			comment,
		);
	}

	if (request.allowFreeform) return createFreeformResponse(trimmed);
	return null;
}

function createSelectionResponseFromOptionIndex(
	optionIndex: number,
	request: AskNotificationRequest,
): AskResponse | null {
	const option = request.options[optionIndex];
	if (!option) return null;
	return createSelectionResponse([option.title]);
}

function telegramChatMatches(
	chat: { id?: string | number } | undefined,
	config: TelegramConfig,
): boolean {
	return chat?.id !== undefined && String(chat.id) === config.chatId;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(resolve, ms);
		if (!signal) return;

		const onAbort = () => {
			clearTimeout(timeout);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === code
	);
}

async function ensureTelegramStoreDirs(
	store: TelegramSharedStore,
): Promise<void> {
	await mkdir(store.pendingDir, { recursive: true, mode: 0o700 });
}

// This is deliberately written before any update side effect. Telegram can replay
// updates after an offset write failure; at-most-once loss is safer than duplicate Pi input.
async function claimTelegramUpdate(store: TelegramSharedStore, updateId: number): Promise<boolean> {
	await mkdir(store.updatesDir, { recursive: true, mode: 0o700 });
	const path = join(store.updatesDir, `${updateId}.claimed`);
	try {
		await writeFile(path, `${Date.now()}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (isErrno(error, "EEXIST")) return false;
		throw error;
	}
	// Bounded retention, beyond Telegram's replay horizon. Best effort only.
	const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
	try {
		for (const entry of await readdir(store.updatesDir)) {
			const candidate = join(store.updatesDir, entry);
			if ((await stat(candidate)).mtimeMs < cutoff) await rm(candidate, { force: true });
		}
	} catch { /* claim remains durable if cleanup races or fails */ }
	return true;
}

function sharedAskPath(store: TelegramSharedStore, id: string): string {
	return join(store.pendingDir, `${id}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return null;
		throw error;
	}
}

async function writeJsonFileAtomic(
	filePath: string,
	value: unknown,
): Promise<void> {
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(tmpPath, filePath);
}

async function writeSharedAsk(
	store: TelegramSharedStore,
	record: SharedTelegramAskRecord,
): Promise<void> {
	await ensureTelegramStoreDirs(store);
	await writeJsonFileAtomic(sharedAskPath(store, record.id), record);
}

async function readSharedAsk(
	store: TelegramSharedStore,
	id: string,
): Promise<SharedTelegramAskRecord | null> {
	await ensureTelegramStoreDirs(store);
	return await readJsonFile<SharedTelegramAskRecord>(sharedAskPath(store, id));
}

async function updateSharedAsk(
	store: TelegramSharedStore,
	id: string,
	updater: (record: SharedTelegramAskRecord) => SharedTelegramAskRecord | null,
): Promise<SharedTelegramAskRecord | null> {
	const existing = await readSharedAsk(store, id);
	if (!existing) return null;

	const updated = updater(existing);
	if (!updated) return null;

	updated.updatedAt = Date.now();
	await writeSharedAsk(store, updated);
	return updated;
}

async function removeSharedAsk(
	store: TelegramSharedStore,
	id: string,
): Promise<void> {
	await rm(sharedAskPath(store, id), { force: true });
}

async function listSharedAsks(
	store: TelegramSharedStore,
): Promise<SharedTelegramAskRecord[]> {
	await ensureTelegramStoreDirs(store);
	let entries: string[];
	try {
		entries = await readdir(store.pendingDir);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}

	const records: SharedTelegramAskRecord[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const record = await readJsonFile<SharedTelegramAskRecord>(
			join(store.pendingDir, entry),
		);
		if (record) records.push(record);
	}
	return records;
}

async function cleanupExpiredSharedAsks(
	store: TelegramSharedStore,
): Promise<void> {
	const now = Date.now();
	const records = await listSharedAsks(store);
	await Promise.all(
		records.map(async (record) => {
			const expiredByTimeout = record.expiresAt !== undefined && record.expiresAt <= now;
			const expiredByAge = now - record.createdAt > TELEGRAM_RECORD_MAX_AGE_MS;
			if (expiredByTimeout || expiredByAge || record.status === "cancelled") await removeSharedAsk(store, record.id);
			return undefined;
		}),
	);
}

async function sharedStoreHasPendingAsks(
	store: TelegramSharedStore,
): Promise<boolean> {
	await cleanupExpiredSharedAsks(store);
	const records = await listSharedAsks(store);
	return records.some((record) => record.status === "pending");
}

async function readSharedOffset(
	store: TelegramSharedStore,
): Promise<number | undefined> {
	const payload = await readJsonFile<{ offset?: number }>(store.offsetFile);
	return typeof payload?.offset === "number" ? payload.offset : undefined;
}

async function writeSharedOffset(
	store: TelegramSharedStore,
	offset: number | undefined,
): Promise<void> {
	if (offset === undefined) return;
	await ensureTelegramStoreDirs(store);
	await writeJsonFileAtomic(store.offsetFile, {
		offset,
		updatedAt: Date.now(),
	});
}

interface TelegramLeaseOwner { token: string; pid: number; heartbeatAt: number }

function telegramLeaseToken(): string {
	return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function telegramLeasePath(lockDir: string, token: string): string {
	return `${lockDir}.lease.${token}`;
}

function telegramLeaseTombstone(lockDir: string, token: string): string {
	return `${lockDir}.tombstone.${token}`;
}

/** Test-only synchronization seam for deterministic lease race tests. */
let telegramLeaseTestBarrier: ((phase: "reserved" | "tombstoneExists" | "beforeRename" | "beforePublish" | "published") => Promise<void> | void) | undefined;
/** Test-only seam between poll lease acquisition and loop publication. */
let telegramPollingTestBarrier: (() => Promise<void> | void) | undefined;
/** Test-only seam after a session registration is atomically written. */
let telegramRegistrationTestBarrier: (() => Promise<void> | void) | undefined;

/**
 * A tombstone directory is a permanent, token-specific compare-and-swap fence.
 * Its payload may be collected, but the directory itself must remain: deleting
 * it would let a delayed old owner reserve it again and move a newer pointer.
 */
async function retireTelegramLease(lockDir: string, owner: TelegramLeaseOwner, staleMs?: number): Promise<boolean> {
	if (staleMs !== undefined && Date.now() - owner.heartbeatAt < staleMs) return false;
	const tombstone = telegramLeaseTombstone(lockDir, owner.token);
	try { await mkdir(tombstone, { mode: 0o700 }); } catch (error) {
		if (isErrno(error, "EEXIST")) {
			await telegramLeaseTestBarrier?.("tombstoneExists");
			return false;
		}
		throw error;
	}
	let renamed = false;
	try {
		await telegramLeaseTestBarrier?.("reserved");
		const current = await readJsonFile<TelegramLeaseOwner>(join(lockDir, "owner.json"));
		if (current?.token !== owner.token || (staleMs !== undefined && Date.now() - current.heartbeatAt < staleMs)) return false;
		await telegramLeaseTestBarrier?.("beforeRename");
		// We exclusively own this token's destination.  No other compliant actor
		// can remove this pointer before us, so rename cannot target a replacement.
		await rename(lockDir, join(tombstone, "pointer"));
		renamed = true;
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	} finally {
		// A token-specific directory was created by this attempt.  It is a permanent
		// fence only once its pointer rename commits; otherwise it must not block a
		// later stale incarnation of the same lease.
		if (!renamed) await rm(tombstone, { recursive: true, force: true });
	}
}

async function cleanupTelegramLeaseTombstones(lockDir: string, ttlMs = TELEGRAM_LOCK_TOMBSTONE_TTL_MS): Promise<void> {
	const parent = dirname(lockDir);
	const prefix = `${basename(lockDir)}.tombstone.`;
	let entries: string[];
	try { entries = await readdir(parent); } catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
	await Promise.all(entries.filter((entry) => entry.startsWith(prefix)).map(async (entry) => {
		const tombstone = join(parent, entry);
		try {
			if (Date.now() - (await stat(tombstone)).mtimeMs >= ttlMs) {
				const token = entry.slice(prefix.length);
				await rm(join(tombstone, "pointer"), { force: true });
				await rm(telegramLeasePath(lockDir, token), { recursive: true, force: true });
			}
		} catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
		return undefined;
	}));
}

async function reclaimTelegramLease(lockDir: string, owner: TelegramLeaseOwner, staleMs: number): Promise<boolean> {
	return await retireTelegramLease(lockDir, owner, staleMs);
}

async function tryAcquireTelegramLease(lockDir: string, staleMs: number): Promise<TelegramPollLock | null> {
	await cleanupTelegramLeaseTombstones(lockDir);
	const token = telegramLeaseToken();
	const leaseDir = telegramLeasePath(lockDir, token);
	const leaseOwnerFile = join(leaseDir, "owner.json");
	await mkdir(leaseDir, { mode: 0o700 });
	await writeJsonFileAtomic(leaseOwnerFile, { token, pid: process.pid, heartbeatAt: Date.now() });
	try {
		await telegramLeaseTestBarrier?.("beforePublish");
		// A symlink is the sole mutable ownership pointer.  It is published only
		// after its target has a complete owner record, so readers never see an
		// initialized-but-ownerless stale window.
		await symlink(leaseDir, lockDir, process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		await rm(leaseDir, { recursive: true, force: true });
		if (!isErrno(error, "EEXIST")) throw error;
		const owner = await readJsonFile<TelegramLeaseOwner>(join(lockDir, "owner.json"));
		if (owner) await reclaimTelegramLease(lockDir, owner, staleMs);
		return null;
	}
	await telegramLeaseTestBarrier?.("published");
	let released = false;
	return {
		refresh: async () => {
			if (released) return;
			// Never write through lockDir: a reclaimed owner can only touch its
			// immutable per-token lease object, not a replacement owner's record.
			await writeJsonFileAtomic(leaseOwnerFile, { token, pid: process.pid, heartbeatAt: Date.now() });
		},
		release: async () => {
			if (released) return;
			released = true;
			await retireTelegramLease(lockDir, { token, pid: process.pid, heartbeatAt: Date.now() });
		},
	};
}

async function tryAcquireTelegramPollLock(store: TelegramSharedStore): Promise<TelegramPollLock | null> {
	await ensureTelegramStoreDirs(store);
	return await tryAcquireTelegramLease(store.lockDir, TELEGRAM_LOCK_STALE_MS);
}

interface TelegramTopicBinding { threadId: number; title: string; createdAt: number }
interface TelegramTopicMap { version?: number; topics: Record<string, number | TelegramTopicBinding>; threads?: Record<string, string> }
interface TelegramSessionRegistration { sessionId: string; instanceId: string; pid: number; heartbeatAt: number; title: string; threadId?: number }
interface TelegramInboxEnvelope { updateId: number; text: string; messageId: number; threadId: number; createdAt: number }

function topicBinding(map: TelegramTopicMap, sessionId: string): TelegramTopicBinding | undefined {
	const value = map.topics[sessionId];
	return typeof value === "number" ? undefined : value;
}
function registrationPath(store: TelegramSharedStore, sessionId: string): string { return join(store.registrationsDir, `${createHash("sha256").update(sessionId).digest("hex")}.json`); }
function inboxPath(store: TelegramSharedStore, sessionId: string, updateId: number): string { return join(store.inboxDir, createHash("sha256").update(sessionId).digest("hex"), `${updateId}.json`); }
async function listLiveRegistrations(store: TelegramSharedStore): Promise<TelegramSessionRegistration[]> {
	await mkdir(store.registrationsDir, { recursive: true, mode: 0o700 });
	const entries = await readdir(store.registrationsDir);
	const now = Date.now();
	const result: TelegramSessionRegistration[] = [];
	for (const entry of entries) {
		const registration = await readJsonFile<TelegramSessionRegistration>(join(store.registrationsDir, entry));
		if (!registration) continue;
		if (now - registration.heartbeatAt > TELEGRAM_LOCK_STALE_MS) { await rm(join(store.registrationsDir, entry), { force: true }); continue; }
		result.push(registration);
	}
	return result;
}
async function enqueueTelegramInbox(store: TelegramSharedStore, sessionId: string, envelope: TelegramInboxEnvelope): Promise<boolean> {
	const path = inboxPath(store, sessionId, envelope.updateId);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	try { await writeFile(path, `${JSON.stringify(envelope)}\n`, { flag: "wx", mode: 0o600 }); return true; }
	catch (error) { if (isErrno(error, "EEXIST")) return false; throw error; }
}

/** Best-effort cleanup: only durable completions are eligible. */
async function cleanupTelegramInboxDone(store: TelegramSharedStore): Promise<void> {
	const cutoff = Date.now() - TELEGRAM_INBOX_DONE_RETENTION_MS;
	let sessions: string[];
	try { sessions = await readdir(store.inboxDir); }
	catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
	for (const session of sessions) {
		const dir = join(store.inboxDir, session);
		try {
			for (const entry of await readdir(dir)) {
				if (!entry.endsWith(".done")) continue;
				const path = join(dir, entry);
				if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
			}
			if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true });
		} catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
	}
}

async function withTelegramTopicLock<T>(store: TelegramSharedStore, operation: () => Promise<T>): Promise<T> {
	await ensureTelegramStoreDirs(store);
	const deadline = Date.now() + 5_000;
	while (true) {
		const lock = await tryAcquireTelegramLease(store.topicLockDir, 10_000);
		if (lock) {
			const heartbeat = setInterval(() => { void lock.refresh(); }, 2_000);
			try { return await operation(); } finally { clearInterval(heartbeat); await lock.release(); }
		}
		if (Date.now() >= deadline) throw new Error("Timed out locking Telegram topic state");
		await delay(25);
	}
}

class TelegramApiError extends Error {
	constructor(readonly status: number, readonly description: string) { super(description); }
}

function isRichMessageUnsupported(error: unknown): boolean {
	return error instanceof TelegramApiError && (
		/(?:rich_message|sendRichMessage|formatted rich)/i.test(error.description) && /(?:unsupported|not supported|invalid|unknown)/i.test(error.description)
		|| /(?:can't parse|parse) entities/i.test(error.description)
	);
}

function isInvalidTopic(error: unknown): boolean {
	return error instanceof TelegramApiError && /(?:message[ _-]?thread|topic|thread)\s+(?:was\s+)?(?:not found|invalid|deleted|closed)|(?:not found|invalid|deleted|closed)\s+(?:message[ _-]?thread|topic|thread)/i.test(error.description);
}

async function invalidateTelegramTopicMap(topicFile: string, key: string, rejectedThreadId: number): Promise<void> {
	const map = await readJsonFile<TelegramTopicMap>(topicFile);
	// Do not erase a replacement created by another process.
	if (!map || map.topics[key] !== rejectedThreadId) return;
	delete map.topics[key];
	await writeJsonFileAtomic(topicFile, map);
}

class TelegramBotPoller {
	private readonly config: TelegramConfig;
	private readonly store: TelegramSharedStore;
	private topicId: number | null | undefined;
	private routing: { sessionId: string; sessionName?: string; getSessionName?: () => string | undefined; cwd: string } | undefined;
	private localSession: { sessionId: string; instanceId: string; deliver: (text: string) => Promise<"idle" | "steer"> } | undefined;
	private registrationTimer: ReturnType<typeof setInterval> | undefined;
	private abortController: AbortController | undefined;
	private loopPromise: Promise<void> | undefined;
	private ensurePromise: Promise<void> | undefined;
	private registrationPromise: Promise<void> = Promise.resolve();
	// Every asynchronous registration/acquisition carries this fence.  A stale
	// callback may finish I/O, but can never publish ownership or a poll loop.
	private activeGeneration = 0;

	constructor(config: TelegramConfig) {
		this.config = config;
		this.store = createTelegramSharedStore(config);
	}

	setRouting(routing: { sessionId: string; sessionName?: string; getSessionName?: () => string | undefined; cwd: string }): void { this.routing = routing; }

	async activateSession(routing: { sessionId: string; sessionName?: string; getSessionName?: () => string | undefined; cwd: string }, deliver: (text: string) => Promise<"idle" | "steer">): Promise<void> {
		// A second session_start first retires the old local generation and timer.
		await this.deactivateSession();
		this.setRouting(routing);
		const generation = ++this.activeGeneration;
		const instanceId = telegramLeaseToken();
		const register = () => this.registrationPromise = this.registrationPromise.then(async () => {
			if (generation !== this.activeGeneration) return;
			await withTelegramTopicLock(this.store, async () => {
				if (generation !== this.activeGeneration) return;
				const path = registrationPath(this.store, routing.sessionId);
				const existing = await readJsonFile<TelegramSessionRegistration>(path);
				if (generation !== this.activeGeneration) return;
				if (existing && Date.now() - existing.heartbeatAt <= TELEGRAM_LOCK_STALE_MS && existing.instanceId !== instanceId) return;
				const map = await readJsonFile<TelegramTopicMap>(this.store.topicFile);
				const binding = map && topicBinding(map, routing.sessionId);
				await mkdir(this.store.registrationsDir, { recursive: true, mode: 0o700 });
				if (generation !== this.activeGeneration) return;
				await writeJsonFileAtomic(path, { sessionId: routing.sessionId, instanceId, pid: process.pid, heartbeatAt: Date.now(), title: routing.sessionName || routing.sessionId.slice(0, 8), ...(binding ? { threadId: binding.threadId } : {}) });
				await telegramRegistrationTestBarrier?.();
				if (generation !== this.activeGeneration) {
					const current = await readJsonFile<TelegramSessionRegistration>(path);
					if (current?.instanceId === instanceId) await rm(path, { force: true });
					return;
				}
				this.localSession = { sessionId: routing.sessionId, instanceId, deliver };
			});
		});
		await register();
		if (generation !== this.activeGeneration || !this.localSession) return;
		this.registrationTimer = setInterval(() => {
			if (generation !== this.activeGeneration) return;
			void register().then(() => generation === this.activeGeneration ? this.consumeInbox(generation) : undefined).then(() => generation === this.activeGeneration ? this.ensurePolling(generation) : undefined);
		}, telegramRegistrationIntervalMs());
		await this.consumeInbox(generation);
		void this.ensurePolling(generation);
		void cleanupTelegramInboxDone(this.store).catch(() => undefined);
	}

	async deactivateSession(): Promise<void> {
		const local = this.localSession;
		// Invalidate before waiting: callbacks/acquisition completing below cannot publish.
		++this.activeGeneration;
		if (this.registrationTimer) clearInterval(this.registrationTimer);
		this.registrationTimer = undefined;
		this.localSession = undefined;
		await this.registrationPromise;
		await this.ensurePromise;
		this.abortController?.abort();
		await this.loopPromise;
		if (!local) return;
		await withTelegramTopicLock(this.store, async () => {
			const path = registrationPath(this.store, local.sessionId);
			const current = await readJsonFile<TelegramSessionRegistration>(path);
			if (current?.instanceId === local.instanceId) await rm(path, { force: true });
		});
		void cleanupTelegramInboxDone(this.store).catch(() => undefined);
	}

	private async consumeInbox(generation = this.activeGeneration): Promise<void> {
		const local = this.localSession; if (!local || generation !== this.activeGeneration) return;
		const dir = dirname(inboxPath(this.store, local.sessionId, 0));
		let entries: string[]; try { entries = await readdir(dir); } catch (error) { if (isErrno(error, "ENOENT")) return; throw error; }
		for (const entry of entries.filter((name) => name.endsWith(".json") || /\.json\.claimed(?:\.|$)/.test(name))) {
			if (generation !== this.activeGeneration || this.localSession?.instanceId !== local.instanceId) return;
			const path = join(dir, entry);
			const source = entry.endsWith(".json") ? path : path;
			const claimed = `${path.replace(/\.claimed(?:\.[^.]+)?$/, "")}.claimed.${local.instanceId}`;
			const done = `${path.replace(/\.claimed(?:\.[^.]+)?$/, "")}.done`;
			try { if (source !== claimed) await rename(source, claimed); } catch (error) { if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) continue; throw error; }
			const envelope = await readJsonFile<TelegramInboxEnvelope>(claimed); if (!envelope) { await rm(claimed, { force: true }); continue; }
			await withTelegramTopicLock(this.store, async () => {
				const current = await readJsonFile<TelegramSessionRegistration>(registrationPath(this.store, local.sessionId));
				if (generation !== this.activeGeneration || this.localSession?.instanceId !== local.instanceId || !current || current.instanceId !== local.instanceId || Date.now() - current.heartbeatAt > TELEGRAM_LOCK_STALE_MS) return;
				let status: "idle" | "steer";
				try { status = await local.deliver(envelope.text); }
				catch {
					await this.safeCallApi("sendMessage", { chat_id: this.config.chatId, message_thread_id: envelope.threadId, reply_to_message_id: envelope.messageId, text: "Unable to deliver this message to Pi." });
					return;
				}
				// Durable completion is the loss boundary; acknowledgement failures must not replay Pi input.
				await rename(claimed, done);
				await this.safeCallApi("setMessageReaction", { chat_id: this.config.chatId, message_id: envelope.messageId, reaction: [{ type: "emoji", emoji: status === "idle" ? "✅" : "⏳" }] }).catch(() => undefined);
			});
		}
	}

	async createPendingAsk(record: SharedTelegramAskRecord): Promise<void> {
		await writeSharedAsk(this.store, record);
	}

	async readPendingAsk(id: string): Promise<SharedTelegramAskRecord | null> {
		return await readSharedAsk(this.store, id);
	}

	async updateMessageId(id: string, messageId: number, messageThreadId?: number): Promise<void> {
		await updateSharedAsk(this.store, id, (record) => ({ ...record, messageId, messageThreadId }));
	}

	async removePendingAsk(id: string): Promise<void> {
		await removeSharedAsk(this.store, id);
	}

	async answerPendingAsk(id: string, response: AskResponse): Promise<void> {
		const record = await readSharedAsk(this.store, id);
		if (!record || record.status !== "pending") return;
		await this.answerSharedAsk(record, response);
	}

	async cancelPendingAsk(id: string): Promise<void> {
		const updated = await updateSharedAsk(this.store, id, (current) => {
			if (current.status !== "pending") return null;
			return {
				...current,
				status: "cancelled",
			};
		});

		if (updated?.messageId !== undefined) await this.editNotificationMessage(updated.messageId, buildTelegramCancelledAskMessage(updated), { inline_keyboard: [] }, updated.messageThreadId);
	}

	async sendMessage(pending: TelegramPendingAsk): Promise<TelegramMessage> {
		return await this.sendNotificationMessage(buildTelegramAskMessage(pending.id, pending.request), buildTelegramInlineKeyboard(pending.id, pending.request));
	}

	private async getMessageThreadId(): Promise<number | undefined> {
		if (this.topicId !== undefined) return this.topicId ?? undefined;
		this.topicId = null;
		try {
			const me = await this.callApi<{ has_topics_enabled?: boolean }>("getMe", {});
			if (!me.has_topics_enabled) return undefined;
			const routing = this.routing;
			if (!routing) return undefined;
			const name = await resolveTelegramTopicName(routing.sessionId, routing.getSessionName?.() ?? routing.sessionName, routing.cwd);
			if (!name) return undefined;
			this.topicId = await withTelegramTopicLock(this.store, async () => {
				const map = (await readJsonFile<TelegramTopicMap>(this.store.topicFile)) ?? { version: 2, topics: {}, threads: {} };
				const existing = topicBinding(map, routing.sessionId);
				if (existing) return existing.threadId;
				const topic = await this.callApi<{ message_thread_id: number }>("createForumTopic", { chat_id: this.config.chatId, name });
				map.version = 2; map.topics[routing.sessionId] = { threadId: topic.message_thread_id, title: name, createdAt: Date.now() };
				map.threads ??= {}; map.threads[String(topic.message_thread_id)] = routing.sessionId;
				await writeJsonFileAtomic(this.store.topicFile, map);
				if (this.localSession?.sessionId === routing.sessionId) {
					const path = registrationPath(this.store, routing.sessionId);
					const registration = await readJsonFile<TelegramSessionRegistration>(path);
					if (registration?.instanceId === this.localSession.instanceId) await writeJsonFileAtomic(path, { ...registration, threadId: topic.message_thread_id, heartbeatAt: Date.now() });
				}
				return topic.message_thread_id;
			});
		} catch { this.topicId = null; }
		return this.topicId ?? undefined;
	}

	private async invalidateTopic(rejectedThreadId: number): Promise<void> {
		this.topicId = undefined;
		const routing = this.routing;
		if (!routing) return;
		await withTelegramTopicLock(this.store, async () => {
			const map = await readJsonFile<TelegramTopicMap>(this.store.topicFile);
			if (!map || topicBinding(map, routing.sessionId)?.threadId !== rejectedThreadId) return;
			delete map.topics[routing.sessionId]; delete map.threads?.[String(rejectedThreadId)];
			await writeJsonFileAtomic(this.store.topicFile, map);
		});
	}

	async sendNotificationMessage(text: string, replyMarkup?: Record<string, unknown>): Promise<TelegramMessage> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);
		const regularText = text.replace(/<details><summary>Details<\/summary>([\s\S]*?)<\/details>/g, "<b>Details</b>\n$1");
		const send = async (threadId?: number): Promise<TelegramMessage> => {
			const routing = { chat_id: this.config.chatId, disable_web_page_preview: true, ...(threadId !== undefined ? { message_thread_id: threadId } : {}), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
			try {
				const message = await this.callApi<TelegramMessage>("sendRichMessage", { ...routing, rich_message: { type: "html", html: text } }, controller.signal);
				if (typeof message?.message_id !== "number") throw new Error("sendRichMessage returned no message id");
				return message;
			} catch (error) {
				if (!isRichMessageUnsupported(error)) throw error;
				return await this.callApi<TelegramMessage>("sendMessage", { ...routing, text: regularText, parse_mode: "HTML" }, controller.signal);
			}
		};
		try {
			const threadId = await this.getMessageThreadId();
			try { return await send(threadId); }
			catch (error) {
				if (threadId === undefined || !isInvalidTopic(error)) throw error;
				await this.invalidateTopic(threadId);
				return await send(await this.getMessageThreadId());
			}
		} finally { clearTimeout(timeout); }
	}

	async editNotificationMessage(messageId: number, text: string, replyMarkup?: Record<string, unknown>, messageThreadId?: number): Promise<void> {
		const routing = { chat_id: this.config.chatId, message_id: messageId, ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) };
		try { await this.callApi("editMessageText", { ...routing, rich_message: { type: "html", html: text } }); }
		catch (error) {
			if (!isRichMessageUnsupported(error)) throw error;
			const regularText = text.replace(/<details><summary>Details<\/summary>([\s\S]*?)<\/details>/g, "<b>Details</b>\n$1");
			await this.callApi("editMessageText", { ...routing, text: regularText, parse_mode: "HTML" });
		}
	}

	async ensurePolling(generation = this.activeGeneration): Promise<void> {
		if (generation !== this.activeGeneration) return;
		if (this.loopPromise && !this.abortController?.signal.aborted) return;
		if (this.ensurePromise) return this.ensurePromise;

		this.ensurePromise = (async () => {
			const lock = await tryAcquireTelegramPollLock(this.store);
			await telegramPollingTestBarrier?.();
			// Lease acquisition is asynchronous: release instead of publishing if
			// shutdown/re-activation crossed it.
			if (!lock) return;
			if (generation !== this.activeGeneration) {
				await lock.release();
				return;
			}
			const controller = new AbortController();
			const loopPromise = this.pollLoop(controller.signal, lock).finally(() => {
				if (this.loopPromise !== loopPromise) return;
				this.loopPromise = undefined;
				this.abortController = undefined;
			});
			if (generation !== this.activeGeneration) {
				controller.abort();
				await loopPromise;
				return;
			}
			this.abortController = controller;
			this.loopPromise = loopPromise;
		})().finally(() => {
			this.ensurePromise = undefined;
		});

		return this.ensurePromise;
	}

	private async pollLoop(
		signal: AbortSignal,
		lock: TelegramPollLock,
	): Promise<void> {
		let offset = await readSharedOffset(this.store);

		try {
			while (!signal.aborted) {
				await lock.refresh();

						if (!(await sharedStoreHasPendingAsks(this.store)) && (await listLiveRegistrations(this.store)).length === 0) {
					return;
				}

				try {
					const updates = await this.callApi<TelegramUpdate[]>(
						"getUpdates",
						{
							timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
							offset,
							allowed_updates: ["callback_query", "message"],
						},
						signal,
					);
					const updateList = Array.isArray(updates) ? updates : [];
					for (const update of updateList) {
						offset = Math.max(offset ?? 0, update.update_id + 1);
						await this.handleUpdate(update);
						await writeSharedOffset(this.store, offset);
					}
				} catch (error) {
					if (signal.aborted) return;
					await delay(TELEGRAM_RETRY_DELAY_MS, signal);
				}
			}
		} finally {
			await lock.release();
		}
	}

	private async handleUpdate(update: TelegramUpdate): Promise<void> {
		if (!(await claimTelegramUpdate(this.store, update.update_id))) return;
		if (update.callback_query) {
			await this.handleCallbackQuery(update.callback_query);
		}
		if (update.message) {
			await this.handleMessage(update.update_id, update.message);
		}
	}

	private async handleCallbackQuery(
		callbackQuery: NonNullable<TelegramUpdate["callback_query"]>,
	): Promise<void> {
		const parsed = callbackQuery.data
			? parseTelegramCallbackData(callbackQuery.data)
			: null;
		if (!parsed) return;

		const record = await readSharedAsk(this.store, parsed.requestId);
		if (
			!record ||
			record.status !== "pending" ||
			!telegramChatMatches(callbackQuery.message?.chat, this.config) ||
			(record.messageThreadId !== undefined && callbackQuery.message?.message_thread_id !== record.messageThreadId)
		) {
			await this.safeCallApi("answerCallbackQuery", {
				callback_query_id: callbackQuery.id,
				text: "This ask_user request is no longer active.",
				show_alert: false,
			});
			return;
		}

		if (parsed.type === "custom") {
			if (!record.request.allowFreeform) {
				await this.safeCallApi("answerCallbackQuery", {
					callback_query_id: callbackQuery.id,
					text: "Custom answers are not enabled for this ask_user request.",
					show_alert: false,
				});
				return;
			}

			await this.safeCallApi("answerCallbackQuery", {
				callback_query_id: callbackQuery.id,
				text: "Reply to the ask_user message with your custom answer.",
				show_alert: false,
			});
			await this.safeCallApi("sendMessage", { chat_id: this.config.chatId, reply_to_message_id: callbackQuery.message?.message_id, ...(record.messageThreadId !== undefined ? { message_thread_id: record.messageThreadId } : {}), text: "Reply to the ask_user message with your custom answer." });
			return;
		}

		const response = createSelectionResponseFromOptionIndex(
			parsed.optionIndex,
			record.request,
		);
		if (!response) {
			await this.safeCallApi("answerCallbackQuery", {
				callback_query_id: callbackQuery.id,
				text: "That option is not available for this ask_user request.",
				show_alert: false,
			});
			return;
		}

		await this.answerSharedAsk(record, response);
		await this.safeCallApi("answerCallbackQuery", {
			callback_query_id: callbackQuery.id,
			text: `Answered: ${formatResponseSummary(response)}`,
			show_alert: false,
		});
	}

	private async handleMessage(
		updateId: number,
		message: NonNullable<TelegramUpdate["message"]>,
	): Promise<void> {
		if (!telegramChatMatches(message.chat, this.config) || message.from?.is_bot) return;
		const replyToMessageId = message.reply_to_message?.message_id;
		const records = await listSharedAsks(this.store);
		const record = replyToMessageId === undefined ? undefined : records.find(
			(candidate) => candidate.status === "pending" && candidate.messageId === replyToMessageId &&
				(candidate.messageThreadId === undefined || candidate.messageThreadId === message.message_thread_id),
		);
		// A pending ask owns its reply semantics; only non-ask replies fall through.
		if (record) {
			if (!message.text) return;
			const response = parseTelegramTextResponse(message.text, record.request);
			if (!response) {
				await this.safeCallApi("sendMessage", { chat_id: this.config.chatId, reply_to_message_id: message.message_id, ...(record.messageThreadId !== undefined ? { message_thread_id: record.messageThreadId } : {}), text: "I could not match that reply to an available ask_user answer. Try an option button, letter, or title." });
				return;
			}
			await this.answerSharedAsk(record, response);
			return;
		}
		if (typeof message.text !== "string" || message.message_thread_id === undefined) return;
		const map = await readJsonFile<TelegramTopicMap>(this.store.topicFile);
		const sessionId = map?.threads?.[String(message.message_thread_id)];
		if (!sessionId) return;
		const registration = (await listLiveRegistrations(this.store)).find((item) => item.sessionId === sessionId && item.threadId === message.message_thread_id);
		if (!registration) {
			await this.safeCallApi("sendMessage", { chat_id: this.config.chatId, message_thread_id: message.message_thread_id, reply_to_message_id: message.message_id, text: "⚪ This Pi session is no longer active." });
			return;
		}
		await this.safeCallApi("setMessageReaction", { chat_id: this.config.chatId, message_id: message.message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
		await enqueueTelegramInbox(this.store, registration.sessionId, { updateId, text: message.text, messageId: message.message_id, threadId: message.message_thread_id, createdAt: Date.now() });
	}

	private async answerSharedAsk(
		record: SharedTelegramAskRecord,
		response: AskResponse,
	): Promise<void> {
		const updated = await updateSharedAsk(this.store, record.id, (current) => {
			if (current.status !== "pending") return null;
			return {
				...current,
				status: "answered",
				response,
			};
		});

		if (updated?.messageId !== undefined) await this.editNotificationMessage(updated.messageId, buildTelegramAnsweredMessage(updated, response), { inline_keyboard: [] }, updated.messageThreadId);
	}

	private async safeCallApi(
		method: string,
		body: Record<string, unknown>,
	): Promise<void> {
		try {
			await this.callApi<unknown>(method, body);
		} catch {
			// Best-effort acknowledgement only.
		}
	}

	private async callApi<T>(
		method: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		if (typeof fetch !== "function") {
			throw new Error("fetch is not available in this runtime");
		}

		const response = await fetch(
			`${this.config.apiBaseUrl}/bot${this.config.botToken}/${method}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
			},
		);
		const text = await response.text();
		let payload: { ok?: boolean; result?: T; description?: string } = {};
		if (text) {
			try { payload = JSON.parse(text) as typeof payload; }
			catch { throw new Error(`Telegram ${method} returned invalid JSON`); }
		}
		if (!response.ok || payload.ok !== true) {
			throw new TelegramApiError(
				response.status,
				payload.description || `Telegram ${method} failed with HTTP ${response.status}`,
			);
		}
		return payload.result as T;
	}
}

class TelegramPendingAsk implements TelegramAskHandle {
	readonly id = createTelegramRequestId();
	readonly request: AskNotificationRequest;
	readonly response: Promise<AskUIResult | null>;
	messageId: number | undefined;

	private readonly poller: TelegramBotPoller;
	private readonly createdAt = Date.now();
	private resolveResponse!: (response: AskUIResult | null) => void;
	private deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	private waitTimer: ReturnType<typeof setInterval> | undefined;
	private settled = false;
	private settledResponse: AskUIResult | null | undefined;

	constructor(poller: TelegramBotPoller, request: AskNotificationRequest) {
		this.poller = poller;
		this.request = request;
		this.response = new Promise((resolve) => {
			this.resolveResponse = resolve;
		});
	}

	async send(): Promise<void> {
		const expiresAt =
			this.request.timeout && this.request.timeout > 0
				? this.createdAt + this.request.timeout
				: undefined;

		await this.poller.createPendingAsk({
			id: this.id,
			request: this.request,
			createdAt: this.createdAt,
			updatedAt: this.createdAt,
			expiresAt,
			status: "pending",
		});

		const delayMs = resolveTelegramNotifyDelayMs();
		const effectiveDelayMs =
			this.request.timeout && this.request.timeout <= delayMs * 2
				? Math.min(delayMs, 5_000, Math.floor(this.request.timeout / 10))
				: delayMs;
		if (effectiveDelayMs <= 10) {
			await this.deliver();
			return;
		}

		this.deliveryTimer = setTimeout(() => {
			this.deliveryTimer = undefined;
			void this.deliver().catch(async () => {
				await this.finish(null, true);
			});
		}, effectiveDelayMs);
	}

	async answer(response: AskUIResult): Promise<void> {
		if (this.messageId !== undefined) {
			await this.poller.answerPendingAsk(this.id, response);
		}
		await this.finish(response, true);
	}

	close(): void {
		void (async () => {
			if (this.messageId !== undefined) {
				await this.poller.cancelPendingAsk(this.id);
			}
			await this.finish(null, true);
		})();
	}

	private async deliver(): Promise<void> {
		if (this.settled) return;
		const record = await this.poller.readPendingAsk(this.id);
		if (!record || record.status !== "pending") return;

		try {
			const message = await this.poller.sendMessage(this);
			this.messageId = message.message_id;

			if (this.settled) {
				await this.editDeliveredAfterLocalSettlement(message.message_id);
				return;
			}

			await this.poller.updateMessageId(this.id, message.message_id, message.message_thread_id);
			this.startWaitingForSharedResponse();
			void this.poller.ensurePolling();
		} catch (error) {
			await this.poller.removePendingAsk(this.id);
			throw error;
		}
	}

	private async editDeliveredAfterLocalSettlement(
		messageId: number,
	): Promise<void> {
		const response = this.settledResponse;
		const record: SharedTelegramAskRecord = {
			id: this.id,
			request: this.request,
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			messageId,
			status: response ? "answered" : "cancelled",
			response,
		};
		await this.poller.editNotificationMessage(
			messageId,
			response
				? buildTelegramAnsweredMessage(record, response)
				: buildTelegramCancelledAskMessage(record),
			{ inline_keyboard: [] },
		);
		await this.poller.removePendingAsk(this.id);
	}

	private startWaitingForSharedResponse(): void {
		if (this.waitTimer) return;

		const check = async () => {
			if (this.settled) return;
			void this.poller.ensurePolling();
			const record = await this.poller.readPendingAsk(this.id);
			if (!record || record.status === "cancelled") {
				await this.finish(null, false);
				return;
			}
			if (record.status === "answered" && record.response) {
				await this.finish(record.response, true);
				return;
			}
			if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
				if (record.messageId !== undefined) {
					await this.poller.cancelPendingAsk(this.id);
				}
				await this.finish(null, true);
			}
		};

		this.waitTimer = setInterval(() => {
			void check();
		}, TELEGRAM_RESPONSE_POLL_MS);
		void check();
	}

	private async finish(
		response: AskUIResult | null,
		removeRecord: boolean,
	): Promise<void> {
		if (this.settled) return;
		this.settled = true;
		this.settledResponse = response;
		if (this.deliveryTimer) {
			clearTimeout(this.deliveryTimer);
			this.deliveryTimer = undefined;
		}
		if (this.waitTimer) {
			clearInterval(this.waitTimer);
			this.waitTimer = undefined;
		}
		if (removeRecord) {
			await this.poller.removePendingAsk(this.id);
		}
		this.resolveResponse(response);
	}
}

interface TelegramSentNotificationHandle {
	messageId: number;
	edit: (text: string) => Promise<void>;
}

async function deliverTelegramFreeText(pi: ExtensionAPI, text: string, idle: boolean): Promise<"idle" | "steer"> {
	await pi.sendUserMessage(text, idle ? undefined : { deliverAs: "steer" });
	return idle ? "idle" : "steer";
}

class TelegramNotifyManager {
	private pollers = new Map<string, TelegramBotPoller>();

	async activateSession(pi: ExtensionAPI, ctx: { sessionManager: { getSessionId: () => string; getSessionName: () => string | undefined }; cwd: string; isIdle: () => boolean }): Promise<void> {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		const config = await resolveTelegramConfig(); if (!config) return;
		const sessionId = ctx.sessionManager.getSessionId(); if (!sessionId) return;
		const poller = this.getPoller(config);
		await poller.activateSession({ sessionId, sessionName: ctx.sessionManager.getSessionName(), getSessionName: () => ctx.sessionManager.getSessionName(), cwd: ctx.cwd }, async (text) => {
			return await deliverTelegramFreeText(pi, text, ctx.isIdle());
		});
	}

	async deactivateSession(): Promise<void> {
		await Promise.all([...this.pollers.values()].map((poller) => poller.deactivateSession()));
	}

	async openAsk(
		request: AskNotificationRequest,
	): Promise<TelegramAskHandle | null> {
		const config = await resolveTelegramConfig();
		if (!config) return null;

		const poller = this.getPoller(config);
		const pending = new TelegramPendingAsk(poller, request);
		await pending.send();
		return pending;
	}

	async sendNotification(
		text: string,
	): Promise<TelegramSentNotificationHandle | null> {
		const config = await resolveTelegramConfig();
		if (!config) return null;

		const poller = this.getPoller(config);
		const message = await poller.sendNotificationMessage(text);
		return {
			messageId: message.message_id,
			edit: async (nextText: string) => {
				await poller.editNotificationMessage(message.message_id, nextText);
			},
		};
	}

	private getPoller(config: TelegramConfig): TelegramBotPoller {
		const key = `${config.apiBaseUrl}\n${config.botToken}\n${config.chatId}`;
		const existing = this.pollers.get(key);
		if (existing) return existing;

		const poller = new TelegramBotPoller(config);
		this.pollers.set(key, poller);
		return poller;
	}
}

const telegramNotifyManager = new TelegramNotifyManager();

async function startTelegramAsk(
	request: AskNotificationRequest,
	ctx: unknown,
): Promise<TelegramAskHandle | null> {
	if (process.env.PI_SUBAGENT_CHILD === "1") return null;
	try {
		return await telegramNotifyManager.openAsk(request);
	} catch (error) {
		notifyTelegramWarning(ctx, error);
		return null;
	}
}

async function waitForAcceptedTelegramResponse(
	handle: TelegramAskHandle,
): Promise<AskUIResult> {
	const response = await handle.response;
	if (response) return response;
	return await new Promise<AskUIResult>(() => {
		// Null means Telegram became unavailable/cancelled; local UI should keep waiting.
	});
}

type AgentEndTelegramNoticeState = "waiting" | "sent" | "cancelled";

class AgentEndTelegramNotice {
	private state: AgentEndTelegramNoticeState = "waiting";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sentHandle: TelegramSentNotificationHandle | null = null;

	constructor(
		private readonly message: string,
		private readonly resumedMessage: string,
		private readonly ctx: unknown,
	) {}

	start(): void {
		const delayMs = resolveTelegramNotifyDelayMs();
		if (delayMs <= 0) {
			void this.send();
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.send();
		}, delayMs);
	}

	cancelAsResponded(): void {
		if (this.state === "cancelled") return;
		this.state = "cancelled";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.sentHandle) {
			void this.sentHandle.edit(this.resumedMessage);
		}
	}

	private async send(): Promise<void> {
		if (this.state !== "waiting") return;
		try {
			const handle = await telegramNotifyManager.sendNotification(this.message);
			if (!handle) return;
			this.sentHandle = handle;
			if ((this.state as AgentEndTelegramNoticeState) === "cancelled") {
				await handle.edit(this.resumedMessage);
				return;
			}
			this.state = "sent";
		} catch (error) {
			notifyTelegramWarning(this.ctx, error);
		}
	}
}

let pendingAgentEndTelegramNotice: AgentEndTelegramNotice | null = null;

function subagentRunId(data: unknown): string | undefined {
	const value = data as { id?: unknown; runId?: unknown } | undefined;
	const id = value?.id ?? value?.runId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function activeAsyncRunIdsFromStatusReply(reply: unknown): Set<string> | undefined {
	const value = reply as
		| { success?: unknown; data?: { text?: unknown } }
		| undefined;
	if (value?.success !== true || typeof value.data?.text !== "string") {
		return undefined;
	}

	const ids = new Set<string>();
	for (const line of value.data.text.split(/\r?\n/)) {
		const match = line.match(/^-\s+([^|]+?)\s+\|\s+(?:queued|running)\b/);
		if (match?.[1]) ids.add(match[1].trim());
	}
	return ids;
}

function queryActiveAsyncRunIds(pi: ExtensionAPI): Promise<Set<string> | undefined> {
	return new Promise((resolve) => {
		const requestId = `telegram-idle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		let settled = false;
		let unsubscribe: (() => void) | undefined;

		const finish = (ids?: Set<string>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			unsubscribe?.();
			resolve(ids);
		};

		unsubscribe = pi.events.on(replyEvent, (reply) => {
			finish(activeAsyncRunIdsFromStatusReply(reply));
		});
		const timeout = setTimeout(() => finish(), SUBAGENT_RPC_TIMEOUT_MS);
		timeout.unref?.();
		pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method: "status",
			params: {},
			source: { extension: "pi-telegram-notify" },
		});
	});
}

function cancelPendingAgentEndTelegramNotice(): void {
	const pending = pendingAgentEndTelegramNotice;
	pendingAgentEndTelegramNotice = null;
	pending?.cancelAsResponded();
}

function scheduleAgentEndTelegramNotice(event: unknown, ctx: unknown): void {
	cancelPendingAgentEndTelegramNotice();
	const message = buildAgentEndTelegramMessage(event, ctx);
	const resumedMessage = buildAgentEndTelegramMessage(event, ctx, true);
	const notice = new AgentEndTelegramNotice(message, resumedMessage, ctx);
	pendingAgentEndTelegramNotice = notice;
	notice.start();
}

function buildAgentEndTelegramMessage(event: unknown, ctx: unknown, resumed = false): string {
	const context = (ctx ?? {}) as { cwd?: string; model?: { name?: string; id?: string; provider?: string }; sessionManager?: { getSessionId?: () => string | undefined } };
	const project = context.cwd?.split("/").filter(Boolean).pop();
	const model = context.model?.name || context.model?.id;
	const session = safeCall(() => context.sessionManager?.getSessionId?.());
	const lastResponse = extractLastAssistantText(event);
	const details = [model ? `Model: ${context.model?.provider ? `${context.model.provider}/` : ""}${model}` : "", session ? `Session: ${session}` : "", lastResponse ? `Last response:\n${lastResponse}` : ""].filter(Boolean).join("\n\n");
	return buildBoundedTelegramHtml([
		{ html: "🔔 <b>Pi agent idle</b>\n\n" },
		...(project ? [{ html: "<b>Project</b> " } as TelegramHtmlPart, { text: project } as TelegramHtmlPart, { html: "\n\n" } as TelegramHtmlPart] : []),
		{ html: "Finished and waiting for your next input.\n\n<details><summary>Details</summary>" }, { text: details },
		{ html: "</details>" },
		...(resumed ? [{ html: "\n\n✅ Resumed before this idle notification needed action." } as TelegramHtmlPart] : []),
	]);
}

function safeCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

function extractLastAssistantText(event: unknown): string | undefined {
	const messages = (event as { messages?: unknown[] } | undefined)?.messages;
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string } | undefined;
		if (message?.role !== "assistant") continue;
		const text = extractSessionMessageText(message);
		if (text) return text;
	}
	return undefined;
}

function extractSessionMessageText(message: unknown): string | undefined {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((block) => {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				return (block as { text: string }).text;
			}
			return "";
		})
		.join("\n")
		.trim();
	return text || undefined;
}

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
	const normalized: QuestionOption[] = [];
	for (const option of options) {
		if (typeof option === "string") {
			normalized.push({ title: option });
			continue;
		}
		if (
			option &&
			typeof option === "object" &&
			typeof option.title === "string"
		) {
			normalized.push({
				title: option.title,
				description: option.description,
			});
		}
	}
	return normalized;
}

function formatOptionsForMessage(options: QuestionOption[]): string {
	return options
		.map((option, index) => {
			const desc = option.description ? ` — ${option.description}` : "";
			return `${index + 1}. ${option.title}${desc}`;
		})
		.join("\n");
}

function normalizeOptionalComment(
	text: string | null | undefined,
): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function createFreeformResponse(
	text: string | null | undefined,
): AskResponse | null {
	const trimmed = text?.trim();
	return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(
	selections: string[],
	comment?: string | null,
): AskResponse | null {
	const normalizedSelections = selections
		.map((selection) => selection.trim())
		.filter(Boolean);
	if (normalizedSelections.length === 0) return null;

	const normalizedComment = normalizeOptionalComment(comment);
	return normalizedComment
		? {
				kind: "selection",
				selections: normalizedSelections,
				comment: normalizedComment,
			}
		: { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
	if (response.kind === "freeform") return response.text;

	const selections = response.selections.join(", ");
	return response.comment ? `${selections} — ${response.comment}` : selections;
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
	const label =
		selections.length === 1 ? "Selected option" : "Selected options";
	const lines = selections.map((selection) => `- ${selection}`).join("\n");
	return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
	return input
		.split(",")
		.map((selection) => selection.trim())
		.filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

function isSelectionResponse(
	response: AskResponse,
): response is Extract<AskResponse, { kind: "selection" }> {
	return response.kind === "selection";
}

function createSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: createSelectListTheme(theme),
	};
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
	private color: (s: string) => string;
	private title?: string;
	private titleColor?: (s: string) => string;
	constructor(
		color: (s: string) => string,
		title?: string,
		titleColor?: (s: string) => string,
	) {
		this.color = color;
		this.title = title;
		this.titleColor = titleColor;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!this.title || inner < this.title.length + 4) {
			return [this.color(`╭${"─".repeat(inner)}╮`)];
		}
		const label = ` ${this.title} `;
		const remaining = inner - 1 - label.length;
		const titleStyle = this.titleColor ?? this.color;
		return [
			this.color("╭─") +
				titleStyle(label) +
				this.color("─".repeat(Math.max(0, remaining)) + "╮"),
		];
	}
}

class BoxBorderBottom implements Component {
	private color: (s: string) => string;
	private label?: string;
	private labelColor?: (s: string) => string;
	constructor(
		color: (s: string) => string,
		label?: string,
		labelColor?: (s: string) => string,
	) {
		this.color = color;
		this.label = label;
		this.labelColor = labelColor;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const inner = Math.max(0, width - 2);
		if (!this.label || inner < this.label.length + 4) {
			return [this.color(`╰${"─".repeat(inner)}╯`)];
		}
		const tag = ` ${this.label} `;
		const leftDashes = inner - tag.length - 1;
		const style = this.labelColor ?? this.color;
		return [
			this.color("╰" + "─".repeat(Math.max(0, leftDashes))) +
				style(tag) +
				this.color("─╯"),
		];
	}
}

function formatKeyList(keys: string[]): string {
	return keys.join("/");
}

function keybindingHint(
	theme: Theme,
	keybindings: KeybindingsManager,
	keybinding: Keybinding,
	description: string,
): string {
	return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
	return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

type ResolvedShortcut =
	| { disabled: false; spec: string; matches: (data: string) => boolean }
	| { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
	overlayToggle: ResolvedShortcut;
	commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
	disabled: true,
	spec: null,
	matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(
	value: string | null | undefined,
): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const trimmed = value.trim().toLowerCase();
	if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
	return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
	// KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
	// plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
	if (!spec) return false;
	if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec))
		return false;
	if (spec.startsWith("+") || spec.endsWith("+")) return false;
	if (spec.includes("++")) return false;
	return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
	return {
		disabled: false,
		spec,
		matches: (data: string) => matchesKey(data, spec as any),
	};
}

function resolveShortcut(
	paramValue: string | null | undefined,
	envValue: string | undefined,
	defaultSpec: string,
): ResolvedShortcut {
	const candidates: Array<string | null | undefined> = [
		paramValue,
		envValue,
		defaultSpec,
	];
	for (const raw of candidates) {
		const normalized = normalizeShortcutSpec(raw);
		if (normalized === undefined) continue; // not provided, fall through
		if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
		if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
		// Invalid spec: silently fall through to next candidate.
	}
	return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_WIDTH: SizeValue = "92%";
const ASK_OVERLAY_MAX_HEIGHT: SizeValue = "85%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");

function matchesSelectUp(
	data: string,
	keybindings: KeybindingsManager,
): boolean {
	return (
		keybindings.matches(data, "tui.select.up") ||
		matchesKey(data, Key.shift("tab")) ||
		matchesKey(data, VIM_SELECT_UP_KEY)
	);
}

function matchesSelectDown(
	data: string,
	keybindings: KeybindingsManager,
): boolean {
	return (
		keybindings.matches(data, "tui.select.down") ||
		matchesKey(data, Key.tab) ||
		matchesKey(data, VIM_SELECT_DOWN_KEY)
	);
}

function buildCustomUIOptions(
	displayMode: AskDisplayMode,
	onHandle?: (handle: OverlayHandle) => void,
) {
	const overlayOptions = {
		anchor: "center" as const,
		width: ASK_OVERLAY_WIDTH,
		minWidth: ASK_OVERLAY_MIN_WIDTH,
		maxHeight: ASK_OVERLAY_MAX_HEIGHT,
		margin: 1,
	};

	switch (displayMode) {
		case "inline":
			return undefined;
		case "overlay":
			return {
				overlay: true,
				overlayOptions,
				...(onHandle ? { onHandle } : {}),
			};
		default: {
			const _exhaustive: never = displayMode;
			void _exhaustive;
			return {
				overlay: true,
				overlayOptions,
				...(onHandle ? { onHandle } : {}),
			};
		}
	}
}

class MultiSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private allowComment: boolean;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private commentToggle: ResolvedShortcut;
	private selectedIndex = 0;
	private checked = new Set<number>();
	private commentEnabled = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string[]) => void;
	public onEnterFreeform?: () => void;

	constructor(
		options: QuestionOption[],
		allowFreeform: boolean,
		allowComment: boolean,
		theme: Theme,
		keybindings: KeybindingsManager,
		commentToggle: ResolvedShortcut,
	) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.allowComment = allowComment;
		this.theme = theme;
		this.keybindings = keybindings;
		this.commentToggle = commentToggle;
	}

	public isCommentEnabled(): boolean {
		return this.commentEnabled;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getItemCount(): number {
		return (
			this.options.length +
			(this.allowComment ? 1 : 0) +
			(this.allowFreeform ? 1 : 0)
		);
	}

	private getCommentToggleIndex(): number | null {
		return this.allowComment ? this.options.length : null;
	}

	private getFreeformIndex(): number {
		return this.options.length + (this.allowComment ? 1 : 0);
	}

	private isCommentToggleRow(index: number): boolean {
		const toggleIndex = this.getCommentToggleIndex();
		return toggleIndex !== null && index === toggleIndex;
	}

	private isFreeformRow(index: number): boolean {
		return this.allowFreeform && index === this.getFreeformIndex();
	}

	private toggle(index: number): void {
		if (index < 0 || index >= this.options.length) return;
		if (this.checked.has(index)) this.checked.delete(index);
		else this.checked.add(index);
	}

	private toggleComment(): void {
		if (!this.allowComment) return;
		this.commentEnabled = !this.commentEnabled;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		const count = this.getItemCount();
		if (count === 0) {
			this.onCancel?.();
			return;
		}

		if (
			this.allowComment &&
			!this.commentToggle.disabled &&
			this.commentToggle.matches(data)
		) {
			this.toggleComment();
			return;
		}

		if (matchesSelectUp(data, this.keybindings)) {
			this.selectedIndex =
				this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (matchesSelectDown(data, this.keybindings)) {
			this.selectedIndex =
				this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < this.options.length) {
				this.toggle(idx);
				this.selectedIndex = Math.min(idx, count - 1);
				this.invalidate();
			}
			return;
		}

		if (matchesKey(data, Key.space)) {
			if (this.isCommentToggleRow(this.selectedIndex)) {
				this.toggleComment();
				return;
			}
			if (this.isFreeformRow(this.selectedIndex)) {
				this.onEnterFreeform?.();
				return;
			}
			this.toggle(this.selectedIndex);
			this.invalidate();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.isCommentToggleRow(this.selectedIndex)) {
				this.toggleComment();
				return;
			}
			if (this.isFreeformRow(this.selectedIndex)) {
				this.onEnterFreeform?.();
				return;
			}

			const selectedTitles = Array.from(this.checked)
				.sort((a, b) => a - b)
				.map((i) => this.options[i]?.title)
				.filter((t): t is string => !!t);

			const fallback = this.options[this.selectedIndex]?.title;
			const result =
				selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

			if (result.length > 0) this.onSubmit?.(result);
			else this.onCancel?.();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const theme = this.theme;
		const count = this.getItemCount();
		const maxVisible = Math.min(count, 10);

		if (count === 0) {
			this.cachedLines = [theme.fg("warning", "No options")];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				count - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, count);

		const lines: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→") : " ";

			if (this.isCommentToggleRow(i)) {
				const checkbox = this.commentEnabled
					? theme.fg("success", "[✓]")
					: theme.fg("dim", "[ ]");
				const label = isSelected
					? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
					: theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
				lines.push(
					truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""),
				);
				continue;
			}

			if (this.isFreeformRow(i)) {
				const label = theme.fg("text", theme.bold("Type something."));
				const desc = theme.fg("muted", "Enter a custom response");
				const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
				lines.push(truncateToWidth(line, width, ""));
				continue;
			}

			const option = this.options[i];
			if (!option) continue;

			const checkbox = this.checked.has(i)
				? theme.fg("success", "[✓]")
				: theme.fg("dim", "[ ]");
			const num = theme.fg("dim", `${i + 1}.`);
			const title = isSelected
				? theme.fg("accent", theme.bold(option.title))
				: theme.fg("text", theme.bold(option.title));

			const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
			lines.push(truncateToWidth(firstLine, width, ""));

			if (option.description) {
				const indent = "      ";
				const wrapWidth = Math.max(10, width - indent.length);
				const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
				for (const w of wrapped) {
					lines.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
				}
			}
		}

		if (startIndex > 0 || endIndex < count) {
			lines.push(
				theme.fg(
					"dim",
					truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, ""),
				),
			);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

class WrappedSingleSelectList implements Component {
	private options: QuestionOption[];
	private allowFreeform: boolean;
	private allowComment: boolean;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private commentToggle: ResolvedShortcut;
	private selectedIndex = 0;
	private searchQuery = "";
	private commentEnabled = false;
	private maxVisibleRows = 12;
	private cachedWidth?: number;
	private cachedLines?: string[];

	public onCancel?: () => void;
	public onSubmit?: (result: string) => void;
	public onEnterFreeform?: () => void;

	constructor(
		options: QuestionOption[],
		allowFreeform: boolean,
		allowComment: boolean,
		theme: Theme,
		keybindings: KeybindingsManager,
		commentToggle: ResolvedShortcut,
	) {
		this.options = options;
		this.allowFreeform = allowFreeform;
		this.allowComment = allowComment;
		this.theme = theme;
		this.keybindings = keybindings;
		this.commentToggle = commentToggle;
	}

	public isCommentEnabled(): boolean {
		return this.commentEnabled;
	}

	setMaxVisibleRows(rows: number): void {
		const next = Math.max(1, Math.floor(rows));
		if (next !== this.maxVisibleRows) {
			this.maxVisibleRows = next;
			this.invalidate();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private getFilteredOptions(): QuestionOption[] {
		return fuzzyFilter(
			this.options,
			this.searchQuery,
			(option) => `${option.title} ${option.description ?? ""}`,
		);
	}

	private getItemCount(filteredOptions: QuestionOption[]): number {
		return (
			filteredOptions.length +
			(this.allowComment ? 1 : 0) +
			(this.allowFreeform ? 1 : 0)
		);
	}

	private isCommentToggleRow(
		index: number,
		filteredOptions: QuestionOption[],
	): boolean {
		return this.allowComment && index === filteredOptions.length;
	}

	private isFreeformRow(
		index: number,
		filteredOptions: QuestionOption[],
	): boolean {
		return (
			this.allowFreeform &&
			index === filteredOptions.length + (this.allowComment ? 1 : 0)
		);
	}

	private toggleComment(): void {
		if (!this.allowComment) return;
		this.commentEnabled = !this.commentEnabled;
		this.invalidate();
	}

	private setSearchQuery(query: string): void {
		this.searchQuery = query;
		this.selectedIndex = 0;
		this.invalidate();
	}

	private popSearchCharacter(): void {
		if (!this.searchQuery) return;
		const characters = [...this.searchQuery];
		characters.pop();
		this.setSearchQuery(characters.join(""));
	}

	private getPrintableInput(data: string): string | null {
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) return kittyPrintable;

		const characters = [...data];
		if (characters.length !== 1) return null;

		const [character] = characters;
		if (!character) return null;

		const code = character.charCodeAt(0);
		if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			return null;
		}

		return character;
	}

	private styleListLine(
		line: string,
		width: number,
		isSelected: boolean,
	): string {
		const trimmed = line.trim();

		if (trimmed.startsWith("(")) {
			return truncateToWidth(this.theme.fg("dim", line), width, "");
		}

		if (isSelected) {
			return truncateToWidth(
				this.theme.fg("accent", this.theme.bold(line)),
				width,
				"",
			);
		}

		if (line.startsWith("      ")) {
			return truncateToWidth(this.theme.fg("muted", line), width, "");
		}

		if (line.startsWith("→")) {
			return truncateToWidth(
				this.theme.fg("accent", this.theme.bold(line)),
				width,
				"",
			);
		}

		return truncateToWidth(this.theme.fg("text", line), width, "");
	}

	private getSplitPaneWidths(
		width: number,
	): { left: number; right: number } | null {
		if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

		const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
		if (
			availableWidth <
			SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH +
				SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH
		) {
			return null;
		}

		const preferredLeftWidth = Math.floor(availableWidth * 0.42);
		const left = Math.max(
			SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
			Math.min(
				preferredLeftWidth,
				availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH,
			),
		);
		const right = availableWidth - left;

		if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
		return { left, right };
	}

	private buildListLines(
		width: number,
		filteredOptions: QuestionOption[],
		hideDescriptions = false,
	): string[] {
		const lines: string[] = [];
		const count = this.getItemCount(filteredOptions);
		const searchValue = this.searchQuery
			? this.theme.fg("text", this.searchQuery)
			: this.theme.fg("dim", "type to filter");
		lines.push(
			truncateToWidth(
				`${this.theme.fg("accent", "Filter:")} ${searchValue}`,
				width,
				"",
			),
		);

		if (this.searchQuery && filteredOptions.length === 0) {
			lines.push(
				truncateToWidth(
					this.theme.fg("warning", "No matching options"),
					width,
					"",
				),
			);
		}

		if (count === 0) {
			if (!this.searchQuery) {
				lines.push(
					truncateToWidth(this.theme.fg("warning", "No options"), width, ""),
				);
			}
			return lines.slice(0, this.maxVisibleRows);
		}

		const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
		const optionRows = renderSingleSelectRows({
			options: filteredOptions,
			selectedIndex: this.selectedIndex,
			width,
			allowFreeform: this.allowFreeform,
			allowComment: this.allowComment,
			commentEnabled: this.commentEnabled,
			maxRows,
			hideDescriptions,
		});
		const optionLines = optionRows.map((row) =>
			this.styleListLine(row.line, width, row.selected),
		);

		lines.push(...optionLines);
		return lines.slice(0, this.maxVisibleRows);
	}

	private buildPreviewLines(
		width: number,
		filteredOptions: QuestionOption[],
		maxLines: number,
	): string[] {
		if (maxLines <= 0) return [];

		const mdTheme = safeMarkdownTheme();

		let md = "";

		if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
			md += "## Additional context\n\n";
			md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
			md +=
				"Turn this on when the selected option needs extra explanation before the tool submits.\n";
		} else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
			md += "## Custom response\n\n";
			md += "Open the editor to write **any** answer.\n\n";
			md += "*Use this when none of the listed options fit.*\n";
			if (this.searchQuery) {
				md += `\n> Current filter: \`${this.searchQuery}\`\n`;
			}
		} else {
			const selected = filteredOptions[this.selectedIndex];
			if (!selected) {
				md += "*No option selected*\n";
			} else {
				md += `## ${selected.title}\n\n`;
				if (selected.description?.trim()) {
					md += `${selected.description}\n`;
				} else {
					md += "*No additional details provided for this option.*\n";
				}
				md += `\n---\n\nPress \`Enter\` to select this option.\n`;
				if (this.searchQuery) {
					md += `\n> Filter: \`${this.searchQuery}\`\n`;
				}
			}
		}

		let lines: string[];
		if (mdTheme) {
			const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
			lines = mdComponent.render(width);
		} else {
			lines = [];
			for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
				lines.push(truncateToWidth(line, width, ""));
			}
		}

		while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
			lines.pop();
		}

		if (lines.length <= maxLines) return lines;
		if (maxLines === 1)
			return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

		const visibleLines = lines.slice(0, maxLines - 1);
		visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
		return visibleLines;
	}

	handleInput(data: string): void {
		if (this.searchQuery && matchesKey(data, Key.escape)) {
			this.setSearchQuery("");
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}

		if (
			this.allowComment &&
			!this.commentToggle.disabled &&
			this.commentToggle.matches(data)
		) {
			this.toggleComment();
			return;
		}

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);

		if (matchesSelectUp(data, this.keybindings) && count > 0) {
			this.selectedIndex =
				this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.invalidate();
			return;
		}

		if (matchesSelectDown(data, this.keybindings) && count > 0) {
			this.selectedIndex =
				this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.invalidate();
			return;
		}

		const numMatch = data.match(/^[1-9]$/);
		if (numMatch && filteredOptions.length > 0) {
			const idx = Number.parseInt(numMatch[0], 10) - 1;
			if (idx >= 0 && idx < filteredOptions.length) {
				this.selectedIndex = idx;
				this.invalidate();
				return;
			}
		}

		if (
			matchesKey(data, Key.space) &&
			count > 0 &&
			this.isCommentToggleRow(this.selectedIndex, filteredOptions)
		) {
			this.toggleComment();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
			if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
				this.toggleComment();
				return;
			}
			if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
				this.onEnterFreeform?.();
				return;
			}

			const result = filteredOptions[this.selectedIndex]?.title;
			if (result) this.onSubmit?.(result);
			else this.onCancel?.();
			return;
		}

		if (
			this.keybindings.matches(data, "tui.editor.deleteCharBackward") ||
			matchesKey(data, Key.backspace)
		) {
			this.popSearchCharacter();
			return;
		}

		const printableInput = this.getPrintableInput(data);
		if (printableInput) {
			this.setSearchQuery(this.searchQuery + printableInput);
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const filteredOptions = this.getFilteredOptions();
		const count = this.getItemCount(filteredOptions);
		this.selectedIndex =
			count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

		const splitPane = this.getSplitPaneWidths(width);
		let lines: string[];

		if (!splitPane) {
			lines = this.buildListLines(width, filteredOptions);
		} else {
			const listLines = this.buildListLines(
				splitPane.left,
				filteredOptions,
				true,
			);
			const previewLines = this.buildPreviewLines(
				splitPane.right,
				filteredOptions,
				this.maxVisibleRows,
			);
			const rowCount = Math.min(
				this.maxVisibleRows,
				Math.max(listLines.length, previewLines.length),
			);
			const separator = this.theme.fg(
				"dim",
				SINGLE_SELECT_SPLIT_PANE_SEPARATOR,
			);
			lines = Array.from({ length: rowCount }, (_, index) => {
				const left = truncateToWidth(
					listLines[index] ?? "",
					splitPane.left,
					"",
					true,
				);
				const right = truncateToWidth(
					previewLines[index] ?? "",
					splitPane.right,
					"",
				);
				return `${left}${separator}${right}`;
			});
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
	private question: string;
	private context?: string;
	private options: QuestionOption[];
	private allowMultiple: boolean;
	private allowFreeform: boolean;
	private allowComment: boolean;
	private displayMode: AskDisplayMode;
	private tui: TUI;
	private theme: Theme;
	private keybindings: KeybindingsManager;
	private shortcuts: ResolvedAskShortcuts;
	private onDone: (result: AskUIResult | null) => void;

	private mode: AskMode = "select";
	private pendingSelections: string[] = [];
	private freeformDraft = "";
	private commentDraft = "";

	// Static layout components
	private titleText: Text;
	private questionText: Text;
	private contextComponent?: Component;
	private modeContainer: Container;
	private helpText: Text;

	// Mode components
	private singleSelectList?: WrappedSingleSelectList;
	private multiSelectList?: MultiSelectList;
	private editor?: Editor;

	// Focusable - propagate to Editor for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
			(this.editor as any).focused = value;
		}
	}

	constructor(
		question: string,
		context: string | undefined,
		options: QuestionOption[],
		allowMultiple: boolean,
		allowFreeform: boolean,
		allowComment: boolean,
		displayMode: AskDisplayMode,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		shortcuts: ResolvedAskShortcuts,
		onDone: (result: AskUIResult | null) => void,
	) {
		super();

		this.question = question;
		this.context = context;
		this.options = options;
		this.allowMultiple = allowMultiple;
		this.allowFreeform = allowFreeform;
		this.allowComment = allowComment;
		this.displayMode = displayMode;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.shortcuts = shortcuts;
		this.onDone = onDone;

		// Layout skeleton
		this.addChild(
			new BoxBorderTop(
				(s: string) => theme.fg("accent", s),
				"ask_user",
				(s: string) => theme.fg("dim", theme.bold(s)),
			),
		);
		this.addChild(new Spacer(1));

		this.titleText = new Text("", 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		this.questionText = new Text("", 1, 0);
		this.addChild(this.questionText);

		if (this.context) {
			this.addChild(new Spacer(1));
			const mdTheme = safeMarkdownTheme();
			if (mdTheme) {
				this.contextComponent = new Markdown("", 1, 0, mdTheme);
			} else {
				this.contextComponent = new Text("", 1, 0);
			}
			this.addChild(this.contextComponent);
		}

		this.addChild(new Spacer(1));

		this.modeContainer = new Container();
		this.addChild(this.modeContainer);

		this.addChild(new Spacer(1));
		this.helpText = new Text("", 1, 0);
		this.addChild(this.helpText);

		this.addChild(new Spacer(1));
		this.addChild(
			new BoxBorderBottom(
				(s: string) => theme.fg("accent", s),
				`v${ASK_USER_VERSION}`,
				(s: string) => theme.fg("dim", s),
			),
		);

		this.updateStaticText();
		this.showSelectMode();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateStaticText();
		this.updateHelpText();
	}

	override render(width: number): string[] {
		const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

		if (this.mode === "select" && !this.allowMultiple) {
			const overlayMaxHeight = Math.max(
				12,
				Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO),
			);
			const staticLines = this.countStaticLines(innerWidth);
			const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
			this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
		}

		// Render children at the inner width (excluding side border characters)
		const rawLines = super.render(innerWidth);

		// First and last lines are the top/bottom box borders — pass through at full width.
		// All inner lines get wrapped with side borders.
		const borderColor = (s: string) => this.theme.fg("accent", s);
		const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
		return rawLines.map((line, index) => {
			if (index === 0 || index === rawLines.length - 1) {
				// Box top/bottom borders already rendered at innerWidth — re-render at full width
				if (index === 0)
					return new BoxBorderTop(borderColor, "ask_user", titleColor).render(
						width,
					)[0];
				return new BoxBorderBottom(
					borderColor,
					`v${ASK_USER_VERSION}`,
					(s: string) => this.theme.fg("dim", s),
				).render(width)[0];
			}
			const padded = truncateToWidth(line, innerWidth, "", true);
			return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
		});
	}

	private countWrappedLines(text: string, width: number): number {
		return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
	}

	private countStaticLines(width: number): number {
		const titleLines = 1;
		const questionLines = this.countWrappedLines(this.question, width);
		const contextLines = this.context
			? 1 + this.countWrappedLines(this.context, width)
			: 0;
		const helpLines = 1;
		const borderLines = 2;
		const spacerLines = this.context ? 6 : 5;
		return (
			borderLines +
			spacerLines +
			titleLines +
			questionLines +
			contextLines +
			helpLines
		);
	}

	private updateStaticText(): void {
		const theme = this.theme;
		const title = this.mode === "comment" ? "Optional comment" : "Question";
		this.titleText.setText(theme.fg("accent", theme.bold(title)));
		this.questionText.setText(theme.fg("text", theme.bold(this.question)));
		if (this.contextComponent && this.context) {
			if (this.contextComponent instanceof Markdown) {
				(this.contextComponent as Markdown).setText(
					`**Context:**\n${this.context}`,
				);
			} else {
				(this.contextComponent as Text).setText(
					`${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
				);
			}
		}
	}

	private updateHelpText(): void {
		const theme = this.theme;
		const overlayHint =
			this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
				? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
				: null;
		const commentHint =
			this.allowComment && !this.shortcuts.commentToggle.disabled
				? literalHint(
						theme,
						this.shortcuts.commentToggle.spec,
						"toggle context",
					)
				: null;
		if (this.mode === "freeform" || this.mode === "comment") {
			const alternateCancelKeys = this.keybindings
				.getKeys("tui.select.cancel")
				.filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				keybindingHint(
					theme,
					this.keybindings,
					"tui.input.submit",
					this.mode === "comment" ? "submit/skip" : "submit",
				),
				keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
				literalHint(theme, "esc", "back"),
				overlayHint,
				alternateCancelKeys.length > 0
					? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
					: null,
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
			return;
		}

		if (this.allowMultiple) {
			const hints = [
				literalHint(theme, "↑↓", "navigate"),
				literalHint(theme, "space", "toggle"),
				commentHint,
				overlayHint,
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
				keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		} else {
			const alternateCancelKeys = this.keybindings
				.getKeys("tui.select.cancel")
				.filter((key) => key !== "escape" && key !== "esc");
			const hints = [
				literalHint(theme, "type", "filter"),
				keybindingHint(
					theme,
					this.keybindings,
					"tui.editor.deleteCharBackward",
					"erase",
				),
				literalHint(theme, "↑↓", "navigate"),
				commentHint,
				overlayHint,
				keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
				literalHint(theme, "esc", "clear/cancel"),
				alternateCancelKeys.length > 0
					? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
					: null,
			]
				.filter((hint): hint is string => !!hint)
				.join(" • ");
			this.helpText.setText(theme.fg("dim", hints));
		}
	}

	private ensureSingleSelectList(): WrappedSingleSelectList {
		if (this.singleSelectList) return this.singleSelectList;

		const list = new WrappedSingleSelectList(
			this.options,
			this.allowFreeform,
			this.allowComment,
			this.theme,
			this.keybindings,
			this.shortcuts.commentToggle,
		);
		list.onSubmit = (result) =>
			this.handleSelectionSubmit([result], list.isCommentEnabled());
		list.onCancel = () => this.onDone(null);
		list.onEnterFreeform = () => this.showFreeformMode();

		this.singleSelectList = list;
		return list;
	}

	private ensureMultiSelectList(): MultiSelectList {
		if (this.multiSelectList) return this.multiSelectList;

		const list = new MultiSelectList(
			this.options,
			this.allowFreeform,
			this.allowComment,
			this.theme,
			this.keybindings,
			this.shortcuts.commentToggle,
		);
		list.onCancel = () => this.onDone(null);
		list.onSubmit = (result) =>
			this.handleSelectionSubmit(result, list.isCommentEnabled());
		list.onEnterFreeform = () => this.showFreeformMode();

		this.multiSelectList = list;
		return list;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			this.handleEditorSubmit(text);
		};
		this.editor = editor;
		return editor;
	}

	private saveEditorDraft(): void {
		if (!this.editor) return;
		const getText = (this.editor as any).getText;
		if (typeof getText !== "function") return;

		const currentText = String(getText.call(this.editor) ?? "");
		if (this.mode === "freeform") {
			this.freeformDraft = currentText;
		} else if (this.mode === "comment") {
			this.commentDraft = currentText;
		}
	}

	private setEditorText(text: string): void {
		const editor = this.ensureEditor();
		const setText = (editor as any).setText;
		if (typeof setText === "function") {
			setText.call(editor, text);
		}
	}

	private handleSelectionSubmit(
		selections: string[],
		wantsComment: boolean,
	): void {
		if (this.allowComment && wantsComment) {
			this.pendingSelections = selections;
			this.commentDraft = "";
			this.showCommentMode();
			return;
		}

		this.onDone(createSelectionResponse(selections));
	}

	private handleEditorSubmit(text: string): void {
		if (this.mode === "freeform") {
			this.onDone(createFreeformResponse(text));
			return;
		}

		if (this.mode === "comment") {
			this.commentDraft = text;
			this.onDone(createSelectionResponse(this.pendingSelections, text));
		}
	}

	private showSelectMode(): void {
		if (this.mode === "freeform" || this.mode === "comment") {
			this.saveEditorDraft();
		}

		this.mode = "select";
		this.pendingSelections = [];
		this.modeContainer.clear();

		if (this.allowMultiple) {
			this.modeContainer.addChild(this.ensureMultiSelectList());
		} else {
			this.modeContainer.addChild(this.ensureSingleSelectList());
		}

		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private showFreeformMode(): void {
		if (this.mode === "comment") {
			this.saveEditorDraft();
		}

		this.mode = "freeform";
		this.modeContainer.clear();

		const editor = this.ensureEditor();
		this.setEditorText(this.freeformDraft);
		(editor as any).focused = this._focused;

		this.modeContainer.addChild(
			new Text(
				this.theme.fg("accent", this.theme.bold("Custom response")),
				1,
				0,
			),
		);
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);

		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	private showCommentMode(): void {
		if (this.mode === "freeform") {
			this.saveEditorDraft();
		}

		this.mode = "comment";
		this.modeContainer.clear();

		const editor = this.ensureEditor();
		this.setEditorText(this.commentDraft);
		(editor as any).focused = this._focused;

		const selectedLabel =
			this.pendingSelections.length === 1
				? "Selected option:"
				: "Selected options:";
		this.modeContainer.addChild(
			new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0),
		);
		this.modeContainer.addChild(
			new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0),
		);
		this.modeContainer.addChild(new Spacer(1));
		this.modeContainer.addChild(editor);

		this.updateHelpText();
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "freeform" || this.mode === "comment") {
			if (matchesKey(data, Key.escape)) {
				this.showSelectMode();
				return;
			}

			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.onDone(null);
				return;
			}

			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (this.allowMultiple) {
			this.ensureMultiSelectList().handleInput?.(data);
			this.tui.requestRender();
			return;
		}

		this.ensureSingleSelectList().handleInput?.(data);
		this.tui.requestRender();
	}
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
async function askViaDialogs(
	ui: { select: Function; input: Function },
	question: string,
	context: string | undefined,
	options: QuestionOption[],
	allowMultiple: boolean,
	allowFreeform: boolean,
	allowComment: boolean,
	timeout?: number,
): Promise<AskUIResult | null> {
	const dialogOpts = timeout ? { timeout } : undefined;
	const prompt = context ? `${question}\n\nContext:\n${context}` : question;

	if (allowMultiple) {
		const optionList = formatOptionsForMessage(options);
		const rawSelections = (await ui.input(
			`${prompt}\n\nOptions (select one or more):\n${optionList}`,
			"Type your selection(s)...",
			dialogOpts,
		)) as string | undefined;
		if (isCancelledInput(rawSelections)) return null;

		const selections = parseDialogSelections(rawSelections);
		if (selections.length === 0) return null;

		if (!allowComment) {
			return createSelectionResponse(selections);
		}

		const comment = (await ui.input(
			buildCommentPrompt(prompt, selections),
			"Optional comment (press Enter to skip)...",
			dialogOpts,
		)) as string | undefined;
		return createSelectionResponse(selections, comment);
	}

	const selectOptions = options.map((o) => o.title);
	if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

	const selected = (await ui.select(prompt, selectOptions, dialogOpts)) as
		| string
		| undefined;
	if (isCancelledInput(selected)) return null;

	if (selected === FREEFORM_SENTINEL) {
		const answer = (await ui.input(
			prompt,
			"Type your answer...",
			dialogOpts,
		)) as string | undefined;
		if (isCancelledInput(answer)) return null;
		return createFreeformResponse(answer);
	}

	if (!allowComment) {
		return createSelectionResponse([selected]);
	}

	const comment = (await ui.input(
		buildCommentPrompt(prompt, [selected]),
		"Optional comment (press Enter to skip)...",
		dialogOpts,
	)) as string | undefined;
	return createSelectionResponse([selected], comment);
}

/** Internal test seam; not used by the extension runtime. */
export const __telegramTestHooks = {
	tryAcquireLease: tryAcquireTelegramLease,
	cleanupLeaseTombstones: cleanupTelegramLeaseTombstones,
	readLeaseOwner: async (lockDir: string) => await readJsonFile<TelegramLeaseOwner>(join(lockDir, "owner.json")),
	leasePath: telegramLeasePath,
	tombstonePath: telegramLeaseTombstone,
	invalidateTopicMap: invalidateTelegramTopicMap,
	isInvalidTopicDescription: (description: string) => isInvalidTopic(new TelegramApiError(400, description)),
	setLeaseBarrier: (barrier: typeof telegramLeaseTestBarrier) => { telegramLeaseTestBarrier = barrier; },
	setPollingBarrier: (barrier: typeof telegramPollingTestBarrier) => { telegramPollingTestBarrier = barrier; },
	setRegistrationBarrier: (barrier: typeof telegramRegistrationTestBarrier) => { telegramRegistrationTestBarrier = barrier; },
	createPoller: (config: TelegramConfig) => new TelegramBotPoller(config),
	storeForConfig: createTelegramSharedStore,
	resolveTopicName: resolveTelegramTopicName,
	handleUpdate: async (poller: TelegramBotPoller, update: TelegramUpdate) => await (poller as unknown as { handleUpdate: (value: TelegramUpdate) => Promise<void> }).handleUpdate(update),
	consumeInbox: async (poller: TelegramBotPoller) => await (poller as unknown as { consumeInbox: () => Promise<void> }).consumeInbox(),
	deliverFreeText: deliverTelegramFreeText,
	cleanupInboxDone: cleanupTelegramInboxDone,
};

export default function (pi: ExtensionAPI) {
	const activeAsyncRunIds = new Set<string>();
	let asyncEventRevision = 0;
	let subagentRpcAvailable = false;
	let autoCompactionActive = false;
	let latestAgentEnd:
		| { event: unknown; ctx: unknown }
		| undefined;
	let deferredAgentEnd:
		| { event: unknown; ctx: unknown }
		| undefined;

	function scheduleDeferredAgentEndNotice() {
		if (autoCompactionActive || activeAsyncRunIds.size > 0 || !deferredAgentEnd) return;
		const deferred = deferredAgentEnd;
		deferredAgentEnd = undefined;
		scheduleAgentEndTelegramNotice(deferred.event, deferred.ctx);
	}

	pi.events.on(SUBAGENT_RPC_READY_EVENT, () => {
		subagentRpcAvailable = true;
	});
	pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
		const id = subagentRunId(data);
		if (!id) return;
		asyncEventRevision += 1;
		activeAsyncRunIds.add(id);
		cancelPendingAgentEndTelegramNotice();
	});
	pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
		const id = subagentRunId(data);
		if (!id) return;
		asyncEventRevision += 1;
		activeAsyncRunIds.delete(id);
		scheduleDeferredAgentEndNotice();
	});

	pi.on("session_start", async (_event, ctx) => {
		await telegramNotifyManager.activateSession(pi, ctx);
	});
	pi.on("input", async (event) => {
		if (event.source !== "extension") {
			await recordHumanActivity().catch(() => undefined);
		}
		latestAgentEnd = undefined;
		deferredAgentEnd = undefined;
		cancelPendingAgentEndTelegramNotice();
	});
	pi.on("before_agent_start", async () => {
		autoCompactionActive = false;
		latestAgentEnd = undefined;
		deferredAgentEnd = undefined;
		cancelPendingAgentEndTelegramNotice();
	});
	pi.on("agent_end", async (event, ctx) => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		latestAgentEnd = { event, ctx };

		if (subagentRpcAvailable) {
			const revision = asyncEventRevision;
			const reconciled = await queryActiveAsyncRunIds(pi);
			if (reconciled && revision === asyncEventRevision) {
				activeAsyncRunIds.clear();
				for (const id of reconciled) activeAsyncRunIds.add(id);
			}
		}

		if (autoCompactionActive || activeAsyncRunIds.size > 0) {
			deferredAgentEnd = { event, ctx };
			cancelPendingAgentEndTelegramNotice();
			return;
		}

		deferredAgentEnd = undefined;
		scheduleAgentEndTelegramNotice(event, ctx);
	});
	const onAutoCompaction = pi.on as unknown as (
		event: string,
		handler: (event: { willRetry?: boolean }) => Promise<void>,
	) => void;
	// The installed Pi type declarations may lag these runtime lifecycle events.
	onAutoCompaction("auto_compaction_start", async () => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		autoCompactionActive = true;
		deferredAgentEnd = latestAgentEnd;
		cancelPendingAgentEndTelegramNotice();
	});
	onAutoCompaction("auto_compaction_end", async (event) => {
		if (process.env.PI_SUBAGENT_CHILD === "1") return;
		autoCompactionActive = false;
		if (event?.willRetry === true) {
			// This end belongs to the compacted turn; await the retry's real end.
			latestAgentEnd = undefined;
			deferredAgentEnd = undefined;
			return;
		}
		scheduleDeferredAgentEndNotice();
	});
	pi.on("session_shutdown", async () => {
		await telegramNotifyManager.deactivateSession();
		autoCompactionActive = false;
		latestAgentEnd = undefined;
		deferredAgentEnd = undefined;
		activeAsyncRunIds.clear();
		cancelPendingAgentEndTelegramNotice();
	});

	pi.registerCommand("ask", {
		description: "Show or set global ask_user availability: status, away, or reset",
		handler: async (args, ctx) => {
			const subcommands = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = subcommands[0]?.toLowerCase();
			if (subcommands.length > 1 || (subcommand && !["status", "away", "reset"].includes(subcommand))) {
				ctx.ui.notify("Usage: /ask [status|away|reset]", "warning");
				return;
			}
			if (subcommand === "away") {
				await setUserAway();
				ctx.ui.notify("ask_user availability set to away", "info");
				return;
			}
			if (subcommand === "reset") {
				await recordHumanActivity();
				ctx.ui.notify("ask_user availability reset to normal", "info");
				return;
			}

			const [config, presence] = await Promise.all([
				resolveAskAvailabilityConfig(),
				readAskPresenceState(),
			]);
			ctx.ui.notify(
				[
					`ask_user availability: ${config.enabled ? presence.mode : "disabled"}`,
					"Normal timeout: none (explicit per-call only)",
					`Away timeout: ${formatDurationMs(config.awayTimeoutMs)}`,
					presence.awaySince
						? `Away since: ${new Date(presence.awaySince).toLocaleString()}`
						: undefined,
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				"info",
			);
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
		promptSnippet:
			"Ask the user one focused question with optional multiple-choice answers to gather information interactively",
		promptGuidelines: [
			"Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
			"Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
			"Ask exactly one focused question per ask_user call.",
			"Do not combine multiple numbered, multipart, or unrelated questions into one ask_user prompt.",
			"If ask_user times out, do not immediately repeat the question. Choose a safe or clearly recommended option and continue, or call pause_goal when an active goal cannot proceed without the user.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			context: Type.Optional(
				Type.String({
					description:
						"Relevant context to show before the question (summary of findings)",
				}),
			),
			options: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String({ description: "Short title for this option" }),
						Type.Object({
							title: Type.String({
								description: "Short title for this option",
							}),
							description: Type.Optional(
								Type.String({
									description: "Longer description explaining this option",
								}),
							),
						}),
					]),
					{ description: "List of options for the user to choose from" },
				),
			),
			allowMultiple: Type.Optional(
				Type.Boolean({
					description: "Allow selecting multiple options. Default: false",
				}),
			),
			allowFreeform: Type.Optional(
				Type.Boolean({
					description: "Add a freeform text option. Default: true",
				}),
			),
			allowComment: Type.Optional(
				Type.Boolean({
					description:
						"Collect an optional comment after selecting one or more options. Default: false",
				}),
			),
			displayMode: Type.Optional(
				StringEnum(["overlay", "inline"] as const, {
					description:
						"UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Default: PI_ASK_USER_DISPLAY_MODE env var if set, otherwise 'overlay'. Omit to respect the user's configured preference.",
				}),
			),
			overlayToggleKey: Type.Optional(
				Type.String({
					description:
						"Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var if set, otherwise 'alt+o'.",
				}),
			),
			commentToggleKey: Type.Optional(
				Type.String({
					description:
						"Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var if set, otherwise 'ctrl+g'.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Optional per-call timeout in milliseconds. In away mode, the configured away timeout is an upper bound. On expiry, the tool returns guidance to continue safely or pause an active goal.",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Cancelled" }],
					details: {
						question: params.question,
						options: [],
						response: null,
						cancelled: true,
					} as AskToolDetails,
				};
			}

			const {
				question,
				context,
				options: rawOptions = [],
				allowMultiple = false,
				allowFreeform = true,
				allowComment = false,
				displayMode,
				overlayToggleKey,
				commentToggleKey,
				timeout: requestedTimeout,
			} = params as AskParams;
			const questionStartedAt = Date.now();
			const availability = await resolveAskAvailabilityConfig().catch(() => ({
				enabled: true,
				awayTimeoutMs: ASK_AVAILABILITY_DEFAULT_AWAY_TIMEOUT_MS,
			}));
			const presence = availability.enabled
				? await readAskPresenceState().catch(() => ({
						mode: "normal" as const,
						updatedAt: questionStartedAt,
					}))
				: { mode: "normal" as const, updatedAt: questionStartedAt };
			const timeout = availability.enabled && presence.mode === "away"
				? requestedTimeout && requestedTimeout > 0
					? Math.min(requestedTimeout, availability.awayTimeoutMs)
					: availability.awayTimeoutMs
				: requestedTimeout;
			let timeoutReached = false;
			const timeoutMarker =
				timeout && timeout > 0
					? setTimeout(() => {
							timeoutReached = true;
						}, timeout)
					: undefined;
			timeoutMarker?.unref?.();
			const envMode = process.env.PI_ASK_USER_DISPLAY_MODE;
			const envDisplayMode: AskDisplayMode | undefined =
				envMode === "overlay" || envMode === "inline" ? envMode : undefined;
			const effectiveDisplayMode: AskDisplayMode =
				displayMode ?? envDisplayMode ?? "overlay";
			const shortcuts: ResolvedAskShortcuts = {
				overlayToggle: resolveShortcut(
					overlayToggleKey,
					process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY,
					DEFAULT_OVERLAY_TOGGLE_KEY,
				),
				commentToggle: resolveShortcut(
					commentToggleKey,
					process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY,
					DEFAULT_COMMENT_TOGGLE_KEY,
				),
			};
			const options = normalizeOptions(rawOptions);
			const normalizedContext = context?.trim() || undefined;
			const askNotificationRequest = buildAskNotificationRequest({
				question,
				context: normalizedContext,
				options,
				allowMultiple,
				allowFreeform,
				allowComment,
				timeout,
			});
			notifyAskRequested(ctx, askNotificationRequest);
			reportHerdrAskBlocked(pi, true, toolCallId, question);
			const didTimeOut = () =>
				timeoutReached ||
				Boolean(
					timeout &&
						timeout > 0 &&
						Date.now() - questionStartedAt >= Math.max(0, timeout - 25),
				);
			const recordHuman = async () => {
				await recordHumanActivity().catch(() => undefined);
			};
			const cancelledResult = async (manualActivity: boolean) => {
				if (didTimeOut()) {
					pi.events.emit("ask:timed_out", {
						question,
						context: normalizedContext,
						options,
						timeoutMs: timeout,
						presenceMode: presence.mode,
					});
					return {
						content: [
							{
								type: "text" as const,
								text:
									"The user is unavailable: ask_user timed out. Do not repeat this question immediately. If a safe or clearly recommended option exists, choose it and continue while stating the assumption. If user input is essential, authorization is required, or the action is irreversible, stop. When a pi goal is active, call pause_goal with this blocker.",
							},
						],
						details: {
							question,
							context: normalizedContext,
							options,
							response: null,
							cancelled: true,
							timedOut: true,
							presenceMode: presence.mode,
							timeoutMs: timeout,
						} as AskToolDetails,
					};
				}

				if (manualActivity) await recordHuman();
				pi.events.emit("ask:cancelled", {
					question,
					context: normalizedContext,
					options,
				});
				return {
					content: [{ type: "text" as const, text: "User cancelled the question" }],
					details: {
						question,
						context: normalizedContext,
						options,
						response: null,
						cancelled: true,
					} as AskToolDetails,
				};
			};

			try {
			const telegramHandle = await startTelegramAsk(
				askNotificationRequest,
				ctx,
			);
			if (telegramHandle && signal) {
				signal.addEventListener("abort", () => telegramHandle.close(), {
					once: true,
				});
			}

			if (!ctx.hasUI || !ctx.ui) {
				if (telegramHandle) {
					const telegramResponse = await telegramHandle.response;
					if (telegramResponse) {
						await recordHuman();
						pi.events.emit("ask:answered", {
							question,
							context: normalizedContext,
							response: telegramResponse,
						});
						return {
							content: [
								{
									type: "text",
									text: `User answered: ${formatResponseSummary(telegramResponse)}`,
								},
							],
							details: {
								question,
								context: normalizedContext,
								options,
								response: telegramResponse,
								cancelled: false,
							} as AskToolDetails,
						};
					}

					return await cancelledResult(false);
				}

				const optionText =
					options.length > 0
						? `\n\nOptions:\n${formatOptionsForMessage(options)}`
						: "";
				const freeformHint = allowFreeform
					? "\n\nYou can also answer freely."
					: "";
				const commentHint = allowComment
					? "\n\nAfter choosing an option, you may add an optional comment."
					: "";
				const contextText = normalizedContext
					? `\n\nContext:\n${normalizedContext}`
					: "";
				return {
					content: [
						{
							type: "text",
							text: `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}`,
						},
					],
					isError: true,
					details: {
						question,
						context: normalizedContext,
						options,
						response: null,
						cancelled: true,
					} as AskToolDetails,
				};
			}

			if (options.length === 0) {
				const prompt = normalizedContext
					? `${question}\n\nContext:\n${normalizedContext}`
					: question;
				const inputPromise = ctx.ui
					.input(
						prompt,
						"Type your answer...",
						timeout ? { timeout } : undefined,
					)
					.then((answer: string | undefined) => createFreeformResponse(answer));
				const response = telegramHandle
					? await Promise.race([
							inputPromise,
							waitForAcceptedTelegramResponse(telegramHandle),
						])
					: await inputPromise;

				if (!response) {
					telegramHandle?.close();
					return await cancelledResult(true);
				}

				await telegramHandle?.answer(response);
				await recordHuman();

				pi.events.emit("ask:answered", {
					question,
					context: normalizedContext,
					response,
				});
				return {
					content: [
						{
							type: "text",
							text: `User answered: ${formatResponseSummary(response)}`,
						},
					],
					details: {
						question,
						context: normalizedContext,
						options,
						response,
						cancelled: false,
					} as AskToolDetails,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: "Waiting for user input..." }],
				details: {
					question,
					context: normalizedContext,
					options,
					response: null,
					cancelled: false,
				},
			});

			let result: AskUIResult | null;
			let overlayHandle: OverlayHandle | undefined;
			let removeOverlayInputListener: (() => void) | undefined;
			let hasAnnouncedHide = false;
			let resultCompleted = false;
			let customDoneFromTelegram:
				| ((result: AskUIResult | null) => void)
				| undefined;
			let customTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let telegramResultReady = false;
			let telegramResult: AskUIResult | null = null;

			if (telegramHandle) {
				void waitForAcceptedTelegramResponse(telegramHandle).then(
					(response) => {
						telegramResultReady = true;
						telegramResult = response;
						if (!resultCompleted) customDoneFromTelegram?.(response);
					},
				);
			}

			try {
				const customFactory = (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: AskUIResult | null) => void,
				) => {
					const bridgedDone = (value: AskUIResult | null) => {
						if (resultCompleted) return;
						resultCompleted = true;
						done(value);
					};
					customDoneFromTelegram = bridgedDone;

					if (telegramResultReady) {
						queueMicrotask(() => bridgedDone(telegramResult));
					}

					if (signal) {
						const onAbort = () => bridgedDone(null);
						signal.addEventListener("abort", onAbort, { once: true });
					}

					if (timeout && timeout > 0) {
						customTimeoutTimer = setTimeout(() => bridgedDone(null), timeout);
						customTimeoutTimer.unref?.();
					}

					return new AskComponent(
						question,
						normalizedContext,
						options,
						allowMultiple,
						allowFreeform,
						allowComment,
						effectiveDisplayMode,
						tui,
						theme,
						keybindings,
						shortcuts,
						bridgedDone,
					);
				};

				// Register a raw terminal input listener for the overlay-toggle key so the
				// overlay can be toggled even while it is hidden (hidden overlays do not
				// receive input). Inline mode does not need this because the prompt is
				// already non-modal. Skipped entirely if the user disabled the shortcut.
				const overlayToggle = shortcuts.overlayToggle;
				if (
					effectiveDisplayMode === "overlay" &&
					!overlayToggle.disabled &&
					typeof ctx.ui.onTerminalInput === "function"
				) {
					removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
						if (!overlayToggle.matches(data) || !overlayHandle)
							return undefined;
						const nextHidden = !overlayHandle.isHidden();
						overlayHandle.setHidden(nextHidden);
						if (nextHidden && !hasAnnouncedHide) {
							hasAnnouncedHide = true;
							ctx.ui.notify?.(
								`ask_user hidden — press ${overlayToggle.spec} to reopen`,
								"info",
							);
						}
						return { consume: true };
					});
				}

				const customResult = await ctx.ui.custom<AskUIResult | null>(
					customFactory,
					buildCustomUIOptions(effectiveDisplayMode, (handle) => {
						overlayHandle = handle;
					}),
				);

				if (customResult !== undefined) {
					result = customResult;
					resultCompleted = true;
				} else {
					// RPC/headless mode: degrade to select()/input() dialog protocol
					const dialogResult = askViaDialogs(
						ctx.ui,
						question,
						normalizedContext,
						options,
						allowMultiple,
						allowFreeform,
						allowComment,
						timeout,
					);
					result = telegramHandle
						? await Promise.race([
								dialogResult,
								waitForAcceptedTelegramResponse(telegramHandle),
							])
						: await dialogResult;
					resultCompleted = true;
				}
			} catch (error) {
				telegramHandle?.close();
				const message =
					error instanceof Error
						? `${error.message}\n${error.stack ?? ""}`
						: String(error);
				return {
					content: [{ type: "text", text: `Ask tool failed: ${message}` }],
					isError: true,
					details: { error: message },
				};
			} finally {
				resultCompleted = true;
				if (customTimeoutTimer) clearTimeout(customTimeoutTimer);
				removeOverlayInputListener?.();
			}

			if (result === null) {
				telegramHandle?.close();
				return await cancelledResult(true);
			}

			await telegramHandle?.answer(result);
			await recordHuman();
			pi.events.emit("ask:answered", {
				question,
				context: normalizedContext,
				response: result,
			});
			return {
				content: [
					{
						type: "text",
						text: `User answered: ${formatResponseSummary(result)}`,
					},
				],
				details: {
					question,
					context: normalizedContext,
					options,
					response: result,
					cancelled: false,
				} as AskToolDetails,
			};
			} finally {
				if (timeoutMarker) clearTimeout(timeoutMarker);
				reportHerdrAskBlocked(pi, false, toolCallId, question);
			}
		},

		renderCall(args, theme) {
			const question = (args.question as string) || "";
			const rawOptions = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user "));
			text += theme.fg("muted", question);
			if (rawOptions.length > 0) {
				const labels = rawOptions.map((o: unknown) =>
					typeof o === "string" ? o : ((o as QuestionOption)?.title ?? ""),
				);
				text +=
					"\n" +
					theme.fg(
						"dim",
						`  ${rawOptions.length} option(s): ${labels.join(", ")}`,
					);
			}
			if (args.allowMultiple) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (args.allowComment) {
				text += theme.fg("dim", " [optional comment]");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as
				| (AskToolDetails & { error?: string })
				| undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
			}

			if (options.isPartial) {
				const waitingText =
					result.content
						?.filter((part: any) => part?.type === "text")
						.map((part: any) => part.text ?? "")
						.join("\n")
						.trim() || "Waiting for user input...";
				return new Text(theme.fg("muted", waitingText), 0, 0);
			}

			if (details?.timedOut) {
				return new Text(
					theme.fg("warning", `Timed out (${formatDurationMs(details.timeoutMs ?? 0)})`),
					0,
					0,
				);
			}

			if (!details || details.cancelled || !details.response) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const response = details.response;
			let text = theme.fg("success", "✓ ");
			if (response.kind === "freeform") {
				text += theme.fg("muted", "(wrote) ");
			}
			text += theme.fg("accent", formatResponseSummary(response));

			if (options.expanded) {
				text += "\n" + theme.fg("dim", `Q: ${details.question}`);
				if (details.context) {
					text += "\n" + theme.fg("dim", details.context);
				}

				if (isSelectionResponse(response) && details.options.length > 0) {
					const selectedTitles = new Set(response.selections);
					text += "\n" + theme.fg("dim", "Options:");
					for (const opt of details.options) {
						const desc = opt.description ? ` — ${opt.description}` : "";
						const marker = selectedTitles.has(opt.title)
							? theme.fg("success", "●")
							: theme.fg("dim", "○");
						text += `\n  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
					}
					if (response.comment) {
						text += `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
