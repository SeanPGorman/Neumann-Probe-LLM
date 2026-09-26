---
name: Emergency courier semantic containers
description: How to choose among multiple onboard containers when validating an emergency courier loadout.
---

When several onboard containers contain the same resource, prefer the container with the matching semantic delivery label. Only fall back to an unlabeled container after labeled candidates are exhausted, choosing the fullest candidate.

**Why:** A courier carried both a full `delivery-metals` container and an earlier generic container with partial metals. First-match discovery selected the partial container and silently blocked an otherwise valid emergency dispatch.

**How to apply:** Manifest discovery for resources, deployment items, and metals must treat semantic labels as authoritative. Do not rely on API list order when equivalent generic containers are also aboard.