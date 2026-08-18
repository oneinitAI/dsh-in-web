/**
 * Bridge transport for AbstractApiClient over Chrome extension messaging.
 *
 * Replaces the harness fetch/WebSocket carrier so the iframe'd dsh UI talks to
 * this extension's background service worker instead of the real harness
 * backend: unary/respond go through chrome.runtime.sendMessage, mux/host
 * streams through a chrome.runtime.Port. Every protocol invariant (rpcId
 * minting, envelope wrap/unwrap, zod parsing, value parse) stays in the
 * inherited AbstractApiClient — this file only supplies the physical transport
 * (doFetch + openMux/openHost), exactly the seam the base class exposes.
 */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema';
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';
import type { HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api';

/** One enqueued stream event: a parsed frame or the end-of-stream marker. */
type InboxItem<F> =
  | { kind: 'end' }
  | { kind: 'frame'; envelope: RpcRequest<F> };

/** Structural stand-in for the zod frame schema (private helper — no zod import needed). */
interface FrameSchema<F> {
  parse(value: unknown): F;
}

/** Browser API carrier whose physical transport is the background service worker. */
export class BridgeApiClient extends AbstractApiClient {
  constructor(timeoutMs?: number) {
    super(timeoutMs);
  }

  /**
   * Unary/respond transport: the background SW's `/api/<method>` facade over
   * chrome.runtime.sendMessage. The base class then parses the echoed envelope
   * (serverResponseSchema), verifies the rpcId echo, and narrows the value —
   * this override never re-parses. Abort surfaces as an abort, not a transport
   * failure, mirroring fetch's rejection on signal abort.
   */
  override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const method = methodFromPath(input.pathname);
    const body: unknown = JSON.parse(String(init?.body ?? '{}'));
    // RequestInit.signal is AbortSignal | null — normalize null away so the
    // abort checks below only deal with undefined (fetch treats null as absent).
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw abortError(signal);
    const message = { kind: 'dsh-rpc', method, body };
    let reply: unknown;
    try {
      reply = signal === undefined
        ? await chrome.runtime.sendMessage(message)
        : await raceSignal(chrome.runtime.sendMessage(message), signal);
    } catch (error) {
      if (isAborted(signal)) throw abortError(signal);
      throw transportFailure(`/api/${method}`, error);
    }
    return new Response(JSON.stringify(unwrapResultBody(reply, `/api/${method}`)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  override async *openMux(
    _payload: unknown,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<MuxFrame>> {
    yield* this.readStream('mux', signal, muxFrameSchema, onOpen);
  }

  override async *openHost(
    _payload: unknown,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<HostFrame>> {
    yield* this.readStream('host', signal, hostFrameSchema, onOpen);
  }

  /**
   * Stream transport: one chrome.runtime.Port per downstream, mirroring
   * readWebSocket/readSse mechanics — inbox/wake queue, onOpen firing once the
   * stream is established (on the 'dsh-stream-ok' handshake, or lazily before
   * the first frame if that handshake was missed), envelope + frame-schema
   * parse with skip-and-report on a malformed frame, and end-on-disconnect /
   * abort.
   */
  private async *readStream<F extends MuxFrame | HostFrame>(
    stream: 'mux' | 'host',
    signal: AbortSignal,
    frameSchema: FrameSchema<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const port = chrome.runtime.connect({ name: 'dsh-stream' });
    const inbox: InboxItem<F>[] = [];
    let wake: (() => void) | undefined;
    let opened = false;
    let ended = false;

    const enqueue = (item: InboxItem<F>): void => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const fireOpen = (): void => {
      if (opened) return;
      opened = true;
      onOpen?.();
    };
    const handleMessage = (raw: unknown): void => {
      if (typeof raw !== 'object' || raw === null || !('kind' in raw)) return;
      if (raw.kind === 'dsh-stream-ok') {
        fireOpen();
        return;
      }
      if (raw.kind !== 'dsh-stream-frame' || !('body' in raw)) return;
      // The background handshake may be missed; the first frame proves the
      // stream is live, so treat it as connected before yielding it.
      fireOpen();
      let full: ServerRequest;
      let frame: F;
      try {
        full = serverRequestSchema.parse(raw.body);
        frame = frameSchema.parse(full.payload);
      } catch (error) {
        console.error(`[dsh-bridge] dropping malformed ${stream} frame:`, error);
        return;
      }
      this.onEnvelope(full);
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } });
    };
    const handleDisconnect = (): void => {
      ended = true;
      enqueue({ kind: 'end' });
    };
    const handleAbort = (): void => {
      if (ended) return;
      ended = true;
      port.disconnect();
    };

    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    signal.addEventListener('abort', handleAbort, { once: true });
    if (signal.aborted) handleAbort();
    port.postMessage({ kind: 'dsh-stream-subscribe', stream });
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item === undefined) break;
          if (item.kind === 'end') return;
          yield item.envelope;
        }
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      signal.removeEventListener('abort', handleAbort);
      port.onMessage.removeListener(handleMessage);
      port.onDisconnect.removeListener(handleDisconnect);
      handleAbort();
    }
  }
}

/** Extract the RPC method from the request path: '/api/session.prompt' -> 'session.prompt', '/api/respond' -> 'respond'. */
function methodFromPath(pathname: string): string {
  const prefix = '/api/';
  if (pathname.startsWith(prefix)) return pathname.slice(prefix.length);
  return pathname.replace(/^\/+/, '');
}

/** Validate the bridge reply shape ({ kind: 'dsh-rpc:result', body }) and return its body. */
function unwrapResultBody(reply: unknown, target: string): unknown {
  if (
    typeof reply === 'object' && reply !== null
    && 'kind' in reply && reply.kind === 'dsh-rpc:result'
    && 'body' in reply
  ) {
    return reply.body;
  }
  throw new Error(`transport failure for ${target}: unexpected bridge reply`);
}

/** True when the caller/connection signal has aborted. Read through a call so a stale
 *  control-flow narrow (the pre-send `signal?.aborted === true` guard) cannot poison
 *  this later check — the signal may abort while the message is in flight. */
function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

/** Mirror the harness's transport throw (postJson): an Error naming the failing target. */
function transportFailure(target: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`transport failure for ${target}: ${detail}`);
}

/** Mirror fetch's abort rejection: the signal's reason when present, else a DOMException-style AbortError. */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string') return new Error(reason);
  return new Error('This operation was aborted');
}

/** Reject on signal abort even while the message is in flight (sendMessage takes no signal). */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}
