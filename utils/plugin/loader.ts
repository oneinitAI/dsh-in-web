/**
 * Plugin loader — L0 data direct-load.
 *
 * Reads a dsh plugin directory from the virtual workspace:
 *   /plugins/<name>/dsh.plugin.json   (manifest)
 *   /plugins/<name>/SKILL.md          (skill declaration)
 *
 * Registers the SKILL.md into ctx.skills so the agent loop can use it,
 * with zero code modification (data-only plugins).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@/utils/fs/workspace'
import { parseSkillMd } from '@/utils/skills/skill'
import type { Skill } from '@/utils/skills/skill'

export interface PluginManifest {
  name: string
  version: string
  entry?: string
  /** skill source files relative to the plugin dir, e.g. ["SKILL.md"] */
  skills?: string[]
  /** tool schemas declared by the plugin */
  tools?: string[]
  /** prompt presets declared by the plugin */
  prompts?: string[]
}

export interface LoadedPlugin {
  name: string
  manifest: PluginManifest
  skill?: Skill
}

/** Build a LoadedPlugin from a manifest + optional SKILL.md source. */
export function pluginFromSource(
  name: string,
  manifest: PluginManifest,
  skillSrc?: string,
): LoadedPlugin {
  if (!manifest || typeof manifest !== 'object' || !manifest.name) {
    throw new Error(`invalid plugin manifest for "${name}"`)
  }
  const plugin: LoadedPlugin = { name, manifest }
  if (skillSrc) {
    plugin.skill = parseSkillMd(manifest.name, skillSrc)
  }
  return plugin
}

/** Load a plugin directory from the workspace and register data into ctx. */
export async function loadPlugin(
  ctx: Context,
  ws: Workspace,
  dir: string,
): Promise<LoadedPlugin> {
  const manifestPath = `${dir}/dsh.plugin.json`
  const manifestSrc = await ws.readText(manifestPath)
  if (!manifestSrc) throw new Error(`plugin manifest not found: ${manifestPath}`)
  const manifest = JSON.parse(manifestSrc) as PluginManifest
  if (!manifest.name) throw new Error(`invalid manifest: missing name in ${manifestPath}`)

  const loaded = pluginFromSource(manifest.name, manifest)

  // L0: load SKILL.md declarations into ctx.skills
  if (manifest.skills?.length) {
    for (const rel of manifest.skills) {
      const src = await ws.readText(`${dir}/${rel}`)
      if (src) {
        const skill = parseSkillMd(manifest.name, src)
        loaded.skill = skill
        ctx.skills.register(skill)
      }
    }
  }
  return loaded
}