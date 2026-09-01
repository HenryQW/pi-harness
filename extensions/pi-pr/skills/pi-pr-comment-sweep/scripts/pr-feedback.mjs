#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PR_FIELDS = "number,url,title,state,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeStateStatus,statusCheckRollup";
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/;
const READ_ATTEMPTS = 3;

const FEEDBACK_QUERY = `
query Feedback($owner:String!,$repo:String!,$number:Int!,$commentsCursor:String,$reviewsCursor:String,$threadsCursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    comments(first:100,after:$commentsCursor){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
    reviews(first:100,after:$reviewsCursor){pageInfo{hasNextPage endCursor} nodes{id url state body submittedAt author{login}}}
    reviewThreads(first:100,after:$threadsCursor){pageInfo{hasNextPage endCursor} nodes{
      id isResolved isOutdated path line diffSide startLine startDiffSide originalLine originalStartLine
      comments(first:100){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
    }}
  }}
}`;

const THREAD_REPLIES_QUERY = `
query ThreadReplies($threadId:ID!,$cursor:String){node(id:$threadId){... on PullRequestReviewThread{
  comments(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id url body createdAt author{login}}}
}}}`;

const THREAD_STATES_QUERY = `
query ThreadStates($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){
    reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved}}
  }}
}`;

