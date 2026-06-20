/**
 * hook-registry.mjs — minimal hook profile registry
 *
 * The runtime hook settings live in `.claude/settings.json` and
 * `.codex/hooks.json`. This registry keeps profile gating in
 * `hook-flags.mjs` aligned with the hook modules that remain in this repo.
 */

export const VALID_EVENT_TYPES = new Set([
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionStart',
]);

export const ORCHESTRATOR_DISPATCHERS = [];
export const PROMPT_AGENT_HOOKS = {};

export const HOOK_REGISTRY = {
  SessionStart: [
    {
      matcher: '',
      hooks: [
        {
          id: 'trunk-start-warning',
          module: './trunk-start-warning.mjs',
          priority: 10,
          profile: 'minimal',
          orchestrated: false,
          timeout: 10,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: 'Edit|Write|MultiEdit',
      hooks: [
        {
          id: 'worktree-policy-guard',
          module: './worktree-policy-guard.mjs',
          priority: 10,
          profile: 'minimal',
          orchestrated: false,
          timeout: 5,
        },
        {
          id: 'worktree-session-owner-guard',
          module: './worktree-session-owner-guard.mjs',
          priority: 20,
          profile: 'standard',
          orchestrated: false,
          timeout: 5,
        },
      ],
    },
    {
      matcher: 'Bash',
      hooks: [
        {
          id: 'destructive-git-guard',
          module: './destructive-git-guard.mjs',
          priority: 10,
          profile: 'minimal',
          orchestrated: false,
          timeout: 30,
        },
        {
          id: 'commit-guard',
          module: './commit-guard.mjs',
          priority: 20,
          profile: 'standard',
          orchestrated: false,
          timeout: 30,
        },
        {
          id: 'worktree-session-owner-guard',
          module: './worktree-session-owner-guard.mjs',
          priority: 30,
          profile: 'standard',
          orchestrated: false,
          timeout: 5,
        },
        {
          id: 'pre-ship-review-guard',
          module: './pre-ship-review-guard.mjs',
          priority: 40,
          profile: 'minimal',
          orchestrated: false,
          timeout: 30,
        },
      ],
    },
  ],
  Stop: [
    {
      matcher: '',
      hooks: [
        {
          id: 'worktree-shipping-guard',
          module: './worktree-shipping-guard.mjs',
          priority: 10,
          profile: 'minimal',
          orchestrated: false,
          timeout: 10,
        },
        {
          id: 'worktree-review-report-guard',
          module: './worktree-review-report-guard.mjs',
          priority: 20,
          profile: 'minimal',
          orchestrated: false,
          timeout: 10,
        },
      ],
    },
  ],
};

export function matchesTool(matcher, toolName) {
  if (matcher === '*' || matcher === '') return true;
  return matcher.split('|').some((m) => m.trim() === toolName);
}

export function getHooksForEvent(event, toolName) {
  const groups = HOOK_REGISTRY[event] || [];
  const matched = [];
  for (const group of groups) {
    if (matchesTool(group.matcher, toolName)) matched.push(...group.hooks);
  }
  return matched.sort((a, b) => (a.priority || 50) - (b.priority || 50));
}

export function flattenRegistry() {
  const out = [];
  for (const [event, groups] of Object.entries(HOOK_REGISTRY)) {
    for (const group of groups) {
      for (const hook of group.hooks) out.push({ event, matcher: group.matcher, ...hook });
    }
  }
  return out;
}

export function getRegistryStats() {
  const flat = flattenRegistry();
  return {
    total: flat.length,
    byProfile: {
      minimal: flat.filter((hook) => hook.profile === 'minimal').length,
      standard: flat.filter((hook) => hook.profile === 'standard').length,
      none: flat.filter((hook) => hook.profile === 'none' || hook.profileChecked === false).length,
    },
    orchestrated: flat.filter((hook) => hook.orchestrated).length,
    standalone: flat.filter((hook) => hook.orchestrated === false).length,
  };
}
