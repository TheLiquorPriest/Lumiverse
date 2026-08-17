---
title: Troubleshooting
---

# Troubleshooting

Solutions to common issues you might encounter.

---

## Connection Issues

### "Invalid API key"

- Double-check your API key — copy it fresh from your provider's dashboard
- Make sure you're using the right key for the right provider
- API keys are per-connection — check that the correct connection is selected

### "Connection test failed"

- Verify the API URL is correct for your provider
- Check if your provider has an outage
- If using a custom endpoint, make sure the server is running and reachable
- Refresh the model list in the **Model** field — if models load, the connection can reach the provider's model endpoint

### "Model not found"

- The model name must match exactly what the provider expects
- Refresh the model list in the **Model** field and copy the provider's exact model name
- Some models require specific API tiers or access approval

---

## Generation Issues

### AI responses are empty or cut off

- Check your **max tokens** setting — it might be too low
- Some models have minimum token requirements
- If using continue, the model may think the response is already complete

### AI is ignoring my instructions

- Use **Dry Run** to see what the AI actually receives
- Check that your preset blocks are enabled
- Verify macros are resolving correctly
- The instruction might be too far back in the context — try moving it closer (lower depth)

### AI is repeating itself

- Increase **frequency penalty** or **presence penalty** in sampler settings
- Lower the **temperature** slightly
- Check for duplicate content in your world book entries

### Responses are too short / too long

- Adjust **max tokens** in sampler settings
- Add explicit length instructions in your preset blocks (e.g., "Write 2-4 paragraphs")
- Use the **continue** feature if a response ends too soon

---

## Agentic Runtime Issues

### The mode selector is missing

The composer only shows **Generation mode** / **Next turn** when the effective-runtime check reports that both Response and Agentic are ready for the current target. A missing selector can therefore be expected:

- the chat is a group, multiplayer, or Council surface;
- the action is not normal, continue, regenerate, or swipe;
- the preset has agents disabled, allows Response only, or has no Agentic configuration; or
- a required repair or host-readiness check is still pending.

Agentic does not run on impersonate, quiet, raw/batch Spindle generation, or extension/MCP/Council callback, macro, or tool surfaces. Use the existing Response action on those surfaces. If a group or Council surface nevertheless displays a mode selector, choose **Response** rather than attempting Agentic. For a supported single-character chat, open the preset in Loom Builder, choose **Agentic Runtime**, and inspect **Portability & Repair**.

### “Agentic mode needs attention”

This is the safe repair banner shown beside the mode selector. It does not expose a prompt, provider result, or private work detail. Follow the category shown in the banner:

1. **Map the preset's connection slot** — open **Agentic Runtime → Portability & Repair** and map every required slot to an authenticated local connection. Use **Use main connection** for a child that should inherit the root connection.
2. **Choose a provider with the required capabilities** — the root must support generation, streaming, tool calling, and tools-disabled finalization. A slot may add required capabilities for its child. Save after mapping a compatible connection.
3. **Restore the secure runtime worker** — restart Lumiverse once, then retry the effective-runtime check. If the banner remains, inspect **Settings → Diagnostics**; do not try to bypass the worker by running the turn inline.
4. **Use one provider domain for this turn** — Agentic root and child connections must resolve to the same provider trust domain. Replace a cross-domain child slot or choose Response.
5. **Complete runtime setup or review** — acknowledge every imported review item, repair stale Loom block revisions, and review context/task/cognition items before saving.

Host ceilings shown in **Settings → Agent Runtime** are informational and read-only. If an authored budget exceeds a host ceiling, lower it in the Agentic Runtime editor; Agentic readiness remains unavailable until it fits, while Response remains available. A preset, import, or extension cannot raise the ceiling.

### “Agentic mode is not ready. Use Response or complete the listed repair.”

This means the Agentic preflight did not issue a usable one-turn decision. Select **Use Response** in the banner or select **Response** under **Next turn**, then start the generation again. Response is an explicit escape, not a silent downgrade. If you want Response to remain the chat default, choose **Use for this chat** after selecting Response.