const RESOLVE_THREAD_MUTATION = `
mutation ResolveThread($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;

class FeedbackError extends Error {}
class UsageError extends Error {}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label) {
  if (typeof value !== "string") throw new FeedbackError(`${label} must be a string`);
  return value;
}

function requiredText(value, label) {
  const result = text(value, label);
  if (!result) throw new FeedbackError(`${label} is missing`);
  return result;
}

function bool(value, label) {
  if (typeof value !== "boolean") throw new FeedbackError(`${label} must be a boolean`);
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) throw new FeedbackError(`${label} must be an array`);
  return value;
}

function run(program, args, input) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new FeedbackError(`${program} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new FeedbackError(`${program} ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function jsonCommand(program, args, input) {
  const output = run(program, args, input);
  try {
    const value = JSON.parse(output);
    if (!isRecord(value)) throw new Error("root is not an object");
    return value;
  } catch (error) {
    throw new FeedbackError(`invalid JSON from ${program}: ${error.message}`);
  }
}

function retryableReadFailure(error) {
  return /\b5(?:\d\d|xx)\b|tls|ssl|x509|certificate|handshake/i.test(error instanceof Error ? error.message : String(error));
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryRead(read, report = console.error) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read();
    } catch (error) {
      if (attempt === READ_ATTEMPTS - 1 || !retryableReadFailure(error)) throw error;
      report(`retrying read-only GitHub request (${attempt + 1}/${READ_ATTEMPTS - 1})`);
      sleep(250 * (attempt + 1));
    }
  }
}

function readJsonCommand(program, args, input) {
  return retryRead(() => jsonCommand(program, args, input));
}

function git(...args) {
  return run("git", args).trim();
}

function requireGh() {
  run("gh", ["auth", "status"]);
}

function cleanHead() {
  git("rev-parse", "--show-toplevel");
  const states = [
    ["merge", "MERGE_HEAD"],
    ["rebase", "rebase-merge"],
    ["rebase", "rebase-apply"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
    ["sequenced cherry-pick or revert", "sequencer"],
  ];
  for (const [operation, state] of states) {
    const path = requiredText(git("rev-parse", "--git-path", state), `${operation} state path`);
    if (lstatSync(path, { throwIfNoEntry: false })) throw new FeedbackError(`${operation} is in progress`);
  }
  if (git("status", "--porcelain")) throw new FeedbackError("index and worktree must be clean");
  return requiredText(git("rev-parse", "HEAD"), "local HEAD");
}

function parsePrUrl(value, label = "PR URL") {
  const url = requiredText(value, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FeedbackError(`unsupported ${label}: ${url}`);
  }
  const match = PR_PATH.exec(parsed.pathname);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !match || !parsed.hostname) {
    throw new FeedbackError(`unsupported ${label}: ${url}`);
  }
  return {
    url: parsed.toString(),
    hostname: parsed.hostname.toLowerCase(),
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function validatePrRef(pr) {
  if (pr === undefined || /^[1-9][0-9]*$/.test(pr)) return;
  try {
    parsePrUrl(pr, "--pr");
  } catch {
    throw new UsageError("--pr must be a positive PR number or https://HOST/OWNER/REPO/pull/NUMBER");
  }
}

function prTarget(metadata, label) {
  if (!isRecord(metadata)) throw new FeedbackError(`${label} is invalid`);
  const parsed = parsePrUrl(metadata.url, `${label} URL`);
  if (!Number.isInteger(metadata.number) || metadata.number !== parsed.number) {
    throw new FeedbackError(`${label} number does not match URL`);
  }
  const hostname = requiredText(metadata.hostname, `${label} hostname`).toLowerCase();
  if (hostname !== parsed.hostname) throw new FeedbackError(`${label} hostname does not match URL`);
  if (!isRecord(metadata.headRepository)) throw new FeedbackError(`${label} head repository identity is unavailable`);
  return {
    number: metadata.number,
    url: parsed.url,
    hostname,
    baseRefName: requiredText(metadata.baseRefName, `${label} base ref`),
    baseRefOid: requiredText(metadata.baseRefOid, `${label} base OID`),
    headRepository: requiredText(metadata.headRepository.nameWithOwner, `${label} head repository`),
    headRefName: requiredText(metadata.headRefName, `${label} head ref`),
    headRefOid: requiredText(metadata.headRefOid, `${label} head OID`),
  };
}

function requireSamePr(expected, current, includeHeadOid = true) {
  const fields = [
    ["number", "number"],
    ["hostname", "hostname"],
    ["url", "URL"],
    ["baseRefName", "base ref"],
    ["baseRefOid", "base OID"],
    ["headRepository", "head repository"],
    ["headRefName", "head ref"],
  ];
  if (includeHeadOid) fields.push(["headRefOid", "head OID"]);
  for (const [field, name] of fields) {
    if (expected[field] !== current[field]) {
      throw new FeedbackError(`PR ${name} changed since feedback fetch: ${expected[field]} -> ${current[field]}`);
    }
  }
}

function readOpenPr(pr) {
  const args = ["pr", "view"];
  if (pr !== undefined) args.push(pr);
  args.push("--json", PR_FIELDS);
  const value = readJsonCommand("gh", args);
  if (value.state !== "OPEN") throw new FeedbackError(`PR must be OPEN, got ${JSON.stringify(value.state)}`);

  const parsed = parsePrUrl(value.url);
  const metadata = {
    ...value,
    url: parsed.url,
    hostname: parsed.hostname,
    baseRepository: `${parsed.owner}/${parsed.repo}`,
  };
  prTarget(metadata, "PR");
  requiredText(metadata.mergeStateStatus, "PR merge state");
  list(metadata.statusCheckRollup, "PR status checks");
  return metadata;
}

function requireMatchingHead(metadata, localHead) {
  if (metadata.headRefOid !== localHead) {
    throw new FeedbackError(`local HEAD ${localHead} does not match PR head ${metadata.headRefOid}`);
  }
}

function discoveryPushRemote(pr, metadata) {
  if (pr !== undefined) return null;
  const branch = git("branch", "--show-current");
  if (!branch) throw new FeedbackError("current HEAD is detached");
  const target = git(
    "for-each-ref",
    "--format=%(push:remotename)%00%(push:short)",
    `refs/heads/${branch}`,
  ).split("\0");
  if (target.length !== 2 || !target[0] || !target[1]) {
    throw new FeedbackError(`local branch ${JSON.stringify(branch)} has no configured push target`);
  }
  const [remote, push] = target;
  if (!push.startsWith(`${remote}/`)) throw new FeedbackError("configured push target is invalid");
  const ref = push.slice(remote.length + 1);
  const checkedRef = git("check-ref-format", "--branch", ref);
  if (checkedRef !== ref) throw new FeedbackError("configured push ref is invalid");
  const headRef = requiredText(metadata.headRefName, "PR head ref");
  if (ref !== headRef) {
    throw new FeedbackError(`configured push ref ${JSON.stringify(ref)} does not match PR head ref ${JSON.stringify(headRef)}`);
  }
  const matchingRemote = pushRemote(metadata.headRepository.nameWithOwner, metadata.hostname);
  if (remote !== matchingRemote) {
    throw new FeedbackError(`configured push remote ${JSON.stringify(remote)} does not match PR head repository`);
  }
  return matchingRemote;
}

function graphqlArgs(hostname, variables) {
  const args = ["api", "graphql", "--hostname", requiredText(hostname, "GitHub hostname"), "-F", "query=@-"];
  for (const [name, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push("-F", `${name}=${value}`);
  }
  return args;
}

function graphqlResponse(query, variables, hostname) {
  const response = jsonCommand("gh", graphqlArgs(hostname, variables), query);
  if (response.errors && (!Array.isArray(response.errors) || response.errors.length)) {
    throw new FeedbackError(`GitHub GraphQL errors: ${JSON.stringify(response.errors)}`);
  }
  if (!isRecord(response.data)) throw new FeedbackError("GitHub GraphQL response has no data");
  return response.data;
}

function readGraphql(query, variables, hostname) {
  return retryRead(() => graphqlResponse(query, variables, hostname));
}

function writeGraphql(query, variables, hostname) {
  return graphqlResponse(query, variables, hostname);
}

function pullRequest(data) {
  if (!isRecord(data.repository) || !isRecord(data.repository.pullRequest)) {
    throw new FeedbackError("pull request disappeared");
  }
  return data.repository.pullRequest;
}

function connection(value, label) {
  if (!isRecord(value) || !isRecord(value.pageInfo)) throw new FeedbackError(`invalid ${label} connection`);
  const nodes = list(value.nodes, `${label} nodes`);
  const hasNextPage = bool(value.pageInfo.hasNextPage, `${label} hasNextPage`);
  const endCursor = value.pageInfo.endCursor;
  if (hasNextPage && (typeof endCursor !== "string" || !endCursor)) {
    throw new FeedbackError(`missing pagination cursor for ${label}`);
  }
  return { nodes, hasNextPage, endCursor };
}

function collectFeedback(metadata, request = readGraphql) {
  const [owner, repo] = metadata.baseRepository.split("/", 2);
  const targets = [
    { key: "conversationComments", field: "comments", cursor: "commentsCursor", label: "conversation comments" },
    { key: "reviews", field: "reviews", cursor: "reviewsCursor", label: "reviews" },
    { key: "reviewThreads", field: "reviewThreads", cursor: "threadsCursor", label: "review threads" },
  ];
  const results = Object.fromEntries(targets.map(({ key }) => [key, []]));
  const cursors = Object.fromEntries(targets.map(({ key }) => [key, null]));
  const pending = new Set(targets.map(({ key }) => key));

  while (pending.size) {
    const data = request(FEEDBACK_QUERY, {
      owner,
      repo,
      number: metadata.number,
      commentsCursor: cursors.conversationComments,
      reviewsCursor: cursors.reviews,
      threadsCursor: cursors.reviewThreads,
    }, metadata.hostname);
    const pr = pullRequest(data);
    for (const target of targets) {
      if (!pending.has(target.key)) continue;
      const page = connection(pr[target.field], target.label);
      results[target.key].push(...page.nodes);
      if (page.hasNextPage) {
        cursors[target.key] = page.endCursor;
      } else {
        pending.delete(target.key);
      }
    }
  }

  results.reviewThreads = results.reviewThreads.map((thread) => collectReplies(thread, request, metadata.hostname));
  return {
    pullRequest: metadata,
    conversationComments: results.conversationComments,
    reviews: results.reviews,
    reviewThreads: results.reviewThreads,
  };
}

function collectReplies(thread, request, hostname) {
  if (!isRecord(thread)) throw new FeedbackError("invalid review thread");
  const threadId = requiredText(thread.id, "review thread ID");
  let page = connection(thread.comments, `replies for ${threadId}`);
  const comments = [...page.nodes];
  while (page.hasNextPage) {
    const data = request(THREAD_REPLIES_QUERY, { threadId, cursor: page.endCursor }, hostname);
    if (!isRecord(data.node)) throw new FeedbackError(`review thread disappeared: ${threadId}`);
    page = connection(data.node.comments, `replies for ${threadId}`);
    comments.push(...page.nodes);
  }
  return { ...thread, comments };
}

function collectThreadStates(metadata, request = readGraphql) {
  const [owner, repo] = metadata.baseRepository.split("/", 2);
  const states = new Map();
  let cursor = null;
  for (;;) {
    const data = request(THREAD_STATES_QUERY, { owner, repo, number: metadata.number, cursor }, metadata.hostname);
    const page = connection(pullRequest(data).reviewThreads, "review threads");
    for (const thread of page.nodes) {
      if (!isRecord(thread)) throw new FeedbackError("invalid review thread state");
      states.set(requiredText(thread.id, "review thread ID"), bool(thread.isResolved, "review thread isResolved"));
    }
    if (!page.hasNextPage) return states;
    cursor = page.endCursor;
  }
}

function resolveThread(threadId, hostname, mutate = writeGraphql) {
  const data = mutate(RESOLVE_THREAD_MUTATION, { threadId }, hostname);
  const result = data.resolveReviewThread;
  if (!isRecord(result) || !isRecord(result.thread)) throw new FeedbackError(`failed to resolve ${threadId}`);
  if (result.thread.id !== threadId || result.thread.isResolved !== true) {
    throw new FeedbackError(`GitHub did not resolve ${threadId}`);
  }
}

function parsedSnapshot(raw, path) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new FeedbackError(`invalid feedback JSON ${path}: ${error.message}`);
  }
  if (!isRecord(value) || !isRecord(value.pullRequest) || !Array.isArray(value.conversationComments) || !Array.isArray(value.reviews) || !Array.isArray(value.reviewThreads)) {
    throw new FeedbackError(`invalid feedback JSON ${path}`);
  }
  parsePrUrl(value.pullRequest.url, "snapshot PR URL");
  return value;
}

function snapshot(path) {
  try {
    return parsedSnapshot(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    throw new FeedbackError(`invalid feedback JSON ${path}: ${error.message}`);
  }
}

function previousSnapshot(path) {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    return parsedSnapshot(raw, path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof FeedbackError) throw error;
    throw new FeedbackError(`invalid feedback JSON ${path}: ${error.message}`);
  }
}

function nodeIds(nodes, label) {
  return nodes.map((node, index) => {
    if (!isRecord(node)) throw new FeedbackError(`invalid ${label} ${index + 1}`);
    return requiredText(node.id, `${label} ID`);
  });
}

function threadBuckets(threads) {
  const resolved = [];
  const outdated = [];
  const openCurrent = [];
  for (const thread of threads) {
    if (!isRecord(thread)) throw new FeedbackError("invalid review thread");
    if (bool(thread.isResolved, "review thread isResolved")) resolved.push(thread);
    else if (bool(thread.isOutdated, "review thread isOutdated")) outdated.push(thread);
    else openCurrent.push(thread);
  }
  return { resolved, outdated, openCurrent };
}

function login(author) {
  if (author === null) return "-";
  if (!isRecord(author)) throw new FeedbackError("comment author is invalid");
  return requiredText(author.login, "comment author login");
}

function location(thread) {
  const path = thread.path === null ? "-" : text(thread.path, "thread path");
  const line = Number.isInteger(thread.line)
    ? thread.line
    : Number.isInteger(thread.originalLine)
      ? thread.originalLine
      : "-";
  return `${path}:${line}`;
}

function checkBucket(check) {
  if (!isRecord(check)) throw new FeedbackError("invalid PR status check");
  if (typeof check.status === "string" && check.status !== "COMPLETED") return "pending";
  if (typeof check.state === "string") {
    if (check.state === "SUCCESS") return "passing";
    return ["ERROR", "FAILURE", "STALE"].includes(check.state) ? "failing" : "pending";
  }
  if (check.conclusion === null || check.conclusion === undefined || check.conclusion === "") return "pending";
  const conclusion = text(check.conclusion, "PR status check conclusion");
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "passing";
  return ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STALE", "STARTUP_FAILURE", "TIMED_OUT"].includes(conclusion) ? "failing" : "pending";
}

function checkSummary(metadata) {
  const summary = { passing: 0, pending: 0, failing: 0 };
  for (const check of list(metadata.statusCheckRollup, "PR status checks")) summary[checkBucket(check)] += 1;
  return summary;
}

function printPrStatus(metadata, log = console.log) {
  const checks = checkSummary(metadata);
  log(`merge_state=${requiredText(metadata.mergeStateStatus, "PR merge state")} checks_total=${checks.passing + checks.pending + checks.failing} passing=${checks.passing} pending=${checks.pending} failing=${checks.failing}`);
}

function printComments(label, comments, log) {
  log(`${label}=comment\tauthor\tbody`);
  for (const comment of comments) {
    if (!isRecord(comment)) throw new FeedbackError("invalid conversation comment");
    log([requiredText(comment.id, "conversation comment ID"), login(comment.author), JSON.stringify(text(comment.body, "conversation comment body"))].join("\t"));
  }
}

function printReviews(label, reviews, log) {
  log(`${label}=review\tstate\tauthor\tbody`);
  for (const review of reviews) {
    if (!isRecord(review)) throw new FeedbackError("invalid review");
    log([requiredText(review.id, "review ID"), requiredText(review.state, "review state"), login(review.author), JSON.stringify(text(review.body, "review body"))].join("\t"));
  }
}

function printThreads(label, threads, log) {
  log(`${label}=thread\tstate\tlocation\tcomment\tauthor\tbody`);
  for (const thread of threads) {
    const threadId = requiredText(thread.id, "review thread ID");
    const prefix = [threadId, threadState(thread), location(thread)];
    const comments = list(thread.comments, `replies for ${threadId}`);
    if (!comments.length) log([...prefix, "-", "-", "-"].join("\t"));
    for (const comment of comments) {
      if (!isRecord(comment)) throw new FeedbackError(`invalid comment in ${threadId}`);
      log([...prefix, requiredText(comment.id, "comment ID"), login(comment.author), JSON.stringify(text(comment.body, "comment body"))].join("\t"));
    }
  }
}

function threadState(thread) {
  if (bool(thread.isResolved, "review thread isResolved")) return "resolved";
  return bool(thread.isOutdated, "review thread isOutdated") ? "outdated" : "current";
}

function printFeedbackDelta(data, previous, log) {
  const oldComments = new Map(previous.conversationComments.map((comment) => [requiredText(comment.id, "previous conversation comment ID"), comment]));
  const oldReviews = new Map(previous.reviews.map((review) => [requiredText(review.id, "previous review ID"), review]));
  const oldThreads = new Map(previous.reviewThreads.map((thread) => [requiredText(thread.id, "previous review thread ID"), thread]));
  const changed = (node, old, fields) => old && fields.some((field) => node[field] !== old[field]);
  const newComments = data.conversationComments.filter((comment) => !oldComments.has(comment.id));
  const updatedComments = data.conversationComments.filter((comment) => changed(comment, oldComments.get(comment.id), ["body"]));
  const newReviews = data.reviews.filter((review) => !oldReviews.has(review.id));
  const updatedReviews = data.reviews.filter((review) => changed(review, oldReviews.get(review.id), ["state", "body"]));
  const newThreads = data.reviewThreads.filter((thread) => !oldThreads.has(thread.id));
  const newReplies = [];
  const updatedReplies = [];
  const stateChanges = [];

  for (const thread of data.reviewThreads) {
    const oldThread = oldThreads.get(thread.id);
    if (!oldThread) continue;
    const oldReplies = new Map(list(oldThread.comments, `previous replies for ${thread.id}`).map((reply) => [requiredText(reply.id, "previous reply ID"), reply]));
    const replies = list(thread.comments, `replies for ${thread.id}`);
    const added = replies.filter((reply) => !oldReplies.has(reply.id));
    const updated = replies.filter((reply) => changed(reply, oldReplies.get(reply.id), ["body"]));
    if (added.length) newReplies.push({ ...thread, comments: added });
    if (updated.length) updatedReplies.push({ ...thread, comments: updated });
    const before = threadState(oldThread);
    const after = threadState(thread);
    if (before !== after) stateChanges.push([thread.id, before, after]);
  }

  if (newComments.length) printComments("new_conversation_comments", newComments, log);
  if (updatedComments.length) printComments("updated_conversation_comments", updatedComments, log);
  if (newReviews.length) printReviews("new_reviews", newReviews, log);
  if (updatedReviews.length) printReviews("updated_reviews", updatedReviews, log);
  if (newThreads.length) printThreads("new_threads", newThreads, log);
  if (newReplies.length) printThreads("new_replies", newReplies, log);
  if (updatedReplies.length) printThreads("updated_replies", updatedReplies, log);
  if (stateChanges.length) {
    log("thread_state_changes=thread\tbefore\tafter");
    for (const change of stateChanges) log(change.join("\t"));
  }
  if (![newComments, updatedComments, newReviews, updatedReviews, newThreads, newReplies, updatedReplies, stateChanges].some((items) => items.length)) log("feedback_delta=none");
}

function printFetchSummary(data, previous, out, log = console.log) {
  const { resolved, outdated, openCurrent } = threadBuckets(data.reviewThreads);
  log(`snapshot=${out}`);
  log(`counts comments=${data.conversationComments.length} reviews=${data.reviews.length} threads=${data.reviewThreads.length} open_current=${openCurrent.length} outdated=${outdated.length}`);
  printPrStatus(data.pullRequest, log);
  if (previous) {
    printFeedbackDelta(data, previous, log);
    return;
  }
  printComments("conversation_comments", data.conversationComments, log);
  printReviews("reviews", data.reviews, log);
  printThreads("open_current_threads", openCurrent, log);
  printThreads("outdated_threads", outdated, log);
  log(`resolved_thread_ids=${nodeIds(resolved, "resolved review thread").join(",") || "-"}`);
}

function writeSnapshot(path, data) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(data)}\n`);
  return destination;
}

