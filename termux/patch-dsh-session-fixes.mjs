#!/usr/bin/env node
/**
 * 修补 @deepseek-ai/dsh 在 Termux 长会话 / 中断场景下的三处缺陷：
 *
 *   P1  dsh-workspace                  —— 工作区名单不再静默剔除"头没索引到"的会话
 *   P2  dsh-session-persistence-jsonl  —— 会话列表跳过坏日志时至少留一条 warn
 *   P3  dsh-tools / dsh-session        —— 迟到的工具结果不再写进已关闭的回合
 *
 * 背景、症状与判据见仓库 README 的「问题七」。补丁全部是幂等的字面替换，
 * 应用前会把原文件备份为 `<文件>.pre-session-fixes.bak`。
 *
 * 用法：
 *   node termux/patch-dsh-session-fixes.mjs               # 应用（可重复执行）
 *   node termux/patch-dsh-session-fixes.mjs --check       # 只报告当前状态
 *   node termux/patch-dsh-session-fixes.mjs --revert      # 回滚到补丁前
 *   node termux/patch-dsh-session-fixes.mjs --root <dir>  # 指定 @deepseek-ai 目录（自检用）
 *
 * 生效需要重启 dsh-app：补丁在包加载时读取。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 补丁应用后写在原文件旁的原件备份后缀。 */
const BACKUP_SUFFIX = '.pre-session-fixes.bak'
const PROBE = 'dsh-session/lib/index.js'