If you intended to use Agentic, complete the listed slot/provider/isolate/readiness repair first and resolve the mode again. The server-issued decision token is one-use and short-lived; if it expires before dispatch, reopen **Generation mode** to obtain a fresh decision, then retry.

### “The runtime changed before generation started. Review the mode and try again.”

The selected target, chat revision, preset/config revision, connection, provider endpoint, capability, or readiness state changed while the preflight was in flight. Refresh the chat if needed, reopen **Generation mode**, select the intended mode again, and retry. A stale decision is rejected before provider or tool work; it is not safe to force the old choice.

### “This generation surface is only available in Response mode.”

Agentic is limited to **normal**, **continue**, **regenerate**, and **swipe** in a single-character, non-multiplayer, non-Council chat. Use Response for group chats, multiplayer rooms, Council or Council-tool rounds, impersonate, quiet, raw/batch Spindle generation, and unsupported future surfaces. If one of those unsupported surfaces still offers a selector, choose Response and report the mismatch rather than dispatching Agentic. A normal surface rejection occurs before provider or child work.

### “Agent intrinsics cannot execute during Dry Run”

Dry Run can inspect ordinary prompt assembly, but it never runs an Agentic child provider or Agentic tools. Remove or disable the executable agent block for the inspection, or run the turn explicitly in Response/Agentic as appropriate. Do not interpret a Dry Run refusal as a provider failure.

### An Agentic run ends as “Budget exhausted”, “Timed out”, or “Failed”

Open the **Agentic run** strip under the assistant response and inspect the status-only **Activity Tree**. The public tree may show the phase, bounded usage, child/tool counts, omissions, and a safe terminal reason, but never private prompts, child prose, arguments, retrieval data, results, reasoning, or credentials.

- **Budget exhausted** means the host reached a bounded work, provider, tool, context, workspace, or activity limit. Reduce the number of profiles, grants, context attachments, or task policy, then retry; or select Response.
- **Timed out** means the bounded turn deadline expired. Retry once after checking the provider connection; if it repeats, choose Response or reduce the authored work.
- **Failed** can indicate a provider, protocol, readiness, revision, context, or commit problem. Follow any repair category, refresh the exact preset/context revisions, and retry. If the same run fails again, use Response and keep the activity status when contacting an administrator.

Agentic does not retry by silently switching modes, and a failed turn does not make private work notes or provider payloads available for debugging.

### The Activity Tree is stale or the Workspace tab cannot load

On reconnect the Activity Tree shows **Showing the last known tree while the connection recovers.** or **Restoring activity from the server.** The client preserves the last normalized status tree and does not infer failure from silence. Wait for recovery, then reopen the strip. If it reports **The last known tree is preserved. Recovery can be retried.**, retry the recovery request.

The **Workspace** tab loads separately from activity. It is view-only and redacted; it may show an objective count plus tasks, findings/decisions/questions, submissions, and artifact metadata for attached, proposed, or published artifacts. Task and artifact entries use generated labels such as `Task <id prefix>` and `Artifact <id prefix>`, with bounded MIME, byte-count, digest-prefix, publication-state, retention, and visibility fields; authored names/titles and private child content are not exposed. If it reports **The workspace could not be loaded.**, use **Retry**. A missing or unauthorized workspace is returned without disclosing another user's or chat's data.

### Stop does not work or says “Too late to stop”

