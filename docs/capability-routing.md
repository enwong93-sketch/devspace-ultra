# Capability Routing Contract

DevSpace Ultra routes user intent to one direct tool, reusable Skill, capability plugin, command adapter, or MCP surface before generic fallback work. The routing layer is owned by **DEV Space Local Gateway** and is shared by every Main/worker MCP session.

## Design

The contract follows progressive disclosure:

1. `capability_route` searches bounded routing metadata only.
2. It returns one `primary` route when eligible evidence is clear, plus a small ranked candidate set.
3. The agent follows `primary.nextAction`:
   - Skill: read exactly that `SKILL.md` with `capability_read` before substantive work.
   - Deferred plugin/MCP server: inspect exactly that plugin, and probe MCP only when the route says the schema is still deferred.
   - Command/MCP tool: call the exact returned target using its inspected input schema.
4. Full Skill instructions, MCP schemas, prompts, and resources are not loaded until selected.

`tool_search` is the unified direct/deferred entry point when a direct DevSpace tool, a workspace/user Agent Skill, and one or more installed capabilities may all apply. After `open_workspace`, pass its `workspaceId`. The router then combines `coreTools`, `workspaceSkillRouting`, `capabilityRouting`, a unified `deferredRouting`, linked Codex MCP candidates, and an exact `recommendedRoute` when the result is not ambiguous.

## Routable records

The runtime builds records for:

- `workspace-skill` through the generic `skill` route kind
- `plugin`
- `skill`
- `command-tool`
- `mcp-server`
- `mcp-tool`
- `mcp-prompt`
- `mcp-resource`
- `host-app` dependency

Every record has a stable `routeId`, descriptive fields, availability and policy state, prerequisites, and a machine-readable `nextAction`.

## Metadata sources

### Plugin metadata

`devspace-plugin.json` may define:

```json
{
  "id": "blender-production",
  "name": "Blender Production",
  "description": "Production character modeling and animation workflows.",
  "keywords": ["blender", "character", "3d"],
  "routing": {
    "aliases": ["retopology", "rigging", "retarget animation"],
    "exclude": ["2d image generation only"],
    "priority": 8,
    "exposure": "deferred"
  },
  "policy": {
    "allow_implicit_invocation": true
  }
}
```

Supported policy fields:

- `routing.aliases` / `routing.triggers`: positive task language.
- `routing.exclude` / `routing.negativeTriggers`: hard applicability gates, not score penalties.
- `routing.priority`: bounded tie-break bias.
- `routing.exposure`: `direct`, `deferred`, `explicit-only`, or `hidden`.
- `policy.allow_implicit_invocation`: when `false`, the route is discoverable but cannot become an implicit primary route.

### Skill metadata

The same metadata contract applies to project-local, user, and trusted plugin Skills. The Skill body remains in `SKILL.md`; routing reads only bounded frontmatter plus adjacent route metadata. Route-facing metadata can be supplied in `agents/openai.yaml`:

```yaml
interface:
  display_name: "Blender Retopology"
  short_description: "Clean quad topology and animation-ready edge flow"
  default_prompt: "Use $blender-retopology to clean this generated character before rigging."

dependencies:
  tools:
    - type: "mcp"
      value: "blender"
      description: "Blender MCP server"

policy:
  allow_implicit_invocation: true
```

Skill frontmatter can additionally provide structured route boundaries:

```yaml
---
name: blender-retopology
description: Use after sculpting or generated meshes, before rigging and animation.
routing:
  aliases:
    - retopo
    - quad remesh
    - edge loops
  exclude:
    - texture-only edit
---
```

The router reads names, descriptions, interface fields, default prompts, dependency identifiers/descriptions, aliases, and policy. It does not read the Skill body into the routing index.

## Ranking and gates

Routing is deterministic and bounded. It combines weighted lexical fields with Unicode/CJK character terms:

- operation/Skill/tool name
- title/display name
- aliases and explicit triggers
- short description
- default prompts
- declared dependencies
- full description
- parent plugin identity

Specific workflow Skills normally outrank lower-level implementation tools for natural-language outcomes. An explicitly named exact tool can still win. Disabled, untrusted, unsupported, hidden, negatively excluded, or implicit-disallowed candidates cannot become the primary route.

When the two best eligible candidates are close and neither is explicit, the result is marked `ambiguous`; the agent should inspect at most the top two rather than execute several routes.

## Model-surface compatibility

Stable Gateway treats routing as part of the MCP model surface. Its compatibility fingerprint includes:

- tool name and title
- tool description
- input and output schemas
- annotations
- UI/tool metadata
- routing contract version
- capability routing-index fingerprint
- model-instruction fingerprint

A routing description, Skill policy, plugin route, output schema, or UI metadata change therefore invalidates an incompatible resurrected session and forces a fresh MCP initialize. This prevents an old agent session from retaining stale tool descriptions after the backend has learned a new routing contract.

## Authoring rules

- Describe the outcome and boundary, not merely the implementation name.
- Add concrete positive aliases users actually say.
- Add structured exclusions where an adjacent route is easy to confuse.
- Keep explicit-only workflows explicit instead of relying on weak prompt wording.
- Declare tool dependencies so the router can lead from the Skill to the required MCP surface.
- Keep low-level tool aliases narrow; broad plugin aliases should route to the workflow/plugin rather than every child tool.
