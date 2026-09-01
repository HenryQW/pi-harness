/**
 * Pure query sanitization and SQL planning for session search.
 */
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";

export const MAX_QUERY_CHARS = 512;

const OPERATOR_RE = /\b(OR|AND|NOT|NEAR)\b/;
// FTS5 string syntax: `""` inside a quoted phrase is one literal quote.
const TOKEN_RE = /"((?:[^"]|"")*)"|(\S+)/g;
const unescapePhrase = (s: string): string => s.replaceAll('""', '"');

interface QueryTerm {
	text: string;
	operator: boolean;
	nearDistance: boolean;
	quoted: boolean;
}

function collectQueryTerms(query: string): QueryTerm[] {
	const terms: QueryTerm[] = [];
	let depth = 0;
	let pendingNear = false;
	let nearDepth = 0;
	let afterNearComma = false;
	for (const match of spaceParensOutsideQuotes(query).matchAll(TOKEN_RE)) {
		const phrase = match[1];
		let raw = phrase === undefined ? match[2] ?? "" : unescapePhrase(phrase);
		if (phrase === undefined && raw === "(") {
			depth++;
			if (pendingNear) {
				nearDepth = depth;
				pendingNear = false;
			}
			continue;
		}
		if (phrase === undefined && raw === ")") {
			if (depth === nearDepth) {
				nearDepth = 0;
				afterNearComma = false;
			}
			depth = Math.max(0, depth - 1);
			continue;
		}
		const hasNearComma = phrase === undefined && nearDepth > 0 && raw.endsWith(",");
		// An attached distance like `NEAR(Go Rust,10)` has no standalone comma
		// token; split it so the numeric tail is recognized as the distance.
		let attachedDistance: string | undefined;
		if (!hasNearComma && phrase === undefined && nearDepth > 0) {
			const attached = /^(.*),(\d+)$/.exec(raw);
			if (attached) {
				raw = attached[1];
				attachedDistance = attached[2];
			}
		}
		// Unmatched quote delimiters are malformed syntax, not searchable text.
		// Phrases arrive already unescaped via raw.
		const text = phrase === undefined ? raw.replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, "").replace(/"/g, "") : raw;
		if (text) {
			const operator = phrase === undefined && /^(?:OR|AND|NOT|NEAR)$/.test(text);
			const nearDistance = nearDepth > 0 && afterNearComma && /^\d+$/.test(text);
			terms.push({ text, operator, nearDistance, quoted: phrase !== undefined });
			if (operator && text === "NEAR") pendingNear = true;
		}
		if (attachedDistance !== undefined) terms.push({ text: attachedDistance, operator: false, nearDistance: true, quoted: false });
		if (hasNearComma) afterNearComma = true;
	}
	return terms;
}

function quoteTerm(term: QueryTerm): string {
	// Prefix expansion belongs only to an unquoted trailing star. An explicitly
	// quoted `"deploy*"` searches for the literal asterisk.
	if (!term.quoted && term.text.endsWith("*")) return `"${term.text.slice(0, -1).replace(/"/g, '""')}"*`;
	return `"${term.text.replace(/"/g, '""')}"`;
}

function quoteTerms(terms: QueryTerm[], sep: string): string {
	return terms.map(quoteTerm).join(sep);
}

interface FtsQueryPlan {
	/** Candidate FTS5 MATCH expressions in try order. */
	ftsCandidates: string[];
	/** When true, fall back to SQL LIKE (also forced when every term < 3 chars). */
	forceLike: boolean;
}

/**
 * Sanitize ladder: trim + 512 cap; implicit-AND quoting when no explicit
 * FTS5 operator; raw pass-through otherwise; recovery candidates are the
 * fully-quoted form, then OR-expansion; LIKE covers everything else.
 */