For an Agentic run, use Stop in the **Agent activity** inspector for the exact root-run CAS action; it returns accepted, terminal, or too-late. The composer may also show a Stop control for the current generation, but a generic chat-level Stop is not the same guarantee on every generation path; if it fails, use the Activity inspector and retry. The first click becomes **Stopping…**, and duplicate clicks are disabled. **Too late to stop** means the run has left reversible **ASSEMBLE**/**WORK** (including **COMPLETE**, **RENDER**, or **PREPARE_COMMIT**); it does not undo a saved response. There are no separate child-agent Stop controls.

---

## Context Library and cognition issues

### A context pack is unavailable or asks for review

Open **Settings → Context Library**. A pack imported from another account or source is private, unattached, and **Review required**. A user-data archive restore may retain attachment rows, but restored packs and attachments remain quarantined until local review. Inspect content, visibility, and access list, acknowledge the review, and choose **Review and activate** before using a pack.

An attachment marked required is part of Agentic preflight. If it is missing, revoked, or changed, Agentic stops before completion rather than silently using different context. An optional denied read is omitted without disclosing whether inaccessible content exists. For a foreign-imported pack, create a new active revision after review because the imported revision remains review-required; for a restored attachment, verify its exact reviewed revision and ACL. Then start a new Agentic turn.

### “This pack changed in another session. Refresh before trying again.”

The Context Library uses revision preconditions and an account ACL revision. Refresh the pack detail, select the current immutable revision, and retry the action. If you changed visibility or access, re-open **Agentic Runtime → Progressive Context**, remove stale selections, choose the current reviewed revision, and save the shared draft.

Changing an ACL, attachment, or revision invalidates outstanding Agentic readiness. A turn that has already consumed a context revision rechecks it before commit; it fails closed instead of committing with changed or unauthorized bytes.

### A cognition rule, task, or Loom block needs repair

Open **Loom Builder → Agentic Runtime** and inspect **Phased Instructions**, **Progressive Context**, **Dynamic Tasks**, and **Portability & Repair**:

- reselect the current revision for a stale Loom block;
- restore or remove a missing context-pack revision after reviewing it in Context Library;
- repair duplicate or cyclic task dependencies;
- keep predicate conditions within the displayed depth/size limits; and
- ensure every required imported review item is acknowledged before enabling agents.

The editor and import path validate cognition references and keep invalid policy in repair state. A valid frozen graph is evaluated on workspace creation (the ASSEMBLE activation), at each later entered runtime phase (**WORK**, **RENDER**, **PREPARE_COMMIT**, **COMMITTING**, or **COMMITTED**), after each named task or child-submission transition, and in the bounded completion fixed point. The completion fixed point is an internal evaluation, not a separate public phase entry. If a newly activated required task or context requirement blocks completion, satisfy it and retry; tasks created by the root may also be required, while child frames cannot create tasks. Invalid cognition keeps Response available and never silently drops a required rule or context input.

---

## World Book Issues

### Entries aren't activating

- Check that the world book is attached (to the character, persona, or global list)
- Verify keywords match what's being said in the chat (check case sensitivity)
- Use **Dry Run** to see the world info stats — it shows which entries activated and why
- Check **scan depth** — the keyword might be mentioned too far back
- Make sure the entry isn't disabled or on cooldown

### Too many entries activating

- Use **selective logic** with secondary keywords to narrow activation
- Increase **scan depth** to limit how far back keywords are checked
- Set entry **priorities** and use budget limits
- Use **groups** so only one entry from a set activates

---

## Performance Issues

### App feels slow

- Disable **glass effects** in the Theme panel (backdrop-filter can be GPU-intensive)
- Reduce the number of messages loaded per page
- Close unused panels
- Clear old chats if you have thousands

### Large world books are slow

- Consider vectorizing entries instead of relying on keyword scanning
- Use budget limits to cap the number of active entries
- Increase min priority to filter out low-importance entries

---

## Data Issues

### Lost my API keys after reinstalling

- API keys are encrypted using the `data/lumiverse.identity` file
- If you lost this file, stored keys cannot be recovered — you'll need to re-enter them
- Always back up the entire `data/` directory

### Can't log in

Reset your password from the command line:

```bash
bun run reset-password
```

---

## Getting Help

If you're stuck:

1. Check the **Diagnostics** tab in Settings for system health info
2. Use **Dry Run** to inspect what the AI sees
3. Check the World Book Diagnostics for activation issues
4. Review the browser console (F12) for frontend errors
5. If you administer the server, review its safe error code and timing logs; do not share prompts, provider payloads/results, credentials, or private work.
