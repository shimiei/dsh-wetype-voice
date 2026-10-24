/**
 * dsh-wetype-voice — host half.
 *
 * The browser half renders a microphone button in the composer and posts to
 * `POST /wetype/api`. This half owns the machine-local part: it presses the
 * WeChat Input Method (WeType) dictation hotkey through a warm PowerShell
 * helper (see injector.js / injector.ps1), so transcription is done by WeType
 * instead of the bundled SenseVoice model.
 *
 * Routes are package-private and same-origin guarded, the same convention
 * dsh-purge uses for its redteam bridge: the profile plugin tree cannot resolve
 * typert/@Remote contributions, so a named webServer route is the smallest
 * stable seam between the two halves.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HotkeyInjector } from './injector.js'

export const name = 'wetype-voice'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'injector.ps1')
const ROUTE = '/wetype/api'
const MAX_BODY = 8 * 1024

const DEFAULTS = Object.freeze({
  // WeType's stock "启动语音输入" binding on this machine is RightAlt + Space;
  // override through $DSH_HOME/wetype-voice.json if it is rebound.
  hotkey: 'ralt+space',
  injectMode: 'scan',
  guard: 'auto',
  allowProcesses: Object.freeze([]),
  leadMs: 60,
  overrideFile: '',
})

// Chords tried by {op:'detect'} on a machine whose WeType binding is unknown.
// Ordered from the most likely stock binding outwards.
const DETECT_CANDIDATES = Object.freeze([
  'ralt+space',
  'rctrl+space',
  'lalt+space',
  'ctrl+space',
  'ctrl+alt+space',
  'rctrl+ralt+space',
  'lctrl+space',
  'shift+space',
  'lalt+shift',
  'ralt+shift',
])

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Locate an installed WeType (微信输入法) and report its newest version directory. */
function probeWeType() {
  // WeType installs per-machine by default but also offers a per-user install,
  // so probe every location it is known to use.
  const roots = [
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tencent', 'WeType'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'WeType'),
    join(process.env['ProgramW6432'] || 'C:\\Program Files', 'Tencent', 'WeType'),
    join(process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local'), 'Tencent', 'WeType'),
  ].filter((root, index, all) => all.indexOf(root) === index)
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => {
        const left = a.split('.').map(Number)
        const right = b.split('.').map(Number)
        for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
          const diff = (right[i] || 0) - (left[i] || 0)
          if (diff !== 0) return diff
        }
        return 0
      })
    return { installed: true, root, version: versions[0] || null }
  }
  return { installed: false, root: null, version: null }
}

