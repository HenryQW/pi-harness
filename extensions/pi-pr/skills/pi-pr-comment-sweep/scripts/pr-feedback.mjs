#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PR_FIELDS = "number,url,title,state,baseRefName,headRefName,headRefOid,headRepository,mergeStateStatus,statusCheckRollup";
const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/;
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
  if (git("status", "--porcelain")) throw new FeedbackError("index and worktree must be clean");
  return requiredText(git("rev-parse", "HEAD"), "local HEAD");
}

function validatePrRef(pr) {
  if (pr === undefined) return;
  if (/^[1-9][0-9]*$/.test(pr) || PR_URL.test(pr)) return;
  throw new UsageError("--pr must be a positive PR number or https://github.com/OWNER/REPO/pull/NUMBER");
}

function readOpenPr(pr) {
  const args = ["pr", "view"];
  if (pr !== undefined) args.push(pr);
  args.push("--json", PR_FIELDS);
  const value = readJsonCommand("gh", args);
  if (value.state !== "OPEN") throw new FeedbackError(`PR must be OPEN, got ${JSON.stringify(value.state)}`);

  const url = requiredText(value.url, "PR URL");
  const match = PR_URL.exec(url);
  if (!match) throw new FeedbackError(`unsupported PR URL: ${url}`);
  if (!Number.isInteger(value.number)) throw new FeedbackError("PR number must be an integer");
  requiredText(value.headRefName, "PR head ref");
  requiredText(value.headRefOid, "PR head OID");
  requiredText(value.mergeStateStatus, "PR merge state");
  list(value.statusCheckRollup, "PR status checks");
  if (!isRecord(value.headRepository)) throw new FeedbackError("PR head repository identity is unavailable");
  requiredText(value.headRepository.nameWithOwner, "PR head repository");

  return {
    ...value,
    baseRepository: `${match[1]}/${match[2]}`,
  };
}

function requireMatchingHead(metadata, localHead) {
  if (metadata.headRefOid !== localHead) {
    throw new FeedbackError(`local HEAD ${localHead} does not match PR head ${metadata.headRefOid}`);
  }
}

function requireDiscoveryBranch(pr, metadata) {
  if (pr !== undefined) return;
  const branch = git("branch", "--show-current");
  if (branch !== metadata.headRefName) {
    throw new FeedbackError(`local branch ${JSON.stringify(branch)} does not match PR head branch ${JSON.stringify(metadata.headRefName)}`);
  }
}

function graphqlResponse(query, variables) {
  const args = ["api", "graphql", "-F", "query=@-"];
  for (const [name, value] of Object.entries(variables)) {
    if (value !== null && value !== undefined) args.push("-F", `${name}=${value}`);
  }
  const response = jsonCommand("gh", args, query);
  if (response.errors && (!Array.isArray(response.errors) || response.errors.length)) {
    throw new FeedbackError(`GitHub GraphQL errors: ${JSON.stringify(response.errors)}`);
  }
  if (!isRecord(response.data)) throw new FeedbackError("GitHub GraphQL response has no data");
  return response.data;
}

function readGraphql(query, variables) {
  return retryRead(() => graphqlResponse(query, variables));
}

function writeGraphql(query, variables) {
  return graphqlResponse(query, variables);
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
    });
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

  results.reviewThreads = results.reviewThreads.map((thread) => collectReplies(thread, request));
  return {
    pullRequest: metadata,
    conversationComments: results.conversationComments,
    reviews: results.reviews,
    reviewThreads: results.reviewThreads,
  };
}

function collectReplies(thread, request) {
  if (!isRecord(thread)) throw new FeedbackError("invalid review thread");
  const threadId = requiredText(thread.id, "review thread ID");
  let page = connection(thread.comments, `replies for ${threadId}`);
  const comments = [...page.nodes];
  while (page.hasNextPage) {
    const data = request(THREAD_REPLIES_QUERY, { threadId, cursor: page.endCursor });
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
    const data = request(THREAD_STATES_QUERY, { owner, repo, number: metadata.number, cursor });
    const page = connection(pullRequest(data).reviewThreads, "review threads");
    for (const thread of page.nodes) {
      if (!isRecord(thread)) throw new FeedbackError("invalid review thread state");
      states.set(requiredText(thread.id, "review thread ID"), bool(thread.isResolved, "review thread isResolved"));
    }
    if (!page.hasNextPage) return states;
    cursor = page.endCursor;
  }
}

function resolveThread(threadId) {
  const data = writeGraphql(RESOLVE_THREAD_MUTATION, { threadId });
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
  requiredText(value.pullRequest.url, "snapshot PR URL");
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
    return ["ERROR", "FAILURE"].includes(check.state) ? "failing" : "pending";
  }
  if (check.conclusion === null || check.conclusion === undefined || check.conclusion === "") return "pending";
  const conclusion = text(check.conclusion, "PR status check conclusion");
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "passing";
  return ["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "TIMED_OUT"].includes(conclusion) ? "failing" : "pending";
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
  if (previous && previous.pullRequest.url !== initial.url) {
    throw new FeedbackError(`existing feedback JSON belongs to ${previous.pullRequest.url}, not ${initial.url}`);
  }
  requireMatchingHead(initial, localHead);
  requireDiscoveryBranch(options.pr, initial);
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
    if (!states.get(threadId)) resolveThread(threadId);
  }

  metadata = currentExpectedHead(metadata.url, options.expectedHead);
  const verified = collectThreadStates(metadata);
  const unresolved = requested.filter((threadId) => verified.get(threadId) !== true);
  if (unresolved.length) throw new FeedbackError(`resolution verification failed: ${unresolved.join(",")}`);
  console.log(`resolved_thread_ids=${requested.join(",")}`);
}

