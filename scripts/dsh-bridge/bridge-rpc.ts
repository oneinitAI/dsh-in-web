/**
 * dsh-in-web — DeepSeek Harness (dsh) in the browser.
 *
 * This file embeds/adapts code from deepseek-ai/DeepSeek-Harness (dsh),
 * distributed under the MIT License.
 *
 * Copyright (c) 2026 DeepSeek (dsh / DeepSeek-Harness)
 * Copyright (c) 2026 oneinitAI
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Generic Connection unary RPC caller over Chrome extension messaging.
 *
 * Mirrors createWebConnectionRpc from the harness (identical channel/endpoint
 * validation, rpcId mint + echo check, serverResponseSchema parse, error
 * semantics) but replaces the fetch transport with chrome.runtime.sendMessage
 * to the background service worker. Exported surface is the same shape as the
 * harness client caller ({ call }) — `intercept` belongs to the Host-side RPC
 * registry (rpc-host), not to this client caller.
 */
import { RpcId, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api';
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api';
import { isContextInvalidated, recoverInvalidatedContext } from './context-recovery';

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** Client caller for logical RPC channels carried by the bridge transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>;
}

/** Create the chrome.runtime-backed generic RPC caller. */
export function createBridgeConnectionRpc(): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload, signal) {
      assertTarget(channel, endpoint);
      const rpcId = RpcId(randomUuid());
      const message = {
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      };
      if (signal?.aborted === true) throw abortError(signal);
      let reply: unknown;
      try {
        reply = signal === undefined
          ? await chrome.runtime.sendMessage({ kind: 'dsh-rpc', method: endpoint, body: message })
          : await raceSignal(chrome.runtime.sendMessage({ kind: 'dsh-rpc', method: endpoint, body: message }), signal);
      } catch (error) {
        if (isAborted(signal)) throw abortError(signal);
        if (isContextInvalidated(error)) recoverInvalidatedContext();
        throw new Error(`transport failure for ${channel}/${endpoint}: ${describe(error)}`);
      }
      const full = serverResponseSchema.parse(unwrapResultBody(reply, `${channel}/${endpoint}`));
      if (full.rpcId !== rpcId) {
        throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
      }
      return full.result;
    },
  };
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

/** Mirror rpc.js target validation (channel prefix + safe endpoint segments). */
function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/');
  if (
    !CHANNEL_PATTERN.test(channel)
    || segments.some((segment) => (
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment)
    ))
  ) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`);
  }
}

/** True when the caller/connection signal has aborted. Read through a call so a stale
 *  control-flow narrow (the pre-send `signal?.aborted === true` guard) cannot poison
 *  this later check — the signal may abort while the message is in flight. */
function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  return signal?.aborted === true;
}

/** Mirror the harness's abort rejection (signal reason or AbortError-style message). */
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * RFC 4122 version 4 UUID via crypto.getRandomValues (the harness random-uuid
 * fallback, safe on insecure origins) — correlation id for each call.
 */
function randomUuid(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