/**
 * @param ctx cordis plugin context (webServer is guaranteed by `inject`).
 * @param config loader config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const base = { ...DEFAULTS, ...(config || {}) }
  const overrideFile = base.overrideFile && String(base.overrideFile).trim() !== ''
    ? resolve(String(base.overrideFile))
    : join(dshHome(), 'wetype-voice.json')

  const log = (message) => {
    try {
      ctx.logger?.info?.(`[wetype-voice] ${message}`)
    } catch { /* logging is best effort */ }
  }

  const injector = new HotkeyInjector({
    scriptPath: SCRIPT_PATH,
    expectedExeName: (() => {
      try {
        return process.execPath.split(/[\\/]/).pop() || ''
      } catch {
        return ''
      }
    })(),
    log,
  })

  /** Effective settings: patch config plus the restart-free override file. */
  const settings = () => {
    const override = readJson(overrideFile) || {}
    const merged = { ...base }
    for (const key of ['hotkey', 'injectMode', 'guard', 'leadMs']) {
      if (override[key] !== undefined && override[key] !== null && override[key] !== '') merged[key] = override[key]
    }
    if (Array.isArray(override.allowProcesses)) merged.allowProcesses = override.allowProcesses
    merged.overrideFile = overrideFile
    merged.expectedExeName = injector.expectedExeName
    return merged
  }

  const state = {
    lastResult: null,
    lastAt: null,
    triggers: 0,
  }

  const trigger = async () => {
    const active = settings()
    const result = await injector.send({
      hotkey: active.hotkey,
      guard: active.guard,
      allowProcesses: active.allowProcesses,
      leadMs: Number(active.leadMs) || 0,
      mode: active.injectMode,
    })
    state.lastResult = result
    state.lastAt = new Date().toISOString()
    if (result.ok) state.triggers += 1
    log(`trigger ${result.ok ? 'ok' : `failed (${result.code}: ${result.detail})`}`)
    return result
  }

  const writeOverride = (patch) => {
    const current = readJson(overrideFile) || {}
    const next = { ...current, ...patch }
    writeFileSync(overrideFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  }

  const handle = async (request) => {
    const op = typeof request?.op === 'string' ? request.op : 'status'
    switch (op) {
      case 'status': {
        const active = settings()
        return {
          ok: true,
          op,
          hotkey: active.hotkey,
          injectMode: active.injectMode,
          guard: active.guard,
          allowProcesses: active.allowProcesses,
          leadMs: active.leadMs,
          overrideFile,
          expectedExeName: active.expectedExeName,
          scriptPath: SCRIPT_PATH,
          weType: probeWeType(),
          lastResult: state.lastResult,
          lastAt: state.lastAt,
          triggers: state.triggers,
        }
      }
      case 'trigger':
      case 'start':
      case 'stop': {
        const result = await trigger()
        return {
          ok: result.ok,
          op,
          code: result.code,
          detail: result.detail,
          hotkey: settings().hotkey,
        }
      }
      case 'ping': {
        const line = await injector.ping()
        return { ok: line.startsWith('READY'), op, detail: line }
      }
      case 'state': {
        const voice = await injector.state(typeof request.titleNeedle === 'string' ? request.titleNeedle : '语音')
        return { ok: true, op, listening: voice.listening, detail: voice.detail }
      }
      case 'setHotkey': {
        const hotkey = String(request.hotkey || '').trim()
        if (hotkey === '') return { ok: false, op, error: 'hotkey is required' }
        if (!/^[a-z0-9+'"`;,\-.\/\[\]\\= ]+$/i.test(hotkey)) return { ok: false, op, error: 'hotkey has unsupported characters' }
        writeOverride({ hotkey: hotkey.toLowerCase() })
        return { ok: true, op, hotkey: hotkey.toLowerCase(), overrideFile }
      }
      case 'setGuard': {
        const guard = String(request.guard || '').trim()
        if (!['auto', 'any', 'list'].includes(guard)) return { ok: false, op, error: 'guard must be auto, list or any' }
        const allowProcesses = Array.isArray(request.allowProcesses)
          ? request.allowProcesses.map((item) => String(item)).filter((item) => item.trim() !== '')
          : undefined
        writeOverride(allowProcesses ? { guard, allowProcesses } : { guard })
        return { ok: true, op, guard, allowProcesses: allowProcesses || settings().allowProcesses }
      }
      // Walk a ladder of candidate chords until one opens WeType's dictation
      // window, so a fresh machine does not need its binding configured by hand.
      case 'detect': {
        const active = settings()
        const candidates = Array.isArray(request?.candidates) && request.candidates.length > 0
          ? request.candidates.map((item) => String(item).toLowerCase())
          : [...DETECT_CANDIDATES]
        const args = {
          guard: active.guard,
          allowProcesses: active.allowProcesses,
          leadMs: Number(active.leadMs) || 0,
          mode: active.injectMode,
        }
        const tried = []
        for (const candidate of candidates) {
          const sent = await injector.send({ ...args, hotkey: candidate })
          if (!sent.ok) {
            tried.push({ hotkey: candidate, result: sent.code, detail: sent.detail })
            // A guard rejection repeats identically for every candidate.
            if (sent.code === 'SKIP') break
            continue
          }
          let hit = false
          for (let attempt = 0; attempt < 8; attempt += 1) {
            await sleep(150)
            const voice = await injector.state('语音')
            if (voice.listening) {
              hit = true
              break
            }
          }
          tried.push({ hotkey: candidate, result: hit ? 'hit' : 'miss' })
          if (!hit) continue
          await injector.send({ ...args, hotkey: candidate }) // toggle dictation back off
          if (request?.persist === true) writeOverride({ hotkey: candidate })
          return {
            ok: true,
            op,
            hotkey: candidate,
            persisted: request?.persist === true,
            overrideFile: request?.persist === true ? overrideFile : undefined,
            tried,
          }
        }
        return {
          ok: false,
          op,
          error: 'no candidate chord opened the WeType 语音输入 window',
          hint: '把 DSH 窗口切到前台并保持焦点，或先在微信输入法设置里确认「启动语音输入」的绑定',
          tried,
          candidates,
        }
      }
      // Bulk save used by the plugin panel form: validate everything first, then
      // write once so a rejected field cannot leave a half-applied config.
      case 'save': {
        const patch = {}
        const body = request || {}
        if (typeof body.hotkey === 'string' && body.hotkey.trim() !== '') {
          const hotkey = body.hotkey.trim().toLowerCase()
          if (!/^[a-z0-9+'"`;,\-.\/\[\]\\= ]+$/i.test(hotkey)) {
            return { ok: false, op, error: 'hotkey has unsupported characters' }
          }
          patch.hotkey = hotkey
        }
        if (body.injectMode !== undefined) {
          const mode = String(body.injectMode)
          if (!['scan', 'vk', 'both'].includes(mode)) return { ok: false, op, error: 'injectMode must be scan, vk or both' }
          patch.injectMode = mode
        }
        if (body.guard !== undefined) {
          const guard = String(body.guard)
          if (!['auto', 'any', 'list'].includes(guard)) return { ok: false, op, error: 'guard must be auto, list or any' }
          patch.guard = guard
        }
        if (body.allowProcesses !== undefined) {
          if (!Array.isArray(body.allowProcesses)) return { ok: false, op, error: 'allowProcesses must be an array' }
          patch.allowProcesses = body.allowProcesses
            .map((item) => String(item).trim())
            .filter((item) => item !== '')
        }
        if (body.leadMs !== undefined) {
          const leadMs = Number(body.leadMs)
          if (!Number.isFinite(leadMs) || leadMs < 0 || leadMs > 2000) return { ok: false, op, error: 'leadMs must be 0-2000' }
          patch.leadMs = Math.round(leadMs)
        }
        if (Object.keys(patch).length === 0) return { ok: false, op, error: 'nothing to save' }
        writeOverride(patch)
        return { ok: true, op, saved: patch, settings: settings() }
      }
      case 'probe': {
        return { ok: true, op, weType: probeWeType() }
      }
      default:
        return { ok: false, op, error: `unknown op '${op}'` }
    }
  }

  // Never let this optional plugin take the whole profile down: a failed route
  // registration only means the microphone button reports a transport error.
  let disposeRoute
  try {
  disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' })
        return
      }
      // Loopback clients are trusted; anything else must be same-origin.
      const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const host = typeof req.headers.host === 'string' ? req.headers.host : ''
      const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
      const origin = req.headers.origin
      let originOk = loopback
      if (!originOk && hostLocal) {
        if (origin === undefined || origin === '' || origin === 'null') originOk = true
        else if (typeof origin === 'string' && /^app:/i.test(origin)) originOk = true
        else {
          try {
            originOk = new URL(origin).host === host
          } catch {
            originOk = false
          }
        }
      }
      if (!originOk) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      try {
        const raw = await readBody(req)
        const request = raw.trim() === '' ? {} : JSON.parse(raw)
        const payload = await handle(request)
        sendJson(res, payload.ok === false ? 400 : 200, payload)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  } catch (error) {
    log(`route registration failed: ${error && error.message ? error.message : String(error)}`)
    return
  }

  ctx.effect(() => {
    log(`route ${ROUTE} ready (hotkey ${settings().hotkey}, guard ${settings().guard})`)
    return () => {
      injector.dispose()
      disposeRoute()
    }
  })
}
