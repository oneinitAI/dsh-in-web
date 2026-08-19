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
 * dsh-official-settings bundle entry.
 *
 * Bundles the official DeepSeek Harness settings seam into one browser-safe
 * module consumed by the dsh-in-web Service Worker:
 *
 *   - `@deepseek-ai/cordis`      (Context / Service — root context is fully
 *                                self-contained: fiber/registry/events/logger,
 *                                no Node dependency)
 *   - `@deepseek-ai/schemastery` (pure JS ESM schema validator)
 *   - `@deepseek-ai/dsh-settings` official source (`SettingsProvider` abstract
 *                                class + redaction + conflict semantics)
 *
 * This file is only ever fed to esbuild (see scripts/build-official-settings.mjs);
 * it is NOT part of the WXT/tsc compile graph, so the bare `@deepseek-ai/*`
 * specifiers are resolved by the build script's onResolve plugin instead of
 * node_modules resolution.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  SettingsConflictError,
  SettingsProvider,
  deepEqualJson,
  redactSecrets,
  settingsNamespace,
  type SettingsDescribeOptions,
  type SettingsDescriptor,
  type SettingsNamespace,
  type SettingsPathOp,
  type SettingsRegisterOptions,
  type SettingsScope,
} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

export {
  Context,
  Service,
  SettingsConflictError,
  SettingsProvider,
  deepEqualJson,
  redactSecrets,
  settingsNamespace,
  z,
}
export type {
  SettingsDescribeOptions,
  SettingsDescriptor,
  SettingsNamespace,
  SettingsPathOp,
  SettingsRegisterOptions,
  SettingsScope,
}
