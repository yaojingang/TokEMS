# Package Verification

- OK: `True`
- Package directory: `/Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/.build/package-full`
- Targets: `2 / 2` adapters present
- Archive present: `True`
- Archive SHA256: `eff907147a327273cbc1ad725522d68fc204d5719aa4aa8d25e7f8878b88cb5d`
- Nested SKILL.md entries: `0`
- Failures: `0`
- Warnings: `0`

## Checks

| Check | Status | Detail |
| --- | --- | --- |
| `package-manifest` | `pass` | Package manifest exists: /Users/laoyao/AI Coding/01-Projects/Active/TokEMS/skills/tokems-admin/.build/package-full/manifest.json |
| `openai-adapter` | `pass` | Adapter exists for target: openai |
| `openai-field-name` | `pass` | openai adapter includes field: name |
| `openai-field-description` | `pass` | openai adapter includes field: description |
| `openai-field-version` | `pass` | openai adapter includes field: version |
| `openai-field-display_name` | `pass` | openai adapter includes field: display_name |
| `openai-field-short_description` | `pass` | openai adapter includes field: short_description |
| `openai-field-default_prompt` | `pass` | openai adapter includes field: default_prompt |
| `openai-field-job_to_be_done` | `pass` | openai adapter includes field: job_to_be_done |
| `openai-field-ir_source` | `pass` | openai adapter includes field: ir_source |
| `openai-field-ir_schema_version` | `pass` | openai adapter includes field: ir_schema_version |
| `openai-field-semantic_contract` | `pass` | openai adapter includes field: semantic_contract |
| `openai-field-semantic_parity` | `pass` | openai adapter includes field: semantic_parity |
| `openai-field-compiler` | `pass` | openai adapter includes field: compiler |
| `openai-field-compiled_contract` | `pass` | openai adapter includes field: compiled_contract |
| `openai-field-permission_contract` | `pass` | openai adapter includes field: permission_contract |
| `openai-field-target_permission_contract` | `pass` | openai adapter includes field: target_permission_contract |
| `openai-field-target_native_contract` | `pass` | openai adapter includes field: target_native_contract |
| `openai-field-target_transform` | `pass` | openai adapter includes field: target_transform |
| `openai-field-canonical_metadata` | `pass` | openai adapter includes field: canonical_metadata |
| `openai-field-canonical_format` | `pass` | openai adapter includes field: canonical_format |
| `openai-field-activation_mode` | `pass` | openai adapter includes field: activation_mode |
| `openai-field-execution_context` | `pass` | openai adapter includes field: execution_context |
| `openai-field-shell` | `pass` | openai adapter includes field: shell |
| `openai-field-trust_level` | `pass` | openai adapter includes field: trust_level |
| `openai-field-remote_inline_execution` | `pass` | openai adapter includes field: remote_inline_execution |
| `openai-field-degradation_strategy` | `pass` | openai adapter includes field: degradation_strategy |
| `openai-field-portability_profile` | `pass` | openai adapter includes field: portability_profile |
| `generic-adapter` | `pass` | Adapter exists for target: generic |
| `generic-field-name` | `pass` | generic adapter includes field: name |
| `generic-field-description` | `pass` | generic adapter includes field: description |
| `generic-field-version` | `pass` | generic adapter includes field: version |
| `generic-field-display_name` | `pass` | generic adapter includes field: display_name |
| `generic-field-short_description` | `pass` | generic adapter includes field: short_description |
| `generic-field-default_prompt` | `pass` | generic adapter includes field: default_prompt |
| `generic-field-job_to_be_done` | `pass` | generic adapter includes field: job_to_be_done |
| `generic-field-ir_source` | `pass` | generic adapter includes field: ir_source |
| `generic-field-ir_schema_version` | `pass` | generic adapter includes field: ir_schema_version |
| `generic-field-semantic_contract` | `pass` | generic adapter includes field: semantic_contract |
| `generic-field-semantic_parity` | `pass` | generic adapter includes field: semantic_parity |
| `generic-field-compiler` | `pass` | generic adapter includes field: compiler |
| `generic-field-compiled_contract` | `pass` | generic adapter includes field: compiled_contract |
| `generic-field-permission_contract` | `pass` | generic adapter includes field: permission_contract |
| `generic-field-target_permission_contract` | `pass` | generic adapter includes field: target_permission_contract |
| `generic-field-target_native_contract` | `pass` | generic adapter includes field: target_native_contract |
| `generic-field-target_transform` | `pass` | generic adapter includes field: target_transform |
| `generic-field-canonical_metadata` | `pass` | generic adapter includes field: canonical_metadata |
| `generic-field-canonical_format` | `pass` | generic adapter includes field: canonical_format |
| `generic-field-activation_mode` | `pass` | generic adapter includes field: activation_mode |
| `generic-field-execution_context` | `pass` | generic adapter includes field: execution_context |
| `generic-field-shell` | `pass` | generic adapter includes field: shell |
| `generic-field-trust_level` | `pass` | generic adapter includes field: trust_level |
| `generic-field-remote_inline_execution` | `pass` | generic adapter includes field: remote_inline_execution |
| `generic-field-degradation_strategy` | `pass` | generic adapter includes field: degradation_strategy |
| `generic-field-portability_profile` | `pass` | generic adapter includes field: portability_profile |
| `openai-file-targets/openai/adapter.json` | `pass` | Package contains targets/openai/adapter.json |
| `openai-file-targets/openai/agents/openai.yaml` | `pass` | Package contains targets/openai/agents/openai.yaml |
| `generic-file-targets/generic/adapter.json` | `pass` | Package contains targets/generic/adapter.json |
| `archive-safe-paths` | `pass` | Archive has no absolute or parent-traversal entries |
| `archive-entry-tokems-admin/SKILL.md` | `pass` | Archive contains tokems-admin/SKILL.md |
| `archive-entry-tokems-admin/manifest.json` | `pass` | Archive contains tokems-admin/manifest.json |
| `archive-entry-tokems-admin/agents/interface.yaml` | `pass` | Archive contains tokems-admin/agents/interface.yaml |
| `archive-single-skill-entrypoint` | `pass` | Archive exposes only the root SKILL.md entrypoint |
| `archive-excludes-generated` | `pass` | Archive excludes local caches, platform noise, .yao state, external submission drafts, local evidence pointers, generated dist/, .previews/, and tests/tmp* contents |
| `archive-portable-evidence-index` | `pass` | Archive includes a self-contained portable evidence pointer and verified report index |
| `registry-name-match` | `pass` | Registry package name matches package manifest |
| `registry-version-match` | `pass` | Registry package version matches package manifest |
| `registry-compat-openai` | `pass` | Registry compatibility is reviewable for target: openai |
| `registry-compat-generic` | `pass` | Registry compatibility is reviewable for target: generic |

## Failures

- None

## Warnings

- None
