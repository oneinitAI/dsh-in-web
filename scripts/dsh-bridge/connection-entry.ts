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
 * dsh client-connection plugin entry.
 *
 * Mirrors the harness client/index.ts apply() contract — build a ConnectionHandle
 * ({ api, isLoopback, hostDescription, rpc, start }) and `ctx.provide('connection',
 * handle)` — but with the transport swapped to the bridge (chrome.runtime) instead
 * of fetch/WebSocket, and the fixture branch dropped entirely (no FixtureApiClient:
 * that would drag dsh-llm/dsh-session into the bundle). Re-exports match index.js so
 * loader consumers keep working.
 *
 * The Cordis Context type is deliberately NOT imported: the build script maps only
 * @dsh-bridge/*, @deepseek-ai/dsh-host-apiproxy/* and zod, so @deepseek-ai/cordis
 * would fail the build. A minimal local Context shape (provide only) is enough for
 * the loader contract.
 */
import { ConnectionController } from '@dsh-bridge/connection-controller';
import type { ConnectionConfig, ConnectionSinks } from '@dsh-bridge/connection-controller';
import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api';
import { BridgeApiClient } from './bridge-api-client';
import { createBridgeConnectionRpc } from './bridge-rpc';
import type { ClientConnectionRpc } from './bridge-rpc';
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';

export { RpcId, transportError } from '@deepseek-ai/dsh-host-apiproxy/api';
export { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';

/** Required services (none — this is the wire root). */
export const inject: string[] = [];

/** Minimal Cordis context shape this plugin consumes (loader hands us a real Context). */
interface Context {
  /** Register a service on the context for later consumers. */
  provide(name: string, value: unknown): unknown;
}

/** Successful value returned by the connection-generation host handshake. */
type HostDescription = ResponseValue<'host.describe'>;

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined;
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void;
}

/**
 * The ctx.connection service API: the API client plus a one-shot controller
 * starter (the runtime plugin supplies sinks when its object layer is ready —
 * connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared API client over the bridge transport. */
  readonly api: IApiClient;
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean;
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource;
  /** Generic logical RPC channels over the same bridge transport. */
  readonly rpc: ClientConnectionRpc;
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void };
}

/**
 * Client plugin body: wire the bridge api/rpc, expose the loopback predicate,
 * and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const api = new BridgeApiClient()
  const rpc = createBridgeConnectionRpc()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-bridge] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    // 扩展内嵌 iframe 的 hostname 是扩展 ID（chrome-extension://<id>），
    // isLoopbackHostname 会误判为非 loopback → settingsScope 走 memory 模式
    // 完全不读写 RPC，导致插件配置/预设切换全部失效。扩展本身即本地宿主，
    // 恒为 loopback（host 模式）。
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
