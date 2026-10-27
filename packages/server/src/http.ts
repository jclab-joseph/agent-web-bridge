import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ClientCommand, ServerEvent } from '@agent-web-bridge/protocol'
import { BridgeError, errorMessage, type AgentBridge } from './bridge'

export interface HandlerOptions {
  /** Path prefix the routes are mounted under, e.g. `/api/agent`. */
  basePath?: string
  /** Interval for SSE keep-alive comments. */
  keepAliveMs?: number
  /** Largest accepted command body; messages with images are the big ones. Default 30 MB. File uploads have their own limit, `BridgeOptions.maxUploadBytes`. */
  maxBodyBytes?: number
  /**
   * Server-side data to store with a session created by this request, e.g. the
   * authenticated user. It reaches the agent provider (see `queryOptions` of the
   * Claude Code provider) and is never sent to clients.
   */
  sessionMeta?: (request: Request) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
}

const DEFAULT_MAX_BODY_BYTES = 30 * 1024 * 1024

/**
 * Routes (relative to `basePath`):
 * - `GET  /events`                  Server-sent events: `hello`, then every {@link ServerEvent}
 * - `GET  /sessions/:id/messages`   Transcript of one session
 * - `POST /commands`                A {@link ClientCommand}; responds `{ session }` for `session.create`
 * - `POST /sessions/:id/files?name=` Raw file body; responds `{ file }` to attach with `session.send`
 *
 * Authentication is up to the host: put this behind your own middleware.
 * Returns `undefined` for paths it does not own.
 */
export function createFetchHandler(bridge: AgentBridge, options: HandlerOptions = {}) {
  const basePath = (options.basePath ?? '').replace(/\/+$/, '')
  const keepAliveMs = options.keepAliveMs ?? 20_000
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  return async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(basePath)) return undefined
    const path = url.pathname.slice(basePath.length) || '/'

    try {
      if (request.method === 'GET' && path === '/events') return events(bridge, request.signal, keepAliveMs)

      const messages = path.match(/^\/sessions\/([^/]+)\/messages$/)
      if (request.method === 'GET' && messages) {
        return Response.json(await bridge.listMessages(decodeURIComponent(messages[1]!)))
      }

      const files = path.match(/^\/sessions\/([^/]+)\/files$/)
      if (request.method === 'POST' && files) {
        if (Number(request.headers.get('content-length')) > bridge.maxUploadBytes) {
          throw new BridgeError(413, 'File is too large')
        }
        const name = url.searchParams.get('name') ?? ''
        const file = await bridge.uploadFile(decodeURIComponent(files[1]!), name, chunks(request))
        return Response.json({ file })
      }

      if (request.method === 'POST' && path === '/commands') {
        const body = await readText(request, maxBodyBytes)
        const command = parseJson(body) as ClientCommand | undefined
        if (!command || typeof command.type !== 'string') throw new BridgeError(400, 'Invalid command')
        const meta = command.type === 'session.create' ? await options.sessionMeta?.(request) : undefined
        const session = await bridge.handle(command, { meta })
        return Response.json(session ? { session } : { ok: true })
      }
      return undefined
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500
      return Response.json({ error: errorMessage(error) }, { status })
    }
  }
}

async function* chunks(request: Request): AsyncIterable<Uint8Array> {
  if (!request.body) return
  const reader = request.body.getReader()
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) yield chunk.value
  } finally {
    reader.releaseLock()
  }
}

/** Reads the body as text, failing as soon as it passes `limit` bytes. */
async function readText(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) throw new BridgeError(413, 'Request too large')
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of chunks(request)) {
    size += chunk.byteLength
    if (size > limit) throw new BridgeError(413, 'Request too large')
    parts.push(chunk)
  }
  return Buffer.concat(parts).toString('utf8')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function events(bridge: AgentBridge, signal: AbortSignal, keepAliveMs: number): Response {
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          cleanup()
        }
      }
      const send = (event: ServerEvent) => write(`data: ${JSON.stringify(event)}\n\n`)

      // Subscribe before reading the snapshot so no event falls in between.
      const queued: ServerEvent[] = []
      let ready = false
      const unsubscribe = bridge.subscribe((event) => (ready ? send(event) : queued.push(event)))
      const keepAlive = setInterval(() => write(': ping\n\n'), keepAliveMs)
      cleanup = () => {
        unsubscribe()
        clearInterval(keepAlive)
      }
      signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      })

      send({ type: 'hello', now: Date.now(), agents: bridge.agents, sessions: await bridge.listSessions() })
      queued.forEach(send)
      ready = true
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Node `http` / express adapter for {@link createFetchHandler}.
 * Calls `next()` (when given) for paths the bridge does not own.
 */
export function createNodeHandler(bridge: AgentBridge, options: HandlerOptions = {}) {
  const handle = createFetchHandler(bridge, options)

  return async function nodeHandler(req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) {
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      const url = new URL(req.originalUrl ?? req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      // Streamed, so uploads are written to disk as they arrive; the fetch handler enforces the size limits.
      const body = req.method === 'POST' ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined
      const response = await handle(
        new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body,
          duplex: 'half',
          signal: controller.signal,
        } as RequestInit),
      )
      if (!response) return next ? next() : res.writeHead(404).end()

      const headers = Object.fromEntries(response.headers)
      // The rest of a body left unread (a rejected upload) would be taken for the next request on this connection.
      if (body && !req.complete) headers.connection = 'close'
      res.writeHead(response.status, headers)
      if (!response.body) return res.end()
      const reader = response.body.getReader()
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) res.write(chunk.value)
      res.end()
    } catch (error) {
      if (controller.signal.aborted) return
      if (next) return next(error)
      res.writeHead(500).end()
    }
  }
}

declare module 'node:http' {
  interface IncomingMessage {
    /** Set by express when the handler is mounted under a path. */
    originalUrl?: string
  }
}