export function buildFtsQueryPlan(rawQuery: string): FtsQueryPlan {
	let query = rawQuery.trim();
	if (query.length > MAX_QUERY_CHARS) query = query.slice(0, MAX_QUERY_CHARS);
	if (!query) return { ftsCandidates: [], forceLike: false };

	const queryTerms = collectQueryTerms(query);
	const hasOperator = OPERATOR_RE.test(query);
	// Short terms vanish under trigram MATCH — for natural-language queries
	// (AND semantics) that silently breaks the query. Explicit-operator queries
	// route there too (`Go OR Rust` silently drops the Go side); the boolean
	// LIKE fallback preserves their AND/OR/NOT semantics.
	if (
		queryTerms.some(
			(term) => !term.operator && !term.nearDistance && [...term.text.replace(/["()*]/g, "")].length < 3,
		)
	) {
		return { ftsCandidates: [], forceLike: true };
	}

	const operands = queryTerms.filter((term) => !term.operator && !term.nearDistance);
	// Recovery operands exclude syntax operators so a malformed query can never
	// broaden into matches on AND/OR/NOT/NEAR themselves.
	const natural = quoteTerms(operands, " ");
	const orExpanded = operands.length > 1 ? quoteTerms(operands, " OR ") : null;

	if (!hasOperator) {
		// Quoted form cannot fail to parse; OR-expand only as breadth fallback.
		return { ftsCandidates: orExpanded ? [natural, orExpanded] : [natural], forceLike: false };
	}
	// Explicit operators: raw first, then recovery paths.
	const candidates = [query, natural];
	if (orExpanded) candidates.push(orExpanded);
	return { ftsCandidates: candidates, forceLike: false };
}

/** Unicode-aware case fold for all LIKE comparisons (column values via ulower,
 *  bound operand patterns, snippet matching). toLowerCase alone is not an
 *  equivalence for Greek: word-final Σ lowercases to ς while a typed query uses
 *  σ. ponytail: normalizes final sigma only, not full Unicode CaseFolding.txt
 *  (e.g. ß→ss stays unmatched); add a fold table if that ever matters. */
export function foldCase(s: string): string {
	return s.toLowerCase().replaceAll("ς", "σ");
}

function normalizeLikeTerm(term: string, quoted = false): string {
	// Only an unquoted trailing star is prefix syntax. Quoted stars stay literal.
	return !quoted && term.endsWith("*") ? term.slice(0, -1) : term;
}

function likePattern(term: string): string {
	// Fold here too: escaping is unaffected because % _ \ have no case variants.
	return `%${foldCase(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Parameterized translation of simple AND/OR/NOT/NEAR queries to SQL LIKE so
// short operands (trigram floor) keep boolean semantics. User input only ever
// reaches SQL as bound data.
function likeClause(term: string, quoted = false): { clause: string; params: string[] } | null {
	term = normalizeLikeTerm(term, quoted);
	if (!term) return null;
	const pattern = likePattern(term);
	return {
		clause: "(ulower(m.head) LIKE ? ESCAPE '\\' OR ulower(m.tail) LIKE ? ESCAPE '\\')",
		params: [pattern, pattern],
	};
}

interface LikeSql {
	where: string;
	params: SQLInputValue[];
}

/** Character-position analogue of trigram FTS5 NEAR for LIKE-only operands.
 *  Trigram positions make N allow at most N-2 characters between phrases. */
export function nearLike(textValue: SQLOutputValue, termsValue: SQLOutputValue, distanceValue: SQLOutputValue): number {
	if (typeof textValue !== "string" || typeof termsValue !== "string" || typeof distanceValue !== "number") return 0;
	// Duplicate operands cannot affect the all-distinct-terms-present predicate,
	// and the 512-char query cap otherwise admits hundreds of them.
	const needles = [...new Set((JSON.parse(termsValue) as string[]).map(foldCase))];
	const text = foldCase(textValue);
	// Deduplication can leave one needle: presence satisfies any distance,
	// while the multi-needle span math below demands an impossible negative gap.
	if (needles.length === 1) return text.includes(needles[0]) ? 1 : 0;
	const codePointAt = new Uint32Array(text.length + 1);
	let point = 0;
	for (let i = 0; i < text.length; point++) {
		const width = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
		codePointAt[i] = point;
		if (width === 2) codePointAt[i + 1] = point;
		i += width;
	}
	codePointAt[text.length] = point;

	const occurrences: { start: number; end: number; term: number }[] = [];
	for (const [term, needle] of needles.entries()) {
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
			occurrences.push({ start: codePointAt[at], end: codePointAt[at + needle.length], term });
		}
	}
	occurrences.sort((a, b) => a.start - b.start || a.end - b.end);

	const counts = new Uint16Array(needles.length);
	let present = 0;
	let left = 0;
	for (let right = 0; right < occurrences.length; right++) {
		if (counts[occurrences[right].term]++ === 0) present++;
		while (present === needles.length) {
			if (occurrences[right].start - occurrences[left].end + 2 <= distanceValue) return 1;
			if (--counts[occurrences[left++].term] === 0) present--;
		}
	}
	return 0;
}

interface LikeToken {
	phrase?: string;
	word?: string;
}

function parseNearLikeSql(tokens: LikeToken[], start: number): { sql: LikeSql; end: number } | null {
	if (tokens[start + 1]?.word !== "(") return null;
	const operands: { text: string; quoted: boolean }[] = [];
	let sawComma = false;
	let distanceText: string | undefined;

	for (let i = start + 2; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.word === ")") {
			if (operands.length < 2 || (sawComma && distanceText === undefined)) return null;
			const distance = distanceText === undefined ? 10 : Number(distanceText);
			if (distanceText !== undefined && (!/^\d+$/.test(distanceText) || !Number.isSafeInteger(distance))) return null;
			const terms = operands.map((term) => normalizeLikeTerm(term.text, term.quoted));
			if (terms.some((term) => !term)) return null;
			const clauses = terms.map((term) => likeClause(term, true)!);
			const encoded = JSON.stringify(terms);
			return {
				sql: {
					where: `(${clauses.map((clause) => clause.clause).join(" AND ")} AND (unear(m.head, ?, ?) OR unear(m.tail, ?, ?)))`,
					params: [...clauses.flatMap((clause) => clause.params), encoded, distance, encoded, distance],
				},
				end: i,
			};
		}
		if (token.phrase !== undefined) {
			if (sawComma) return null;
			operands.push({ text: token.phrase, quoted: true });
			continue;
		}

		const word = token.word ?? "";
		if (!word || word === "(" || /^(?:AND|OR|NOT|NEAR)$/.test(word) || word.includes('"')) return null;
		const comma = word.indexOf(",");
		if (comma >= 0) {
			if (sawComma || word.indexOf(",", comma + 1) >= 0) return null;
			const before = word.slice(0, comma).replace(/^[.!?;:]+|[.!?;:]+$/g, "");
			if (before) operands.push({ text: before, quoted: false });
			sawComma = true;
			distanceText = word.slice(comma + 1) || undefined;
		} else if (sawComma) {
			if (distanceText !== undefined) return null;
			distanceText = word;
		} else {
			const text = word.replace(/^[.!?;:]+|[.!?;:]+$/g, "");
			if (!text) return null;
			operands.push({ text, quoted: false });
		}
	}
	return null;
}

/** Space out parens that act as grouping syntax while leaving quoted phrases
 *  like "C(ABI)" intact. */
function spaceParensOutsideQuotes(q: string): string {
	let out = "";
	let inQuote = false;
	for (const c of q) {
		if (c === '"') inQuote = !inQuote;
		out += !inQuote && (c === "(" || c === ")") ? ` ${c} ` : c;
	}
	return out;
}

function buildBooleanLikeSql(rawQuery: string): LikeSql | null {
	let query = rawQuery.trim();
	if (!query) return null;
	// Imbalance detection/recovery is quote-aware: parentheses inside quoted
	// operands ("func(") are literals and must survive.
	let depth = 0;
	let inQuote = false;
	for (const c of query) {
		if (c === '"') inQuote = !inQuote;
		else if (!inQuote && c === "(") depth++;
		else if (!inQuote && c === ")" && --depth < 0) break;
	}
	if (depth !== 0) {
		inQuote = false;
		query = [...query].map((c) => {
			if (c === '"') inQuote = !inQuote;
			return !inQuote && (c === "(" || c === ")") ? " " : c;
		}).join("");
	}

	const tokens: LikeToken[] = [...spaceParensOutsideQuotes(query).matchAll(TOKEN_RE)]
		.map((m) => (m[1] !== undefined ? { phrase: unescapePhrase(m[1]) } : { word: m[2] ?? "" }))
		.filter((t) => (t.phrase !== undefined ? t.phrase !== "" : t.word !== ""));
	const fail = (): LikeSql | null => tokens.some((token) => token.word === "NEAR") ? { where: "0", params: [] } : null;
	const sql: string[] = [];
	const params: SQLInputValue[] = [];
	let expectingOperand = true;
	depth = 0;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const word = token.word;
		if (word === "(") {
			if (!expectingOperand) sql.push("AND");
			sql.push("(");
			depth++;
			expectingOperand = true;
			continue;
		}
		if (word === ")") {
			if (expectingOperand || depth-- === 0) return fail();
			sql.push(")");
			expectingOperand = false;
			continue;
		}
		if (word === "AND" || word === "OR") {
			if (expectingOperand) return fail();
			sql.push(word);
			expectingOperand = true;
			continue;
		}
		if (word === "NOT") {
			if (!expectingOperand) sql.push("AND");
			sql.push("NOT");
			expectingOperand = true;
			continue;
		}
		if (word === "NEAR") {
			const near = parseNearLikeSql(tokens, i);
			if (near === null) return fail();
			if (!expectingOperand) sql.push("AND");
			sql.push(near.sql.where);
			params.push(...near.sql.params);
			expectingOperand = false;
			i = near.end;
			continue;
		}

		const term = token.phrase ?? word?.replace(/^[.,!?;:]+|[.,!?;:]+$/g, "").replace(/"/g, "") ?? "";
		const clause = likeClause(term, token.phrase !== undefined);
		if (clause === null) return fail();
		if (!expectingOperand) sql.push("AND");
		sql.push(clause.clause);
		params.push(...clause.params);
		expectingOperand = false;
	}

	return expectingOperand || depth !== 0 ? fail() : { where: sql.join(" "), params };
}

interface LikeQueryPlan extends LikeSql {
	terms: string[];
}

export function buildLikeQueryPlan(rawQuery: string): LikeQueryPlan | null {
	const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
	// Keep quoted operator words as operands and omit NEAR's optional numeric
	// distance; only unquoted syntax tokens are excluded.
	const terms = collectQueryTerms(query)
		.filter((term) => !term.operator && !term.nearDistance)
		.map((term) => normalizeLikeTerm(term.text, term.quoted))
		.filter(Boolean);
	if (terms.length === 0) return null;

	// Boolean LIKE preserves simple AND/OR/NOT; unsupported shapes degrade
	// to AND-of-terms. Both forms are fully parameterized.
	const bool = buildBooleanLikeSql(query);
	return {
		terms,
		where: bool?.where ?? terms.map(() => "(ulower(m.head) LIKE ? ESCAPE '\\' OR ulower(m.tail) LIKE ? ESCAPE '\\')").join(" AND "),
		params: bool?.params ?? terms.flatMap((term) => [likePattern(term), likePattern(term)]),
	};
}