const PATCHES = [
  {
    file: "dsh-workspace/lib/index.js",
    old: "\t\ttry {\n\t\t\tnext = await this.host.table().update(this.id, (current) => {\n\t\t\t\tconst changed = fn(current);\n\t\t\t\tconst sessionIds = changed.sessionIds.filter((id) => this.host.candidateMatches(id, changed.path));\n\t\t\t\tif (changed === current && sessionIds.length === current.sessionIds.length) throw unchangedSentinel;\n\t\t\t\treturn {\n\t\t\t\t\t...changed,",
    new: "\t\ttry {\n\t\t\tnext = await this.host.table().update(this.id, (current) => {\n\t\t\t\tconst changed = fn(current);\n\t\t\t\t/* PATCH(session-membership): the shipped code dropped every id that failed the\n\t\t\t\t * candidate check, permanently and silently. An id whose header is merely missing\n\t\t\t\t * from this process's index (log corrupt, mid-write, or written by another\n\t\t\t\t * process) is kept, and every actual removal now warns. */\n\t\t\t\tconst sessionIds = changed.sessionIds.filter((id) => {\n\t\t\t\t\tif (this.host.candidateMatches(id, changed.path)) return true;\n\t\t\t\t\tif (!this.host.knowsHeader(id)) {\n\t\t\t\t\t\tthis.host.warn(`workspace '${this.id}' keeps session '${id}' in membership although its stored header is not indexed in this process (unreadable, mid-write, or written elsewhere); membership is preserved until the session becomes readable`);\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t\tthis.host.warn(`workspace '${this.id}' removes session '${id}' from membership: its canonical cwd does not match workspace path '${changed.path}'`);\n\t\t\t\t\treturn false;\n\t\t\t\t});\n\t\t\t\tif (changed === current && sessionIds.length === current.sessionIds.length) throw unchangedSentinel;\n\t\t\t\treturn {\n\t\t\t\t\t...changed,"
  },
  {
    file: "dsh-workspace/lib/index.js",
    old: "\thost = {\n\t\ttable: () => this.requireTable(),\n\t\tcandidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),\n\t\treadSessionHeader: (id) => this.readSessionHeader(id),\n\t\trememberSessionPath: (id, path) => {\n\t\t\tthis.sessionPaths.set(id, path);",
    new: "\thost = {\n\t\ttable: () => this.requireTable(),\n\t\tcandidateMatches: (id, path) => this.sessionPaths.get(id) === path || this.missingSessionPaths.has(id),\n\t\t/* PATCH(session-membership): a header this process failed to index is not evidence\n\t\t * that the session is gone, only that membership cannot be validated right now. */\n\t\tknowsHeader: (id) => this.headers.has(id),\n\t\twarn: (message) => this.ctx.logger.warn(message),\n\t\treadSessionHeader: (id) => this.readSessionHeader(id),\n\t\trememberSessionPath: (id, path) => {\n\t\t\tthis.sessionPaths.set(id, path);"
  },
  {
    file: "dsh-session-persistence-jsonl/lib/index.js",
    old: "\t\tfor (const outcome of headers) {\n\t\t\tif (outcome.status === \"rejected\") throw outcome.reason;\n\t\t\tconst { selected, metadata } = outcome.value;\n\t\t\tif (metadata === void 0) continue;\n\t\t\tif (ids.has(metadata.header.id)) throw new Error(`duplicate JSONL session id \"${metadata.header.id}\" appears in multiple project directories`);\n\t\t\tids.add(metadata.header.id);\n\t\t\tartifacts.push({",
    new: "\t\tfor (const outcome of headers) {\n\t\t\tif (outcome.status === \"rejected\") throw outcome.reason;\n\t\t\tconst { selected, metadata } = outcome.value;\n\t\t\t/* PATCH(session-listing): the shipped code skipped an unreadable header without a\n\t\t\t * trace, so the session vanished from list() and the workspace registry then pruned\n\t\t\t * its membership. Say so instead of disappearing quietly. */\n\t\t\tif (metadata === void 0) {\n\t\t\t\tthis.ctx.logger.warn(`${this.name}: session log '${selected.sourcePath}' was left out of the session listing because its header could not be read (corrupt, truncated, or still being written)`);\n\t\t\t\tcontinue;\n\t\t\t}\n\t\t\tif (ids.has(metadata.header.id)) throw new Error(`duplicate JSONL session id \"${metadata.header.id}\" appears in multiple project directories`);\n\t\t\tids.add(metadata.header.id);\n\t\t\tartifacts.push({"
  },
  {
    file: "dsh-session/lib/index.js",
    old: "\treturn closers;\n}\n/**\n* Track unanswered assistant tool requests from one Session's committed events.\n* Observe from the start of the owned step or replay prefix, and recover before\n* its step closes. This state retains pending identities, not event history.",
    new: "\treturn closers;\n}\n/**\n* PATCH(late-tool-result): derive the turn/step still open at the log tail.\n*\n* `openTurnClosers` above exists because a persisted log can end inside an open\n* turn; once such closers are appended the turn is closed. A background tool\n* job that settles afterwards still tries to append its `tool/result`, which\n* used to land after the close and made the whole log unreadable on the next\n* cold read (\"tool/result does not match an open turn and step\").\n*\n* @param events - the session's accepted event log.\n* @returns the open tail turn and step, or nulls when the tail is closed.\n*/\nfunction tailOpenTurnStep(events) {\n\tlet step;\n\tfor (let index = events.length - 1; index >= 0; index -= 1) {\n\t\tconst event = events[index];\n\t\tif (event.type === \"step/start\" || event.type === \"step/end\") {\n\t\t\tif (step === void 0) step = event.type === \"step/start\" ? event.data.step : null;\n\t\t\tcontinue;\n\t\t}\n\t\tif (event.type === \"turn/start\" || event.type === \"turn/end\") {\n\t\t\tif (event.type === \"turn/end\") return {\n\t\t\t\tturn: null,\n\t\t\t\tstep: null\n\t\t\t};\n\t\t\treturn {\n\t\t\t\tturn: event.data.turn,\n\t\t\t\tstep: step ?? null\n\t\t\t};\n\t\t}\n\t}\n\treturn {\n\t\tturn: null,\n\t\tstep: null\n\t};\n}\n/**\n* Track unanswered assistant tool requests from one Session's committed events.\n* Observe from the start of the owned step or replay prefix, and recover before\n* its step closes. This state retains pending identities, not event history."
  },
  {
    file: "dsh-session/lib/index.js",
    old: "\t\t};\n\t\tconst dataSnapshot = snapshotJsonValue(data);\n\t\tif (dataSnapshot === void 0) throw new Error(`session event \"${type}\" carries non-JSON-serializable data`);\n\t\tconst surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata);\n\t\tif (surfaceMetadataSnapshot === void 0) throw new Error(`session event \"${type}\" carries non-JSON-serializable surface metadata`);\n\t\tconst entry = this.publicationEntry();",
    new: "\t\t};\n\t\tconst dataSnapshot = snapshotJsonValue(data);\n\t\tif (dataSnapshot === void 0) throw new Error(`session event \"${type}\" carries non-JSON-serializable data`);\n\t\t/* PATCH(late-tool-result): refuse a tool outcome whose turn/step is already closed.\n\t\t * Appending it cannot be represented by the log format, so it would poison every\n\t\t * later read instead of only losing one tool result. */\n\t\tif ((type === \"tool/result\" || type === \"tool/call\") && (surfaceOpts?.surfaceOp === void 0 || surfaceOpts.surfaceOp === \"append\") && typeof dataSnapshot?.turn === \"number\" && typeof dataSnapshot?.step === \"number\") {\n\t\t\tconst open = tailOpenTurnStep(this.log);\n\t\t\tif (open.turn !== dataSnapshot.turn || open.step !== dataSnapshot.step) {\n\t\t\t\tconsole.warn(`[dsh-patch] dropped a late ${type} for session '${this.id}': turn ${dataSnapshot.turn} step ${dataSnapshot.step} is no longer the open tail position (open turn=${String(open.turn)}, open step=${String(open.step)}); appending it would make the stored log unreadable`);\n\t\t\t\treturn void 0;\n\t\t\t}\n\t\t}\n\t\tconst surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata);\n\t\tif (surfaceMetadataSnapshot === void 0) throw new Error(`session event \"${type}\" carries non-JSON-serializable surface metadata`);\n\t\tconst entry = this.publicationEntry();"
  },
  {
    file: "dsh-session/lib/index.js",
    old: "\t}\n};\n//#endregion\nexport { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session, SessionForkError, SessionId, SessionLogOffset, SessionPreparation, SessionSeq, SessionStore, SessionStore as default, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, ToolCallRecovery, adoptSessionEvent, appendPluginRecord, buildForkSeed, canonicalHeader, decodeSeqRanges, deriveEventMessage, encodeSeqRanges, foldRequestHeader, foldSurface, headerEquals, interruptedTurnClosers, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEligibleType, isSurfaceEvent, pluginRecordOf, snapshotSessionEvent };",
    new: "\t}\n};\n//#endregion\nexport { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session, SessionForkError, SessionId, SessionLogOffset, SessionPreparation, SessionSeq, SessionStore, SessionStore as default, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, ToolCallRecovery, adoptSessionEvent, appendPluginRecord, buildForkSeed, canonicalHeader, decodeSeqRanges, deriveEventMessage, encodeSeqRanges, foldRequestHeader, foldSurface, headerEquals, interruptedTurnClosers, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEligibleType, isSurfaceEvent, pluginRecordOf, snapshotSessionEvent, tailOpenTurnStep };"
  },
  {
    file: "dsh-tools/lib/pipeline.js",
    old: "import { a as ToolNotFoundError, m as ToolBatchExecutionError, n as TOOL_ABORTED, o as ToolOutputError, p as validateJsonSchemaValue, r as TOOL_ABORTED_BEFORE_DISPATCH } from \"./shared-DTdn5dXO.js\";\nimport { scopeTarget } from \"@deepseek-ai/dsh-scope\";\nimport { HarnessError, createToolResultMessage } from \"@deepseek-ai/dsh-llm\";\nimport { assertNever, deepFreeze, snapshotJsonValue } from \"@deepseek-ai/dsh-util-values\";\n//#region lib/types/batch.js\n/**",
    new: "import { a as ToolNotFoundError, m as ToolBatchExecutionError, n as TOOL_ABORTED, o as ToolOutputError, p as validateJsonSchemaValue, r as TOOL_ABORTED_BEFORE_DISPATCH } from \"./shared-DTdn5dXO.js\";\nimport { scopeTarget } from \"@deepseek-ai/dsh-scope\";\nimport { HarnessError, createToolResultMessage, createUserMessage } from \"@deepseek-ai/dsh-llm\";\nimport { tailOpenTurnStep } from \"@deepseek-ai/dsh-session\";\nimport { assertNever, deepFreeze, snapshotJsonValue } from \"@deepseek-ai/dsh-util-values\";\n//#region lib/types/batch.js\n/**"
  },
  {
    file: "dsh-tools/lib/pipeline.js",
    old: "\t\tconcluded\n\t};\n}\n/** Collect committed results and optionally append their durable Session events. */\nvar BatchSettlement = class {\n\tinput;",
    new: "\t\tconcluded\n\t};\n}\n/** PATCH(late-tool-result-root): render one tool outcome whose turn/step was already\n* closed as a runtime-context message, so its output still reaches the model and the\n* user instead of being dropped or corrupting the stored log. */\nfunction lateToolResultNotice(block, message, position) {\n\tconst output = message.content.flatMap((part) => part.type === \"text\" ? [part.text] : [`[${part.type} output omitted]`]).join(\"\\n\");\n\tconst text = [\n\t\t`The tool call ${block.name} (${block.id}) finished after its position in the conversation (turn ${position.turn} step ${position.step}) had already been closed by interruption recovery, so its outcome could not be recorded as a tool result.`,\n\t\t...message.isError === true ? [\"The call failed; its error output follows.\"] : [],\n\t\t\"\",\n\t\toutput\n\t].join(\"\\n\");\n\treturn createUserMessage({\n\t\tcontent: [{\n\t\t\ttype: \"text\",\n\t\t\ttext\n\t\t}],\n\t\tsource: {\n\t\t\tkind: \"runtime-context\",\n\t\t\tform: \"notice\",\n\t\t\tsummary: `Late output from ${block.name}`\n\t\t}\n\t});\n}\n/** Collect committed results and optionally append their durable Session events. */\nvar BatchSettlement = class {\n\tinput;"
  },
  {
    file: "dsh-tools/lib/pipeline.js",
    old: "\tcommit(block, result, callSeq) {\n\t\tif (this.input.log !== void 0) {\n\t\t\tconst { agent, log: { turn, step } } = this.input;\n\t\t\tagent.session.append(\"tool/result\", {\n\t\t\t\tturn,\n\t\t\t\tstep,\n\t\t\t\tmessage: createToolResultMessage({\n\t\t\t\t\tcallId: block.id,\n\t\t\t\t\tcontent: result.content,\n\t\t\t\t\tisError: result.isError\n\t\t\t\t}),\n\t\t\t\t...result.error?.info ? { error: result.error.info } : {},\n\t\t\t\t...result.meta !== void 0 ? { meta: result.meta } : {}\n\t\t\t}, {\n\t\t\t\tsurfaceOp: \"append\",\n\t\t\t\tsourceEventSeqs: [callSeq]\n\t\t\t});\n\t\t}\n\t\tthis.results.push({\n\t\t\tcallId: block.id,",
    new: "\tcommit(block, result, callSeq) {\n\t\tif (this.input.log !== void 0) {\n\t\t\tconst { agent, log: { turn, step } } = this.input;\n\t\t\tconst message = createToolResultMessage({\n\t\t\t\tcallId: block.id,\n\t\t\t\tcontent: result.content,\n\t\t\t\tisError: result.isError\n\t\t\t});\n\t\t\t/* PATCH(late-tool-result-root): the shipped code appended this tool/result whether or\n\t\t\t * not its turn/step was still open. A background job that settles after interruption\n\t\t\t * recovery closed the turn then wrote an event the log format cannot represent, which\n\t\t\t * made the whole session unreadable on the next cold read. Deliver that output as a\n\t\t\t * runtime-context message instead: nothing is lost and the log stays valid. */\n\t\t\tconst open = tailOpenTurnStep(agent.session.log);\n\t\t\tif (open.turn === turn && open.step === step) {\n\t\t\t\tagent.session.append(\"tool/result\", {\n\t\t\t\t\tturn,\n\t\t\t\t\tstep,\n\t\t\t\t\tmessage,\n\t\t\t\t\t...result.error?.info ? { error: result.error.info } : {},\n\t\t\t\t\t...result.meta !== void 0 ? { meta: result.meta } : {}\n\t\t\t\t}, {\n\t\t\t\t\tsurfaceOp: \"append\",\n\t\t\t\t\tsourceEventSeqs: [callSeq]\n\t\t\t\t});\n\t\t\t} else {\n\t\t\t\tagent.session.append(\"user/message\", lateToolResultNotice(block, message, {\n\t\t\t\t\tturn,\n\t\t\t\t\tstep\n\t\t\t\t}), { surfaceOp: \"append\" });\n\t\t\t\tconsole.warn(`[dsh-patch] tool result for ${block.name} (${block.id}) arrived after turn ${turn} step ${step} was closed (open turn=${String(open.turn)}, open step=${String(open.step)}); delivered as a runtime-context message instead of corrupting the stored log`);\n\t\t\t}\n\t\t}\n\t\tthis.results.push({\n\t\t\tcallId: block.id,"
  }
]

