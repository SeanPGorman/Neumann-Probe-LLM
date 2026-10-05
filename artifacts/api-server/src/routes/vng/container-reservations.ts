/** Normalize the two ID shapes returned by VNG for the same storage container. */
export function canonicalContainerId(id: unknown): string {
  const value = String(id ?? "");
  return value.startsWith("container-") ? value : `container-${value}`;
}

type MiningAssignmentLike = {
  containerId?: unknown;
  probeId?: number | null;
};

type FactoryRoleLike = {
  probeId?: number | null;
  roleType?: string;
  state?: {
    preparedContainerIds?: unknown[];
    deliveryContainerManifest?: Record<string, unknown>;
  };
};

/** Containers assigned to mining stay unavailable for new courier manifests. */
export function getMiningAssignmentContainerIds(
  assignments: MiningAssignmentLike[],
  probeId: number | null,
): Set<string> {
  return new Set(
    assignments
      .filter((assignment) => (assignment.probeId ?? null) === (probeId ?? null))
      .map((assignment) => String(assignment.containerId ?? "").trim())
      .filter(Boolean)
      .map(canonicalContainerId),
  );
}

/** Protect every persisted factory manifest container from concurrent mining. */
export function getFactoryManifestContainerIds(
  roles: FactoryRoleLike[],
  probeId: number | null,
): Set<string> {
  const ids = new Set<string>();
  for (const role of roles) {
    if (role.roleType !== "factory" || (role.probeId ?? null) !== (probeId ?? null)) continue;
    const manifest = role.state?.deliveryContainerManifest ?? {};
    const roleIds = [
      ...(Array.isArray(role.state?.preparedContainerIds) ? role.state.preparedContainerIds : []),
      ...Object.values(manifest),
    ];
    for (const id of roleIds) {
      const value = String(id ?? "").trim();
      if (value) ids.add(canonicalContainerId(value));
    }
  }
  return ids;
}