function githubRemote(url) {
  const scp = /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

function pushRemote(repository) {
  const target = requiredText(repository, "PR head repository").toLowerCase();
  const matches = git("remote").split("\n").filter(Boolean).filter((remote) => {
    const urls = run("git", ["remote", "get-url", "--push", "--all", remote]).trim().split("\n");
    return urls.some((url) => githubRemote(url) === target);
  });
  if (matches.length !== 1) {
    throw new FeedbackError(`expected one push remote for ${repository}, found ${matches.length}: ${matches.join(",") || "-"}`);
  }
  return matches[0];
}

function verifyTarget(options) {
  requireGh();
  const localHead = cleanHead();
  const metadata = readOpenPr(options.pr);
  requireMatchingHead(metadata, localHead);
  requireDiscoveryBranch(options.pr, metadata);
  const repository = metadata.headRepository.nameWithOwner;
  const remote = pushRemote(repository);
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

function waitForHead(pr, expectedHead, readPr = readOpenPr, pause = sleep) {
  let metadata;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    metadata = readPr(pr);
    if (metadata.headRefOid === expectedHead) return metadata;
    if (attempt < READ_ATTEMPTS - 1) pause(250 * (attempt + 1));
  }
  return metadata;
}

function publishHead(initial, localHead, operations) {
  const { readPr, remoteFor, push, pause = sleep } = operations;
  const initialHead = requiredText(initial.headRefOid, "snapshot PR head");
  const current = readPr(initial.url);
  if (current.headRefOid === localHead) return { metadata: current, status: "already-current" };
  if (current.headRefOid !== initialHead) {
    throw new FeedbackError(`PR head changed since feedback fetch: ${initialHead} -> ${current.headRefOid}`);
  }

  const remote = remoteFor(current.headRepository.nameWithOwner);
  try {
    push(remote, current.headRefName);
  } catch (pushError) {
    let observed;
    try {
      observed = waitForHead(current.url, localHead, readPr, pause);
    } catch (readError) {
      throw new FeedbackError(`push failed: ${pushError.message}; head verification failed: ${readError.message}`);
    }
    if (observed.headRefOid === localHead) {
      return { metadata: observed, remote, status: "recovered-after-error" };
    }
    if (observed.headRefOid !== initialHead) {
      throw new FeedbackError(`PR head changed while recovering failed push: ${initialHead} -> ${observed.headRefOid}`);
    }
    throw pushError;
  }

  const pushed = waitForHead(current.url, localHead, readPr, pause);
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
  assert.equal(githubRemote("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(githubRemote("ssh://git@github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(githubRemote("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(githubRemote("https://example.com/Owner/Repo.git"), null);

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

  let feedbackPages = 0;
  const request = (query) => {
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
  const metadata = { baseRepository: "owner/repo", number: 1 };
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

  let statePages = 0;
  const stateRequest = () => {
    statePages += 1;
    return { repository: { pullRequest: { reviewThreads: page(
      [{ id: `thread-${statePages}`, isResolved: true }],
      statePages === 1,
      statePages === 1 ? "states-2" : null,
    ) } } };
  };
  assert.deepEqual([...collectThreadStates(metadata, stateRequest)], [["thread-1", true], ["thread-2", true]]);

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
  assert.deepEqual(checkSummary(feedback.pullRequest), { passing: 1, pending: 2, failing: 1 });
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
  assert(delta.includes("merge_state=BLOCKED checks_total=4 passing=1 pending=2 failing=1"));
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
    url: "https://github.com/owner/repo/pull/1",
    headRefOid: "old",
    headRefName: "feature",
    headRepository: { nameWithOwner: "owner/repo" },
  };
  const localHead = { ...oldHead, headRefOid: "local" };
  const sequence = (...values) => {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
  };
  const operations = (readPr, push = () => {}) => ({
    readPr,
    remoteFor: () => "origin",
    push,
    pause: () => {},
  });
  assert.equal(publishHead(oldHead, "local", operations(sequence(localHead))).status, "already-current");
  assert.equal(publishHead(oldHead, "local", operations(sequence(oldHead, oldHead, localHead))).status, "pushed");
  assert.equal(publishHead(oldHead, "local", operations(sequence(oldHead, localHead), () => {
    throw new FeedbackError("HTTP 503");
  })).status, "recovered-after-error");
  assert.throws(
    () => publishHead(oldHead, "local", operations(sequence(oldHead), () => {
      throw new FeedbackError("HTTP 503");
    })),
    /HTTP 503/,
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
