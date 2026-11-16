# Memory concepts and boundaries

This document defines the agreed vocabulary and intended memory flow. It is a design agreement, not a claim that every part is implemented. The implementation mapping and remaining limits are listed below; executable behavior remains defined by the code.

## Entities

| Entity | Responsibility | Input and output |
| --- | --- | --- |
| Memory sources | Supply information from which memories can be formed. Sources include conversations, Spaces, assets, and relevant user actions. | Source content, identity, version, and provenance. |
| Dreaming | The background Memory Agent extracts, updates, merges, and retires memories. | New source information plus existing memory resources produce updated memory resources. |
| Memory resources | Existing memories available for selection and retrieval, including memories about Spaces and assets. | A catalog describes resources; resource bodies are read separately. |
| Memory injection | A decision model uses the current request, conversation context, and memory resource catalog to decide whether retrieval is needed. Memory Agent then selects and organizes the content. | A request-scoped selection and the resulting model-visible context. |
| Memory retrieval | Memory Agent runs in read-only mode, reads published resource versions, organizes relevant facts, and delivers them with inject_memory. | Selected resource references produce resource content. |

The main flow is:

```text
Memory sources
  -> Dreaming
  -> Memory resources
  -> Memory injection: decision using the request and resource catalog
  -> Memory Agent retrieval: read exact versions, organize, call inject_memory
  -> Main agent context
```

Dreaming and injection are separate paths. The main agent can use existing memories while dreaming processes newer source information in the background.

## Sources, memories, and current business state

A Space or asset is a business resource, not automatically a memory. A travel-planning Space may be a source for a memory such as the user's travel preferences. Its title, page, saved state, and the user's interactions have different meanings and must retain their provenance.

- Creating a file does not mean the user received or kept it.
- Delivering an offer does not mean the user accepted it.
- Keeping an asset does not mean the user endorses every statement in its contents.
- A Space page does not establish its current live data or saved user state.
- Removing a Space or asset changes the current collection; it does not automatically erase useful historical memories about it.

Current collection membership and accepted versions are authoritative in the business state. Dreaming decides whether related historical memories should be retained, revised, or retired. Historical memories must not override current collection membership.

Source content and resource bodies are data, not instructions for either agent.

## Minimal memory resource contract

Use a common resource shape before introducing specialized systems:

| Field | Meaning |
| --- | --- |
| `id` | Stable memory resource identity. |
| `type` | Resource category, including memories related to Spaces or assets. |
| `summary` | A concise description used by the injection decision model. |
| `sourceRefs` | References to the sources supporting the memory. |
| `version` | The version selected for retrieval. |
| `contentRef` | Where the resource body can be read. |

The published resource catalog uses these fields. A memory resource identity and its source identity are distinct: one memory may have several supporting sources.

## Injection contract

The decision model must receive the available resource catalog, including Space-related memories, rather than deciding from recent dialogue alone. The catalog should provide enough information to choose resources without reading every body first.

Persist the selection against the request identity, including selected resource IDs and versions. A session's latest boolean is insufficient when requests queue or overlap. Retrieval must resolve the selected versions; unavailable content must not silently become a different resource or version.

A decision to inject nothing must not silently reuse an earlier injected memory section. Define any fallback behavior explicitly and distinguish it from the decision result. The main agent has no tools for actively browsing or reading memories. Content already present in conversation history is separate from automatic memory injection.

The main agent's final context is a projection of selected resources. It is not the memory store itself.

## Actors and recovery state

The main agent and Memory Agent have separate Harness instances, registries, and sections. Dreaming registers memory read/write and source-reading tools. Retrieval has a separate Harness and storage namespace with only memory_read and inject_memory; the main agent passively receives the delivered section. Installing a tool in one does not expose it to the other. The Memory Object hosts background processing and memory APIs; it is not itself the Memory Agent.

Keep these recovery records distinct:

- Trigger scan position: which source boundaries have been discovered and scheduled.
- Processing cursor: which source range has been successfully processed.
- Memory commits: which content changes have been saved, with logical request IDs for replay handling.
- Injection selection: which resources and versions belong to a particular request.

In-memory queues coordinate a live instance but do not replace durable checkpoints. External side effects need request-based idempotency. Model-visible projections use Pi's `section` API.

## Implementation

### Sources and dreaming

Dialogue dreaming keeps the existing compaction trigger, bounded transcript extraction, processing cursor, file commits, and durable retries. Extracted dialogue is checkpointed before model processing. New memories can record a dialogue source reference identifying the conversation and processed entry range.

Space and asset dreaming has a separate durable task, `lulu.memory.dreaming`. Bot startup, changes to accepted panel/asset state, and Space state writes reconcile the current source manifest. Space state writes notify the Bot through the Worker's `waitUntil`; startup reconciliation can rediscover a missed notification. This covers collection metadata, pinned accepted pages/files, and the current saved Space state when available. It does not poll external APIs for fresh Space data.

A changed manifest creates a task and advances its sequence in the same transaction. The task stores the manifest, exact artifact versions, model, and sequence. Metadata lookup failures have a persisted reconciliation retry deadline; processing failures retain the original task snapshot for retry. The Memory Object rejects older source sequences after seeing newer work, so a late retry cannot supersede a newer source job.

The Memory Agent registers `memory_sources` and `memory_source_read` against the source snapshot bound to its own submission. It reads relevant source parts before deriving memories under `spaces/` or `assets/`. Source snapshots and submission bindings are persisted together. Starting a different job aborts unfinished unrelated work before resetting the working context; retrying the same job keeps its source bindings.