/**
 * 定位 `@deepseek-ai` 目录（其中含 dsh-session、dsh-tools 等包）。
 * @param {string | undefined} explicit --root 指定的目录。
 * @returns {string} 已验证存在的包目录。
 */
function dshPackagesRoot(explicit) {
	const candidates = []
	if (explicit !== undefined) candidates.push(explicit)
	if (process.env.DSH_PACKAGES_ROOT !== undefined) candidates.push(process.env.DSH_PACKAGES_ROOT)
	if (process.env.PREFIX !== undefined) candidates.push(join(process.env.PREFIX, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'))
	try {
		candidates.push(join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@deepseek-ai/dsh/node_modules/@deepseek-ai'))
	} catch {}
	for (const candidate of candidates) if (existsSync(join(candidate, PROBE))) return candidate
	throw new Error(`找不到 @deepseek-ai 包目录（该目录下应有 ${PROBE}）；请用 --root <dir> 指定，或在 Termux 下确认 PREFIX 已设置`)
}

/**
 * 报告一个文件是"已打补丁"还是"原始状态"：该文件的每个补丁块都已出现才算打过。
 * @param root - 包目录。
 * @param file - 相对包目录的文件路径。
 * @returns 相对路径与状态。
 */
function fileState(root, file) {
	const path = join(root, file)
	if (!existsSync(path)) return { path, state: 'missing' }
	const content = readFileSync(path, 'utf8')
	const blocks = PATCHES.filter((patch) => patch.file === file)
	const done = blocks.filter((patch) => content.includes(patch.new)).length
	if (done === blocks.length) return { path, state: 'patched' }
	return { path, state: done === 0 ? 'stock' : 'partial' }
}

/**
 * 逐块应用补丁；已应用的块跳过，锚点不匹配时中止且不写坏文件。
 * @param root - 包目录。
 */
function apply(root) {
	let applied = 0
	let already = 0
	for (const patch of PATCHES) {
		const path = join(root, patch.file)
		if (!existsSync(path)) throw new Error(`缺少目标文件 ${path}：dsh 版本可能已变化，请重新生成补丁`)
		let content = readFileSync(path, 'utf8')
		if (content.includes(patch.new)) {
			already += 1
			continue
		}
		if (!content.includes(patch.old)) throw new Error(`补丁锚点不匹配：${patch.file}\n该文件与生成补丁时的 dsh 版本不一致，已中止`)
		if (!existsSync(path + BACKUP_SUFFIX)) copyFileSync(path, path + BACKUP_SUFFIX)
		content = content.replace(patch.old, patch.new)
		writeFileSync(path, content)
		applied += 1
	}
	console.log(`已应用 ${applied} 块，跳过 ${already} 块（已是补丁后状态）`)
}

/**
 * 从 `.pre-session-fixes.bak` 还原被改过的文件。
 * @param root - 包目录。
 */
function revert(root) {
	let restored = 0
	for (const file of new Set(PATCHES.map((patch) => patch.file))) {
		const path = join(root, file)
		const backup = path + BACKUP_SUFFIX
		if (!existsSync(backup)) continue
		copyFileSync(backup, path)
		const content = readFileSync(path, 'utf8')
		for (const patch of PATCHES) {
			if (patch.file === file && content.includes(patch.new)) throw new Error(`回滚后 ${file} 仍是补丁后状态，请手工检查`)
		}
		restored += 1
	}
	console.log(restored === 0 ? '没有可回滚的备份（这些文件不是由本脚本打补丁的）' : `已回滚 ${restored} 个文件`)
}

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
const explicitRoot = rootFlag === -1 ? undefined : argv[rootFlag + 1]
const root = dshPackagesRoot(explicitRoot)
console.log(`@deepseek-ai 目录：${root}`)

if (argv.includes('--check')) {
	for (const file of new Set(PATCHES.map((patch) => patch.file))) {
		const { state } = fileState(root, file)
		const label = { missing: '缺失', stock: '未打补丁', partial: '部分补丁', patched: '已打补丁' }[state]
		console.log(`  ${label}\t${file}`)
	}
} else if (argv.includes('--revert')) {
	revert(root)
	console.log('重启 dsh-app 后回滚生效。')
} else {
	apply(root)
	console.log('重启 dsh-app 后生效。')
}
