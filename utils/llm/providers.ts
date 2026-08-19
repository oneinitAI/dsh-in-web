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
 * User-configured third-party OpenAI-compatible LLM providers.
 *
 * Stored in chrome.storage.local under 'dsh-llm-providers' as an array; the
 * active provider is used for native function calling in the agent loop,
 * falling back to the chat.deepseek.com web bridge when none is configured.
 */

export interface LlmProvider {
  id: string
  name: string
  provider: 'openai-compatible'
  apiKey: string
  baseURL: string
  model: string
  active: boolean
}

const STORAGE_KEY = 'dsh-llm-providers'

/** Read configured providers (empty when none). */
export async function getLlmProviders(): Promise<LlmProvider[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const list = stored[STORAGE_KEY]
    if (!Array.isArray(list)) return []
    return list.filter(isLlmProvider)
  } catch {
    return []
  }
}

function isLlmProvider(value: unknown): value is LlmProvider {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string'
    && typeof p.name === 'string'
    && typeof p.apiKey === 'string'
    && typeof p.baseURL === 'string'
    && typeof p.model === 'string'
}

/** Persist the provider list. */
export async function writeLlmProviders(list: LlmProvider[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: list })
  } catch {
    // ignore write failures (non-extension context)
  }
}

/** The active provider, or undefined when none configured. */
export async function getActiveLlmProvider(): Promise<LlmProvider | undefined> {
  const list = await getLlmProviders()
  return list.find((p) => p.active) ?? list[0]
}
