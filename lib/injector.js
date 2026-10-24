/**
 * Keeps one PowerShell helper process warm and pumps hotkey commands into it.
 *
 * The helper (injector.ps1) compiles its P/Invoke layer once and then answers
 * one line per command, so a microphone click costs a pipe write instead of a
 * fresh `Add-Type` compile (~1s). A dead helper is transparently respawned.
 */
import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 8000
const SHELLS = ['pwsh', 'powershell']

export class HotkeyInjector {
  /**
   * @param {object} options
   * @param {string} options.scriptPath absolute path of injector.ps1
   * @param {string} [options.expectedExeName] image name of the host process, for the auto guard
   * @param {(message: string) => void} [options.log]
   */
  constructor({ scriptPath, expectedExeName = '', log = () => {} }) {
    this.scriptPath = scriptPath
    this.expectedExeName = expectedExeName
    this.log = log
    this.child = undefined
    this.buffer = ''
    this.pending = []
    this.ready = undefined
    this.stderrTail = ''
    this.disposed = false
  }

  /** Build the guard token the PS1 helper understands. */
  guardFor(guard, allowProcesses) {
    if (!guard || guard === 'auto') {
      return this.expectedExeName ? `auto:${this.expectedExeName}` : 'any'
    }
    if (guard === 'any') return 'any'
    if (Array.isArray(allowProcesses) && allowProcesses.length > 0) {
      return `list:${allowProcesses.join(';')}`
    }
    return this.expectedExeName ? `auto:${this.expectedExeName}` : 'any'
  }

  async ensure() {
    if (this.disposed) throw new Error('injector disposed')
    if (this.child) return this.ready
    const failure = []
    for (const shell of SHELLS) {
      try {
        return await this.#spawnShell(shell)
      } catch (error) {
        failure.push(`${shell}: ${error && error.message ? error.message : String(error)}`)
      }
    }
    throw new Error(`no PowerShell available (${failure.join('; ')})`)
  }

  #spawnShell(shell) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(shell, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        reject(error)
        return
      }

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        this.waiters.mark()
        this.waiters.readyReject(new Error(`${shell} did not report READY (${this.stderrTail.trim()})`))
        try { child.kill() } catch { /* ignore */ }
      }, DEFAULT_TIMEOUT_MS)

      this.child = child
      this.buffer = ''
      this.stderrTail = ''

      this.ready = new Promise((readyResolve, readyReject) => {
        this.waiters = {
          readyResolve,
          readyReject,
          timer,
          settled: () => settled,
          mark: () => { settled = true },
        }
      }).finally(() => {
        this.waiters = undefined
      })

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => this.#onData(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-4000)
      })

      child.on('error', (error) => {
        this.#failAll(error)
      })
      child.on('exit', (code) => {
        this.log(`injector exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`)
        this.#failAll(new Error(`injector exited (code ${code})`))
      })

      this.ready.then(() => resolve(), (error) => reject(error))
    })
  }

  #onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      this.#onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    // READY is both the startup banner and the answer to PING; only the first
    // one (while the helper is still booting) resolves the readiness promise.
    if (line.startsWith('READY') && this.waiters && !this.waiters.settled()) {
      this.waiters.mark()
      clearTimeout(this.waiters.timer)
      this.waiters.readyResolve()
      return
    }
    const waiter = this.pending.shift()
    if (!waiter) return
    clearTimeout(waiter.timer)
    waiter.resolve(line)
  }

  #failAll(error) {
    this.child = undefined
    const waiters = this.waiters
    if (waiters && !waiters.settled()) {
      waiters.mark()
      clearTimeout(waiters.timer)
      waiters.readyReject(error)
    }
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()
      clearTimeout(waiter.timer)
      waiter.resolve(`ERR|${error && error.message ? error.message : String(error)}`)
    }
  }

  async #command(line, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.ensure()
    const child = this.child
    if (!child || !child.stdin.writable) throw new Error('injector stdin closed')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(waiter)
        if (index >= 0) this.pending.splice(index, 1)
        resolve(`ERR|timeout after ${timeoutMs}ms`)
      }, timeoutMs)
      const waiter = { resolve, timer }
      this.pending.push(waiter)
      child.stdin.write(`${line}\n`, (error) => {
        if (!error) return
        const at = this.pending.indexOf(waiter)
        if (at >= 0) this.pending.splice(at, 1)
        clearTimeout(timer)
        resolve(`ERR|${error.message}`)
      })
    })
  }

  /**
   * Press one hotkey chord.
   * @param {object} request
   * @param {string} request.hotkey e.g. 'ctrl+alt+space'
   * @param {string} [request.guard] 'auto' | 'list' | 'any'
   * @param {string[]} [request.allowProcesses]
   * @param {number} [request.leadMs]
   * @param {string} [request.mode] 'scan' | 'vk' | 'both'
   * @returns {Promise<{ok: boolean, detail: string, code: string}>}
   */
  async send({ hotkey, guard, allowProcesses, leadMs = 60, mode = 'scan' }) {
    const safe = String(hotkey || '').trim().toLowerCase()
    if (safe === '' || /[|\r\n]/.test(safe)) {
      return { ok: false, code: 'ERR', detail: `invalid hotkey '${hotkey}'` }
    }
    const guardToken = this.guardFor(guard, allowProcesses)
    const modes = mode === 'both' ? ['scan', 'vk'] : [mode === 'vk' ? 'vk' : 'scan']
    const results = []
    for (const one of modes) {
      const line = await this.#command(`SEND|${safe}|${guardToken}|${Number(leadMs) || 0}|${one}`)
      results.push(line)
      const code = line.split('|')[0]
      if (code !== 'OK') return { ok: false, code, detail: line.slice(code.length + 1), results }
      if (modes.length > 1) await new Promise((resolve) => setTimeout(resolve, 120))
    }
    const code = results[results.length - 1].split('|')[0]
    return { ok: true, code, detail: results.join(' + '), results }
  }

  /** Round-trip check that the helper is alive. */
  async ping() {
    return await this.#command('PING')
  }

  /**
   * Whether WeType's dictation surface is visible right now.
   * @param {string} [titleNeedle] window-title fragment of the voice window
   * @returns {Promise<{listening: boolean, detail: string}>}
   */
  async state(titleNeedle = '语音') {
    const line = await this.#command(`STATE|${String(titleNeedle).replace(/[|\r\n]/g, '')}`)
    const parts = line.split('|')
    if (parts[0] !== 'OK') return { listening: false, detail: line }
    return { listening: parts[1] === 'visible', detail: line }
  }

  dispose() {
    this.disposed = true
    const child = this.child
    this.child = undefined
    if (!child) return
    try { child.stdin.write('QUIT\n') } catch { /* ignore */ }
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, 300)
  }
}