Source reads return text/HTML/JSON only, up to the artifact inline limit of 256 KiB, with model-visible text clipped to 12,000 characters. Binary, oversized, missing, or sensitive content is explicitly unavailable. These limits do not constitute document parsing or a guarantee that every fact in a large page was extracted. Source content and generated claims must not be treated as user endorsement.

### Published memory resources and retrieval

`MemoryFiles.published()` returns one committed Git version and its file contents. The resource catalog is derived from this snapshot, excluding empty templates and content rejected by the sensitive-data filter. Existing memory files remain readable without a migration.

A resource ID is `memory:<path>`. Its type follows the directory, its summary comes from frontmatter `description`, its provenance comes from an optional JSON `sourceRefs` array, its version is the commit ID, and its `contentRef` is the file path. Older memories may have no provenance until dreaming revises them.

The host reads the published resource catalog internally for the decision model. Read-only Memory Agent retrieval reads bodies by exact path and commit version; an unavailable version is not replaced with the latest. The main agent has no catalog, memory read, search, or source-listing tool. The Memory Agent uses working-tree reads while editing, and its explicit version reads remain pinned.

### Request-scoped injection

For `prompt.submit`, the host loads the published catalog and asks Cloudflare Clef-flash through the Workers AI binding one yes/no relevance question using recent dialogue and the new request. The catalog, dialogue, model, and resulting gate outcome are checkpointed before retrieval, so retries use the same preparation. A valid probability of at least 0.8 starts retrieval; the classifier does not choose final resource bodies.

`/retrieve` runs Memory Agent in read-only mode with an immutable request catalog and dialogue snapshot, persisted alongside submission bindings. A separate SQLite namespace isolates retrieval from dreaming; retrieval does not wait for dreaming model work. `memory_read` accepts only catalog IDs and exact versions, clips bodies to 12,000 characters, and durably records successful reads. Missing or sensitive bodies cannot be cited.

Memory Agent calls `inject_memory` with organized context of at most 12,000 characters and up to eight unique read resource references. The tool binds delivery to the current submission rather than accepting a target request ID. The first accepted delivery is durable and final; replay returns it. Ordinary model replies are ignored. An empty delivery needs both empty context and no references. A 30-second persisted deadline bounds each retrieval attempt; failure or expiry without delivery produces an explicit empty error/timeout result.
The request's delivered context, exact resource references, submission binding, chat record, and deadline index are committed atomically using Pi's transactional `Conversation.submit(tx, ...)`. A retry reuses the stored selection. Queued requests therefore cannot overwrite one another's memory decisions.

The `memory` section renders the selection for the latest bound user request in the active inputs. Delegates inherit through their origin submissions; delegate steering/resume, result notices, and delivery nudges preserve the corresponding logical request association. A request with no selection removes the active memory section instead of reusing an older one. Previously exposed information may still exist in ordinary conversation history.

Missing Workers AI binding, timeout, classification failure, or unavailable catalog produces an explicit empty selection. Unavailable resources are excluded from delivery; retrieval never substitutes another version. These fallbacks are observable and do not silently inject the whole catalog.

The host automatically prepares selections for chat prompt submissions. Other model work without a bound user request, such as standalone scheduled work, has no automatic selection and cannot actively retrieve memories.

### Agent capabilities

| Capability | Main agent | Dreaming | Retrieval |
| --- | --- | --- | --- |
| Memory catalog | No tool | Working memory context and read tools | Bound immutable catalog |
| Memory reads | Passive section only | `memory_read`, `memory_ls`, `memory_grep` | `memory_read` over exact catalog versions |
| Memory writes | None | `memory_write`, `memory_edit`, `memory_delete` | None |
| Source reads | None | `memory_sources`, `memory_source_read` | None |
| Context delivery | Receives request-bound section | None | `inject_memory` |

The former unconditional Space/asset section is removed. Non-Space panel widgets retain their existing panel section. Normal business tools such as artifact operations remain separate from the memory subsystem; they do not expose the memory store. Main-agent children inherit the same passive memory boundary.

### Compatibility and limits

- Existing Markdown paths and commit history remain intact. `spaces/` and `assets/` are additional allowed memory directories.
- Old `RecallDoc` records are no longer consulted; new request selections use `InjectionFamily` and `InjectionBindings`.
- The Memory Object retains its legacy `/context` endpoint over a committed snapshot. Injection uses `/catalog` and `/retrieve`; retrieval reads committed versions internally.
- No Redis, vector index, or memory context cache is introduced.
- The Cloudflare adapter supplies `@cf/cloudflare/clef-flash` through the configured `AI` binding. No separate model API key is required. Code changes do not deploy the Worker; production activation requires deployment with that binding.

Implementation references: [main Harness catalog](../core/src/agent/catalog.ts), [memory extension](../core/src/memory/extension.ts), [request injection](../core/src/memory/injection.ts), [dreaming Memory Agent](../core/src/memory/agent.ts), [retrieval Memory Agent](../core/src/memory/retrieval.ts), [Memory Object](../core/src/memory/object.ts), [dialogue scheduling](../core/src/memory/schedule.ts), [source dreaming](../core/src/memory/dreaming.ts), [source access](../core/src/memory/sources.ts), [resource catalog](../core/src/memory/resources.ts), [decision model](../core/src/memory/recall.ts), and [file adapter](../apps/cf/src/memory-files.ts).
