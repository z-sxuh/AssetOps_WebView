export type TopologyPoint = { x: number; y: number };
export type TopologyPort = TopologyPoint & { id: string };
export type TopologyNode = { id: string; assetId?: string; label: string; role: string; x: number; y: number; width?: number; height?: number; note?: string; regionId?: string; connectionPoints?: TopologyPort[]; iconKind?: 'application' | 'file' | 'database' | 'switch' | 'firewall'; customIcon?: string; tags?: string[]; host?: string; ip?: string; environment?: string };
export type TopologyRegion = { id: string; label: string; x: number; y: number; width: number; height: number; color: string; parentId?: string };
export type TopologyEdge = { id: string; from: string; to: string; label: string; color?: string; style?: 'solid' | 'dashed' | 'dotted'; direction?: 'none' | 'forward' | 'reverse' | 'both'; fromPort?: string; toPort?: string; waypoints?: TopologyPoint[]; routing?: 'orthogonal' | 'straight' };
export type Topology = { nodes: TopologyNode[]; edges: TopologyEdge[]; regions?: TopologyRegion[] };
export type SystemRevision = { id: string; at: string; note: string; markdown: string; topology: Topology; assetIds?: string[] };
export type OpsSystem = { id: string; unitId: string; environmentId?: string; zoneId?: string; systemId?: string; scopeName: string; markdown: string; topology: Topology; assetIds?: string[]; revisions: SystemRevision[]; updatedAt: string };