function fetchFeedback(options) {
  requireGh();
  const out = options.json ? null : resolve(options.out);
  const previous = out ? previousSnapshot(out) : null;
  const localHead = cleanHead();
  const initial = readOpenPr(options.pr);
  if (previous && parsePrUrl(previous.pullRequest.url, "snapshot PR URL").url !== initial.url) {
    throw new FeedbackError(`existing feedback JSON belongs to ${previous.pullRequest.url}, not ${initial.url}`);
  }
  requireMatchingHead(initial, localHead);
  discoveryPushRemote(options.pr, initial);
  const data = collectFeedback(initial);
  const current = readOpenPr(initial.url);
  if (current.headRefOid !== initial.headRefOid) {
    throw new FeedbackError(`PR head changed during fetch: ${initial.headRefOid} -> ${current.headRefOid}`);
  }
  requireMatchingHead(current, localHead);
  const complete = {
    ...data,
    pullRequest: current,
    openCurrentThreads: threadBuckets(data.reviewThreads).openCurrent,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(complete)}\n`);
    return;
  }
  const saved = writeSnapshot(out, complete);
  printFetchSummary(complete, previous, saved);
}

function currentExpectedHead(pr, expectedHead) {
  const localHead = cleanHead();
  if (localHead !== expectedHead) {
    throw new FeedbackError(`local HEAD ${localHead} does not match expected head ${expectedHead}`);
  }
  const metadata = readOpenPr(pr);
  if (metadata.headRefOid !== expectedHead) {
    throw new FeedbackError(`PR head ${metadata.headRefOid} does not match expected head ${expectedHead}`);
  }
  return metadata;
}

function resolveFeedback(options) {
  requireGh();
  let metadata = currentExpectedHead(options.pr, options.expectedHead);
  const states = collectThreadStates(metadata);
  const requested = options.threads;
  const missing = requested.filter((threadId) => !states.has(threadId));
  if (missing.length) throw new FeedbackError(`review thread IDs not found: ${missing.join(",")}`);

  metadata = currentExpectedHead(metadata.url, options.expectedHead);
  for (const threadId of requested) {
    if (!states.get(threadId)) resolveThread(threadId, metadata.hostname);
  }

  metadata = currentExpectedHead(metadata.url, options.expectedHead);
  const verified = collectThreadStates(metadata);
  const unresolved = requested.filter((threadId) => verified.get(threadId) !== true);
  if (unresolved.length) throw new FeedbackError(`resolution verification failed: ${unresolved.join(",")}`);
  console.log(`resolved_thread_ids=${requested.join(",")}`);
}

function githubRemote(url, hostname) {
  const expected = requiredText(hostname, "PR hostname").toLowerCase();
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (scp) return scp[1].toLowerCase() === expected ? `${scp[2]}/${scp[3]}`.toLowerCase() : null;
  try {
    const parsed = new URL(url);
    if (!["ssh:", "https:"].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== expected || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

function selectPushRemote(repository, hostname, remotes) {
  const target = requiredText(repository, "PR head repository").toLowerCase();
  const expectedHost = requiredText(hostname, "PR hostname").toLowerCase();
  const matches = [];
  for (const remote of list(remotes, "configured remotes")) {
    if (!isRecord(remote)) throw new FeedbackError("configured remote is invalid");
    const name = requiredText(remote.name, "remote name");
    const urls = list(remote.urls, `push URLs for ${name}`);
    for (const url of urls) {
      if (githubRemote(requiredText(url, `push URL for ${name}`), expectedHost) === target) matches.push({ name, urls });
    }
  }
  if (matches.length !== 1) throw new FeedbackError(`expected exactly one matching push URL for ${repository}, found ${matches.length}`);
  const [{ name, urls }] = matches;
  if (urls.length !== 1) throw new FeedbackError(`expected exactly one push URL on ${name}, found ${urls.length}`);
  return name;
}

function pushRemote(repository, hostname) {
  const remotes = git("remote").split("\n").filter(Boolean).map((name) => ({
    name,
    urls: run("git", ["remote", "get-url", "--push", "--all", name]).trim().split("\n").filter(Boolean),
  }));
  return selectPushRemote(repository, hostname, remotes);
}

function verifyTarget(options) {
  requireGh();
  const localHead = cleanHead();
  const metadata = readOpenPr(options.pr);
  requireMatchingHead(metadata, localHead);
  const repository = metadata.headRepository.nameWithOwner;
  const remote = discoveryPushRemote(options.pr, metadata) ?? pushRemote(repository, metadata.hostname);
  console.log(`pr=${metadata.url}`);
  console.log(`remote=${remote} repository=${repository}`);
  console.log(`push_target=git push ${remote} HEAD:${metadata.headRefName}`);
}

function checkPr(options) {
  requireGh();
  const metadata = readOpenPr(options.pr);
  console.log(`pr=${metadata.url}`);
  printPrStatus(metadata);
}

function waitForHead(expected, expectedHead, readPr = readOpenPr, pause = sleep) {
  let metadata;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    metadata = readPr(expected.url);
    requireSamePr(expected, prTarget(metadata, "current PR"), false);
    if (metadata.headRefOid === expectedHead) return metadata;
    if (attempt < READ_ATTEMPTS - 1) pause(250 * (attempt + 1));
  }
  return metadata;
}

function publishHead(initial, localHead, operations) {
  const { readPr, remoteFor, push, pause = sleep } = operations;
  const expected = prTarget(initial, "snapshot PR");
  const initialHead = expected.headRefOid;
  const current = readPr(expected.url);
  const observed = prTarget(current, "current PR");
  requireSamePr(expected, observed, false);
  if (observed.headRefOid === localHead) return { metadata: current, status: "already-current" };
  if (observed.headRefOid !== initialHead) {
    throw new FeedbackError(`PR head changed before push: ${initialHead} -> ${observed.headRefOid}`);
  }

  const remote = remoteFor(observed.headRepository, observed.hostname);
  try {
    push(remote, observed.headRefName);
  } catch (pushError) {
    let observedAfterError;
    try {
      observedAfterError = waitForHead(expected, localHead, readPr, pause);
    } catch (readError) {
      throw new FeedbackError(`push failed: ${pushError.message}; head verification failed: ${readError.message}`);
    }
    if (observedAfterError.headRefOid === localHead) {
      return { metadata: observedAfterError, remote, status: "recovered-after-error" };
    }
    if (observedAfterError.headRefOid !== initialHead) {
      throw new FeedbackError(`PR head changed while recovering failed push: ${initialHead} -> ${observedAfterError.headRefOid}`);
    }
    throw pushError;
  }

  const pushed = waitForHead(expected, localHead, readPr, pause);
  if (pushed.headRefOid !== localHead) {
    throw new FeedbackError(`push did not update PR head to local HEAD: ${pushed.headRefOid} != ${localHead}`);
  }
  return { metadata: pushed, remote, status: "pushed" };
}

function pushHead(options) {
  requireGh();
  const initial = snapshot(resolve(options.snapshot)).pullRequest;
  const localHead = cleanHead();
  const result = publishHead(initial, localHead, {
    readPr: readOpenPr,
    remoteFor: pushRemote,
    push: (remote, branch) => run("git", ["push", remote, `HEAD:${branch}`]),
  });
  const remote = result.remote ? ` remote=${result.remote}` : "";
  console.log(`pushed_head=${localHead}${remote} branch=${result.metadata.headRefName} status=${result.status}`);
}

function page(nodes, hasNextPage = false, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function selfTest() {
  const enterpriseHost = "github.example.test";
  const enterpriseUrl = `https://${enterpriseHost}/Owner/Repo/pull/1`;
  assert.deepEqual(parsePrUrl(enterpriseUrl), {
    url: enterpriseUrl,
    hostname: enterpriseHost,
    owner: "Owner",
    repo: "Repo",
    number: 1,
  });
  assert.doesNotThrow(() => validatePrRef(enterpriseUrl));
  assert.throws(() => validatePrRef(`http://${enterpriseHost}/Owner/Repo/pull/1`), UsageError);
  assert.deepEqual(graphqlArgs(enterpriseHost, { owner: "owner", skipped: null }), [
    "api", "graphql", "--hostname", enterpriseHost, "-F", "query=@-", "-F", "owner=owner",
  ]);

  for (const remoteUrl of [
    `git@${enterpriseHost}:Owner/Repo.git`,
    `ssh://git@${enterpriseHost}/Owner/Repo.git`,
    `https://${enterpriseHost}/Owner/Repo.git`,
  ]) assert.equal(githubRemote(remoteUrl, enterpriseHost), "owner/repo");
  assert.equal(githubRemote("https://github.com/Owner/Repo.git", enterpriseHost), null);
  assert.equal(githubRemote(`http://${enterpriseHost}/Owner/Repo.git`, enterpriseHost), null);
  assert.equal(selectPushRemote("Owner/Repo", enterpriseHost, [
    { name: "origin", urls: [`https://${enterpriseHost}/Owner/Repo.git`] },
    { name: "upstream", urls: [`https://${enterpriseHost}/Other/Repo.git`] },
  ]), "origin");
  assert.throws(
    () => selectPushRemote("Owner/Repo", enterpriseHost, [
      { name: "origin", urls: [`https://${enterpriseHost}/Owner/Repo.git`] },
      { name: "fork", urls: [`ssh://git@${enterpriseHost}/Owner/Repo.git`] },
    ]),
    /exactly one matching push URL/,
  );
  assert.throws(
    () => selectPushRemote("Owner/Repo", enterpriseHost, [{ name: "origin", urls: [`https://${enterpriseHost}/Owner/Repo.git`, `ssh://git@${enterpriseHost}/Owner/Repo.git`] }]),
    /exactly one matching push URL/,
  );
  assert.throws(
    () => selectPushRemote("Owner/Repo", enterpriseHost, [{ name: "origin", urls: [`https://${enterpriseHost}/Owner/Repo.git`, `https://${enterpriseHost}/Owner/Other.git`] }]),
    /exactly one push URL on origin/,
  );
  assert.throws(
    () => selectPushRemote("Owner/Repo", enterpriseHost, [{ name: "origin", urls: [`https://${enterpriseHost}/Owner/Other.git`] }]),
    /exactly one matching push URL/,
  );

  assert.equal(retryableReadFailure(new FeedbackError("HTTP 503")), true);
  assert.equal(retryableReadFailure(new FeedbackError("HTTP 400")), false);
  let readAttempts = 0;
  assert.equal(retryRead(() => {
    readAttempts += 1;
    if (readAttempts === 1) throw new FeedbackError("TLS handshake failed");
    return "ok";
  }, () => {}), "ok");
  assert.equal(readAttempts, 2);

  const temporary = mkdtempSync(join(tmpdir(), "pr-feedback-"));
  const emptySnapshot = join(temporary, "snapshot.json");
  writeFileSync(emptySnapshot, "");
  assert.equal(previousSnapshot(emptySnapshot), null);

  const originalWorkingDirectory = process.cwd();
  const repository = join(temporary, "repository");
  try {
    run("git", ["init", "--initial-branch=main", repository]);
    process.chdir(repository);
    git("config", "user.name", "Pi PR self-test");
    git("config", "user.email", "pi-pr@example.test");
    writeFileSync("tracked.txt", "base\n");
    git("add", "tracked.txt");
    git("commit", "-m", "base");
    const base = cleanHead();

    git("switch", "-c", "operation-source");
    writeFileSync("tracked.txt", "picked\n");
    git("commit", "-am", "pick one");
    const firstPick = git("rev-parse", "HEAD");
    writeFileSync("tracked.txt", "picked again\n");
    git("commit", "-am", "pick two");
    const secondPick = git("rev-parse", "HEAD");

    git("switch", "main");
    writeFileSync("tracked.txt", "target\n");
    git("commit", "-am", "target");
    git("branch", "merge-source", base);
    git("switch", "merge-source");
    git("commit", "--allow-empty", "-m", "merge source");
    const mergeSource = git("rev-parse", "HEAD");
    git("switch", "main");

    writeFileSync(join(temporary, "MERGE_HEAD"), "stale outside Git state\n");
    assert.equal(cleanHead(), git("rev-parse", "HEAD"));

    git("merge", "--no-ff", "--no-commit", mergeSource);
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => cleanHead(), /merge is in progress/);
    git("merge", "--abort");

    assert.throws(() => run("git", ["rebase", "--force-rebase", "--exec", "false", base]), FeedbackError);
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => cleanHead(), /rebase is in progress/);
    git("rebase", "--abort");

    assert.throws(() => run("git", ["cherry-pick", firstPick, secondPick]), FeedbackError);
    git("checkout", "--ours", "tracked.txt");
    git("add", "tracked.txt");
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => cleanHead(), /cherry-pick is in progress/);
    const cherryPickHead = git("rev-parse", "--git-path", "CHERRY_PICK_HEAD");
    const cherryPickState = readFileSync(cherryPickHead);
    rmSync(cherryPickHead);
    assert.throws(() => cleanHead(), /sequenced cherry-pick or revert is in progress/);
    writeFileSync(cherryPickHead, cherryPickState);
    git("cherry-pick", "--abort");

    assert.throws(() => run("git", ["revert", "--no-edit", secondPick, firstPick]), FeedbackError);
    git("checkout", "--ours", "tracked.txt");
    git("add", "tracked.txt");
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => cleanHead(), /revert is in progress/);
    const revertHead = git("rev-parse", "--git-path", "REVERT_HEAD");
    const revertState = readFileSync(revertHead);
    rmSync(revertHead);
    assert.throws(() => cleanHead(), /sequenced cherry-pick or revert is in progress/);
    writeFileSync(revertHead, revertState);
    git("revert", "--abort");

    const linked = join(temporary, "linked");
    git("worktree", "add", "-b", "linked", linked);
    process.chdir(linked);
    assert.equal(cleanHead(), git("rev-parse", "HEAD"));
    git("merge", "--no-ff", "--no-commit", mergeSource);
    assert.equal(git("status", "--porcelain"), "");
    assert.throws(() => cleanHead(), /merge is in progress/);
    git("merge", "--abort");
    assert.equal(cleanHead(), git("rev-parse", "HEAD"));

    process.chdir(repository);
    git("branch", "-m", "feature-local");
    git("remote", "add", "origin", `https://${enterpriseHost}/Owner/Repo.git`);
    git("remote", "add", "upstream", `https://${enterpriseHost}/Owner/Other.git`);
    git("config", "push.default", "upstream");
    const discoveryMetadata = {
      hostname: enterpriseHost,
      headRefName: "feature",
      headRefOid: cleanHead(),
      headRepository: { nameWithOwner: "Owner/Repo" },
    };
    requireMatchingHead(discoveryMetadata, discoveryMetadata.headRefOid);
    assert.throws(() => requireMatchingHead(discoveryMetadata, base), /does not match PR head/);

    assert.throws(() => discoveryPushRemote(undefined, discoveryMetadata), /has no configured push target/);
    git("config", "branch.feature-local.remote", "origin");
    git("config", "branch.feature-local.merge", "refs/heads/feature");
    assert.equal(discoveryPushRemote(undefined, discoveryMetadata), "origin");

    git("config", "branch.feature-local.merge", "refs/heads/other");
    assert.throws(() => discoveryPushRemote(undefined, discoveryMetadata), /configured push ref .* does not match PR head ref/);
    git("config", "branch.feature-local.merge", "refs/heads/feature");
    git("config", "branch.feature-local.remote", "upstream");
    assert.throws(() => discoveryPushRemote(undefined, discoveryMetadata), /configured push remote .* does not match PR head repository/);
    git("config", "branch.feature-local.remote", "origin");

    git("remote", "add", "fork", `ssh://git@${enterpriseHost}/Owner/Repo.git`);
    assert.throws(() => discoveryPushRemote(undefined, discoveryMetadata), /exactly one matching push URL/);
    git("remote", "remove", "fork");

    git("switch", "--detach");
    assert.throws(() => discoveryPushRemote(undefined, discoveryMetadata), /current HEAD is detached/);
    assert.equal(discoveryPushRemote("1", discoveryMetadata), null);
  } finally {
    process.chdir(originalWorkingDirectory);
  }

  let feedbackPages = 0;
  const graphqlHosts = [];
  const request = (query, variables, hostname) => {
    assert.equal(typeof variables, "object");
    assert.equal(hostname, enterpriseHost);
    graphqlHosts.push(hostname);
    if (query === THREAD_REPLIES_QUERY) return { node: { comments: page([{ id: "reply-2" }]) } };
    assert.equal(query, FEEDBACK_QUERY);
    feedbackPages += 1;
    const first = feedbackPages === 1;
    return {
      repository: {
        pullRequest: {
          comments: page([{ id: first ? "comment-1" : "comment-2" }], first, first ? "comments-2" : null),
          reviews: page([{ id: "review-1" }]),
          reviewThreads: page([{
            id: first ? "thread-1" : "thread-2",
            isResolved: false,
            isOutdated: false,
            comments: page([{ id: "reply-1" }], first, first ? "replies-2" : null),
          }], first, first ? "threads-2" : null),
        },
      },
    };
  };
  const metadata = { baseRepository: "owner/repo", number: 1, hostname: enterpriseHost };
  const buckets = threadBuckets([
    { id: "resolved", isResolved: true, isOutdated: false },
    { id: "outdated", isResolved: false, isOutdated: true },
    { id: "open", isResolved: false, isOutdated: false },
  ]);
  assert.deepEqual(nodeIds(buckets.openCurrent, "open thread"), ["open"]);
  const fetched = collectFeedback(metadata, request);
  assert.deepEqual(nodeIds(fetched.conversationComments, "comment"), ["comment-1", "comment-2"]);
  assert.deepEqual(nodeIds(fetched.reviews, "review"), ["review-1"]);
  assert.deepEqual(nodeIds(fetched.reviewThreads, "thread"), ["thread-1", "thread-2"]);
  assert.deepEqual(nodeIds(fetched.reviewThreads[0].comments, "reply"), ["reply-1", "reply-2"]);
  assert.deepEqual(new Set(graphqlHosts), new Set([enterpriseHost]));

  let statePages = 0;
  const stateRequest = (query, variables, hostname) => {
    assert.equal(typeof variables, "object");
    assert.equal(query, THREAD_STATES_QUERY);
    assert.equal(hostname, enterpriseHost);
    statePages += 1;
    return { repository: { pullRequest: { reviewThreads: page(
      [{ id: `thread-${statePages}`, isResolved: true }],
      statePages === 1,
      statePages === 1 ? "states-2" : null,
    ) } } };
  };
  assert.deepEqual([...collectThreadStates(metadata, stateRequest)], [["thread-1", true], ["thread-2", true]]);

  const mutations = [];
  resolveThread("thread-1", enterpriseHost, (query, variables, hostname) => {
    mutations.push([query, variables, hostname]);
    return { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } };
  });
  assert.deepEqual(mutations, [[RESOLVE_THREAD_MUTATION, { threadId: "thread-1" }, enterpriseHost]]);
  let failedMutations = 0;
  assert.throws(
    () => resolveThread("thread-2", enterpriseHost, () => {
      failedMutations += 1;
      throw new FeedbackError("mutation failed");
    }),
    /mutation failed/,
  );
  assert.equal(failedMutations, 1);

  const previousFeedback = {
    conversationComments: [{ id: "conversation-1", author: { login: "octocat" }, body: "old conversation" }],
    reviews: [{ id: "review-1", state: "CHANGES_REQUESTED", author: { login: "reviewer" }, body: "old review" }],
    reviewThreads: [
      { id: "current", isResolved: false, isOutdated: false, path: "src/a.js", line: 3, comments: [{ id: "current-comment", author: { login: "reviewer" }, body: "old reply" }] },
      { id: "outdated", isResolved: false, isOutdated: false, path: "src/b.js", originalLine: 4, comments: [] },
      { id: "resolved", isResolved: false, isOutdated: false, path: "src/c.js", line: 5, comments: [] },
    ],
  };
  const feedback = {
    pullRequest: {
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
        { state: "FAILURE" },
        { status: "COMPLETED", conclusion: "STALE" },
      ],
    },
    conversationComments: [{ ...previousFeedback.conversationComments[0], body: "edited conversation" }, { id: "conversation-2", author: { login: "octocat" }, body: "new conversation" }],
    reviews: [{ ...previousFeedback.reviews[0], state: "DISMISSED", body: "edited review" }, { id: "review-2", state: "COMMENTED", author: { login: "reviewer" }, body: "new review" }],
    reviewThreads: [
      { ...previousFeedback.reviewThreads[0], comments: [{ ...previousFeedback.reviewThreads[0].comments[0], body: "edited reply" }, { id: "new-reply", author: { login: "reviewer" }, body: "new reply" }] },
      { ...previousFeedback.reviewThreads[1], isOutdated: true },
      { ...previousFeedback.reviewThreads[2], isResolved: true },
      { id: "new-thread", isResolved: false, isOutdated: false, path: "src/d.js", line: 6, comments: [{ id: "new-thread-comment", author: { login: "reviewer" }, body: "new thread" }] },
    ],
  };
  assert.equal(checkBucket({ conclusion: "STALE" }), "failing");
  assert.deepEqual(checkSummary(feedback.pullRequest), { passing: 1, pending: 1, failing: 2 });
  const initialLines = [];
  printFetchSummary(feedback, null, "/tmp/snapshot", (line) => initialLines.push(line));
  for (const body of ["edited conversation", "edited review", "edited reply", "new conversation", "new review", "new reply", "new thread"]) {
    assert(initialLines.some((line) => line.includes(body)));
  }

  const savedFeedback = { ...feedback, pullRequest: { ...feedback.pullRequest, url: "https://github.com/owner/repo/pull/1" } };
  const savedPrevious = { ...previousFeedback, pullRequest: savedFeedback.pullRequest };
  const deltaSnapshot = join(temporary, "delta.json");
  writeSnapshot(deltaSnapshot, savedPrevious);
  const deltaLines = [];
  printFetchSummary(feedback, previousSnapshot(deltaSnapshot), deltaSnapshot, (line) => deltaLines.push(line));
  writeSnapshot(deltaSnapshot, savedFeedback);
  assert.equal(snapshot(deltaSnapshot).reviewThreads.length, feedback.reviewThreads.length);
  const delta = deltaLines.join("\n");
  assert(delta.includes("merge_state=BLOCKED checks_total=4 passing=1 pending=1 failing=2"));
  for (const body of ["edited conversation", "edited review", "edited reply", "new conversation", "new review", "new reply", "new thread"]) assert(delta.includes(body));
  for (const old of ["old conversation", "old review", "old reply"]) assert(!delta.includes(old));
  assert(delta.includes("new-thread\tcurrent"));
  assert(delta.includes("outdated\tcurrent\toutdated"));
  assert(delta.includes("resolved\tcurrent\tresolved"));
  const unchangedLines = [];
  printFetchSummary(feedback, savedFeedback, deltaSnapshot, (line) => unchangedLines.push(line));
  assert(unchangedLines.includes("feedback_delta=none"));
  assert(!unchangedLines.some((line) => line.includes("edited conversation")));
  rmSync(temporary, { recursive: true, force: true });

  const oldHead = {
    number: 1,
    url: `https://${enterpriseHost}/owner/repo/pull/1`,
    hostname: enterpriseHost,
    baseRefName: "main",
    baseRefOid: "base",
    headRefOid: "old",
    headRefName: "feature",
    headRepository: { nameWithOwner: "owner/repo" },
  };
  const localHead = { ...oldHead, headRefOid: "local" };
  const sequence = (...values) => {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
  };
  const operations = (readPr, push = () => {}, remoteFor = () => "origin") => ({
    readPr,
    remoteFor,
    push,
    pause: () => {},
  });
  let alreadyCurrentRemoteCalls = 0;
  let alreadyCurrentPushes = 0;
  assert.equal(publishHead(oldHead, "local", operations(
    sequence(localHead),
    () => { alreadyCurrentPushes += 1; },
    () => { alreadyCurrentRemoteCalls += 1; return "origin"; },
  )).status, "already-current");
  assert.equal(alreadyCurrentRemoteCalls, 0);
  assert.equal(alreadyCurrentPushes, 0);
  const remoteCalls = [];
  const pushCalls = [];
  assert.equal(publishHead(oldHead, "local", operations(
    sequence(oldHead, oldHead, localHead),
    (remote, branch) => pushCalls.push([remote, branch]),
    (repository, hostname) => {
      remoteCalls.push([repository, hostname]);
      return "origin";
    },
  )).status, "pushed");
  assert.deepEqual(remoteCalls, [["owner/repo", enterpriseHost]]);
  assert.deepEqual(pushCalls, [["origin", "feature"]]);
  assert.equal(publishHead(oldHead, "local", operations(sequence(oldHead, localHead), () => {
    throw new FeedbackError("HTTP 503");
  })).status, "recovered-after-error");
  let failedPushes = 0;
  assert.throws(
    () => publishHead(oldHead, "local", operations(sequence(oldHead), () => {
      failedPushes += 1;
      throw new FeedbackError("HTTP 503");
    })),
    /HTTP 503/,
  );
  assert.equal(failedPushes, 1);

  const drifts = [
    ["number", { ...oldHead, number: 2, url: `https://${enterpriseHost}/owner/repo/pull/2` }],
    ["URL", { ...oldHead, url: `https://${enterpriseHost}/owner/other/pull/1` }],
    ["hostname", { ...oldHead, hostname: "other.example.test", url: "https://other.example.test/owner/repo/pull/1" }],
    ["base ref", { ...oldHead, baseRefName: "release" }],
    ["base OID", { ...oldHead, baseRefOid: "other-base" }],
    ["head repository", { ...oldHead, headRepository: { nameWithOwner: "owner/fork" } }],
    ["head ref", { ...oldHead, headRefName: "other-feature" }],
  ];
  for (const [field, changed] of drifts) {
    let pushes = 0;
    assert.throws(
      () => publishHead(oldHead, "local", operations(sequence({ ...changed, headRefOid: "local" }), () => { pushes += 1; })),
      new RegExp(`PR ${field} changed since feedback fetch`),
    );
    assert.equal(pushes, 0);
  }
  let driftPushes = 0;
  assert.throws(
    () => publishHead(oldHead, "local", operations(sequence({ ...oldHead, headRefOid: "other-head" }), () => { driftPushes += 1; })),
    /PR head changed before push: old -> other-head/,
  );
  assert.equal(driftPushes, 0);
  assert.throws(
    () => publishHead(oldHead, "local", operations(sequence(oldHead, { ...oldHead, baseRefOid: "other-base" }), () => {
      throw new FeedbackError("HTTP 503");
    })),
    /push failed: HTTP 503; head verification failed: PR base OID changed since feedback fetch/,
  );
  assert.throws(
    () => publishHead(oldHead, "local", operations(sequence(oldHead, { ...oldHead, headRefOid: "other-head" }), () => {
      throw new FeedbackError("HTTP 503");
    })),
    /PR head changed while recovering failed push: old -> other-head/,
  );
  assert.throws(
    () => collectFeedback(metadata, () => ({ repository: { pullRequest: {
      comments: page([], true), reviews: page([]), reviewThreads: page([]),
    } } })),
    /missing pagination cursor for conversation comments/,
  );
  console.log("pr-feedback self-test ok");
}

