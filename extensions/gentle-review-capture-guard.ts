// gentle-review-capture-guard — local Pi extension, tripwire for a retyped capture binding.
// Evaluation: `odd/tasks/capture-binding-tripwire-evaluation.md` (gentle-shell-parch working copy,
// 2026-10-18). Delete this file once the mirrored contract stops needing the reminder.
//
// Why: a provider-issued collect binding is opaque and its digest is checked by the tooling, so an
// agent that rewrote it — putting the number 1 or the boolean true where the provider emitted the
// string "1" or "true" — can only answer `capture-binding-rejected`, and the rejection never names
// the cause. One session burned five blind retries on it.
//
// What: a `tool_call` handler that inspects `collectBinding` and each item of `collectBindings` of
// `gentle_review_capture` / `gentle_review_capture_group`, and blocks when a binding's top-level
// scalars mix a string with a number or a boolean. A provider collect input carries every top-level
// scalar as a string (`ReviewCollectInputV3`: name, schema, captureOperation, baseTree, candidateTree),
// so that mix is a rewritten binding and nothing else.
//
// Never repairs a value: the original is not in the extension, so guessing one would only mint a
// second wrong digest. The block names the key and the value and asks for a verbatim re-copy; no
// code path writes `event.input` or any binding.
//
// Scope: those two tools and those two fields only. A serialized JSON string binding is left exactly
// as it arrived: it is not parsed, re-serialized or replaced.
//
// Fail-open: every path is wrapped, so an internal error passes the call through unchanged and the
// controller reports its own rejection, like gentle-review-start-repair.ts.
//
// Debug: `GENTLE_AI_DEBUG_BINDING_GUARD=1` writes one stderr line per block or swallowed failure.
// Install: it ships inside the `pi-warden-gs` package and is registered in its `package.json`
// (`pi.extensions`), so Pi loads `extensions/gentle-review-capture-guard.ts` from this package at
// startup; `/reload` activates it in a session that is already open.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The only two tools whose bindings are inspected. */
export const CAPTURE_TOOLS: readonly string[] = ["gentle_review_capture", "gentle_review_capture_group"];

const DEBUG_ENV = "GENTLE_AI_DEBUG_BINDING_GUARD";

export interface CaptureBindingViolation {
	/** The inspected field, as the call spells it. */
	readonly field: "collectBinding" | "collectBindings";
	/** Position inside `collectBindings`; -1 for the single `collectBinding`. */
	readonly index: number;
	/** Key of the top-level scalar that arrived as a number or a boolean. */
	readonly key: string;
	readonly value: number | boolean;
}

/**
 * The first top-level scalar of `binding` that is a number or a boolean while at least one sibling
 * is a string, or undefined when the binding carries no such mix. Pure and read-only: it writes
 * nothing, and it raises only when reading a binding throws (a hostile getter), which the caller
 * turns into a pass-through.
 */
export function retypedBindingScalar(binding: unknown): { key: string; value: number | boolean } | undefined {
	if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return undefined;
	const entries = Object.entries(binding as Record<string, unknown>);
	if (!entries.some(([, value]) => typeof value === "string")) return undefined;
	const offender = entries.find(([, value]) => typeof value === "number" || typeof value === "boolean");
	return offender === undefined ? undefined : { key: offender[0], value: offender[1] as number | boolean };
}

/**
 * The first retyped binding a capture call carries, or undefined when it carries none. `collectBinding`
 * is inspected first, then each item of `collectBindings` in the order the call declares them.
 */
export function findCaptureBindingViolation(toolName: string, input: unknown): CaptureBindingViolation | undefined {
	if (!CAPTURE_TOOLS.includes(toolName)) return undefined;
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const parameters = input as Record<string, unknown>;
	const single = retypedBindingScalar(parameters.collectBinding);
	if (single !== undefined) {
		return { field: "collectBinding", index: -1, key: single.key, value: single.value };
	}
	const group = parameters.collectBindings;
	if (!Array.isArray(group)) return undefined;
	for (let index = 0; index < group.length; index += 1) {
		const offender = retypedBindingScalar(group[index]);
		if (offender !== undefined) {
			return { field: "collectBindings", index, key: offender.key, value: offender.value };
		}
	}
	return undefined;
}

/** The block message: the cause, the key, the value, and the only correct repair — a verbatim re-copy. */
export function captureBindingBlockReason(toolName: string, violation: CaptureBindingViolation): string {
	const where = violation.field === "collectBinding" ? "collectBinding" : `collectBindings[${violation.index}]`;
	const { key, value } = violation;
	return (
		`gentle-review-capture-guard: ${toolName} is blocked because ${where} carries the ${typeof value} ${String(value)} ` +
		`at "${key}" while its other scalars are strings: the binding was rewritten instead of re-sent, so its digest no longer matches. ` +
		`Never repair, re-serialize or normalize it: run review status again, re-copy the binding verbatim exactly as the provider emitted it, ` +
		`and call ${toolName} once.`
	);
}

function debugLog(message: string): void {
	if (process.env[DEBUG_ENV] !== "1") return;
	try {
		process.stderr.write(`[gentle-review-capture-guard] ${message}\n`);
	} catch {
		// Observability must never affect the call.
	}
}

export default function gentleReviewCaptureGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event) => {
		try {
			const violation = findCaptureBindingViolation(event.toolName, event.input);
			if (violation === undefined) return;
			const reason = captureBindingBlockReason(event.toolName, violation);
			debugLog(`blocked ${event.toolName}: ${reason}`);
			return { block: true, reason };
		} catch (error) {
			// Fail-open: an unobservable check must not cost the call its chance of succeeding.
			debugLog(`passed through unchanged after error: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}