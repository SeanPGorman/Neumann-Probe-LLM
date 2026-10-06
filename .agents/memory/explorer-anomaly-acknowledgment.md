---
name: Explorer anomaly acknowledgment
description: How Explorer roles resume after an operator reviews an anomaly.
---

After an Explorer or Ball Explorer pauses for an anomaly, operator acknowledgment resumes the role and suppresses that finding in the acknowledged sector until the probe leaves it. Detection is active again in a different sector.

**Why:** The same visible anomaly would otherwise immediately pause the role again after the operator explicitly resumes it.

**How to apply:** Preserve the ignored-sector marker through the resume flow and clear it when the probe reaches another sector. Apply consistently to both Explorer role types.