function usage() {
  const command = `node ${process.argv[1]}`;
  return `usage:
  ${command} fetch [--pr PR] (--out FILE | --json)
  ${command} target [--pr PR]
  ${command} checks [--pr PR]
  ${command} push --snapshot FILE
  ${command} resolve [--pr PR] --expected-head SHA --thread ID [--thread ID ...]
  ${command} self-test`;
}

function parse(command, args) {
  const allowed = {
    fetch: new Set(["--pr", "--out", "--json"]),
    target: new Set(["--pr"]),
    checks: new Set(["--pr"]),
    push: new Set(["--snapshot"]),
    resolve: new Set(["--pr", "--expected-head", "--thread"]),
  }[command];
  if (!allowed) throw new UsageError(`unknown command: ${command}`);
  const values = { threads: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!allowed.has(flag)) throw new UsageError(`unsupported ${flag} for ${command}`);
    if (flag === "--json") {
      if (values.json) throw new UsageError("--json was supplied twice");
      values.json = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    index += 1;
    if (flag === "--thread") {
      values.threads.push(value);
      continue;
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (values[key] !== undefined) throw new UsageError(`${flag} was supplied twice`);
    values[key] = value;
  }
  validatePrRef(values.pr);
  if (command === "fetch" && values.out === undefined && !values.json) throw new UsageError("fetch needs --out or --json");
  if (command === "fetch" && values.out !== undefined && values.json) throw new UsageError("fetch accepts --out or --json, not both");
  if (command === "push" && values.snapshot === undefined) throw new UsageError("push needs --snapshot");
  if (command === "resolve") {
    if (values.expectedHead === undefined) throw new UsageError("resolve needs --expected-head");
    if (!values.threads.length) throw new UsageError("resolve needs at least one --thread");
    if (new Set(values.threads).size !== values.threads.length) throw new UsageError("duplicate --thread");
  }
  return values;
}

function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }
  const [command, ...args] = argv;
  if (command === "self-test") {
    if (args.length) throw new UsageError("self-test takes no arguments");
    selfTest();
    return 0;
  }
  const options = parse(command, args);
  if (command === "fetch") fetchFeedback(options);
  if (command === "target") verifyTarget(options);
  if (command === "checks") checkPr(options);
  if (command === "push") pushHead(options);
  if (command === "resolve") resolveFeedback(options);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error.message}`);
  if (error instanceof UsageError) console.error(usage());
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
