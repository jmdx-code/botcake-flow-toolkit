import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { TemplateGraph, TemplateGraphNode, TemplateMediaField } from "../../core/template-graph";

type Props = {
  graph: TemplateGraph;
  assets: Map<string, Uint8Array>;
  selectedNodeId?: string;
  onSelectNode: (nodeId: string) => void;
  query: string;
};

type GraphNodeData = {
  label: ReactNode;
  title: string;
  entry: boolean;
  kind: string;
};

export function TemplateGraphCanvas({ graph, assets, selectedNodeId, onSelectNode, query }: Props) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingIds = useMemo(() => new Set(graph.nodes
    .filter((node) => !normalizedQuery
      || `${node.title} ${node.preview} ${node.id}`.toLocaleLowerCase().includes(normalizedQuery))
    .map((node) => node.id)), [graph.nodes, normalizedQuery]);

  const nodes = useMemo<Node<GraphNodeData>[]>(() => graph.nodes.map((node) => {
    const selected = node.id === selectedNodeId;
    const matches = matchingIds.has(node.id);
    return {
      id: node.id,
      position: { x: node.x, y: node.y },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selectable: true,
      draggable: false,
      data: {
        title: node.title,
        entry: node.entry,
        kind: node.type,
        label: <GraphNodePreview node={node} assets={assets} />,
      },
      style: {
        width: 300,
        padding: 0,
        overflow: "hidden",
        borderRadius: 13,
        border: selected ? "2px solid #0f766e" : node.entry ? "2px solid #1f9d67" : "1px solid #cfd6e2",
        background: node.entry ? "linear-gradient(180deg, #f3fff9 0, #fff 34%)" : "linear-gradient(180deg, #fafbfe 0, #fff 34%)",
        boxShadow: selected ? "0 0 0 4px rgba(15,118,110,.14), 0 10px 28px rgba(31,37,55,.16)" : "0 6px 18px rgba(31,37,55,.10)",
        opacity: normalizedQuery && !matches ? .28 : 1,
      },
      zIndex: selected ? 3 : 2,
      className: selected ? "template-flow-node selected" : "template-flow-node",
    };
  }), [assets, graph.nodes, matchingIds, normalizedQuery, selectedNodeId]);

  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => {
    const related = edge.source === selectedNodeId || edge.target === selectedNodeId;
    const fadedBySearch = normalizedQuery && !matchingIds.has(edge.source) && !matchingIds.has(edge.target);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed, color: related ? "#0f766e" : "#7f8998" },
      style: {
        stroke: related ? "#0f766e" : "#8d96a5",
        strokeWidth: related ? 2.4 : 1.5,
        opacity: fadedBySearch ? .18 : 1,
      },
      labelStyle: { fill: related ? "#4d3fc5" : "#657083", fontSize: 11, fontWeight: related ? 600 : 400 },
      labelBgStyle: { fill: "#f9fafc", fillOpacity: .92 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 5,
      zIndex: 0,
    };
  }), [graph.edges, matchingIds, normalizedQuery, selectedNodeId]);

  return <ReactFlow
    nodes={nodes}
    edges={edges}
    fitView
    fitViewOptions={{ padding: .16, minZoom: .2, maxZoom: 1.12 }}
    minZoom={.12}
    maxZoom={1.7}
    nodesDraggable={false}
    nodesConnectable={false}
    edgesReconnectable={false}
    elementsSelectable
    onNodeClick={(_, node) => onSelectNode(node.id)}
    onPaneClick={() => onSelectNode("")}
    proOptions={{ hideAttribution: true }}
  >
    <Background color="#d9dee8" gap={22} size={1} />
    <MiniMap
      pannable
      zoomable
      nodeColor={(node) => node.data?.entry ? "#1f9d67" : node.id === selectedNodeId ? "#0f766e" : "#aab3c2"}
      maskColor="rgba(239,242,247,.72)"
    />
    <Controls showInteractive={false} />
  </ReactFlow>;
}

function GraphNodePreview({ node, assets }: { node: TemplateGraphNode; assets: Map<string, Uint8Array> }) {
  const shownMedia = node.media.slice(0, 2);
  return <div className="flow-node-content">
    <div className="flow-node-heading">
      <span className={`node-kind kind-${kindClass(node.type)}`}>{node.type}</span>
      {node.entry && <span className="entry-badge">入口</span>}
    </div>
    <strong>{node.title}</strong>
    {shownMedia.length > 0 && <div className={`flow-node-media media-count-${shownMedia.length}`}>
      {shownMedia.map((media) => <NodeMedia key={media.path} media={media} assets={assets} />)}
      {node.media.length > shownMedia.length && <span className="more-media">+{node.media.length - shownMedia.length}</span>}
    </div>}
    {node.preview && <p>{node.preview}</p>}
    {node.buttons.length > 0 && <div className="flow-node-buttons">{node.buttons.slice(0, 3).map((title, index) => <span key={`${title}-${index}`}>{title}</span>)}{node.buttons.length > 3 && <small>+{node.buttons.length - 3}</small>}</div>}
    <small className="flow-node-id">{node.id}</small>
  </div>;
}

function NodeMedia({ media, assets }: { media: TemplateMediaField; assets: Map<string, Uint8Array> }) {
  const [assetUrl, setAssetUrl] = useState<string>();
  useEffect(() => {
    const bytes = media.asset ? assets.get(media.asset) : undefined;
    if (!bytes) { setAssetUrl(undefined); return; }
    const type = media.kind === "image" ? imageMime(media.name ?? media.asset) : media.kind === "audio" ? "audio/mpeg" : "video/mp4";
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
    setAssetUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [assets, media.asset, media.kind, media.name]);
  const source = assetUrl ?? media.url;
  if (media.kind === "image" && source) return <img src={source} alt={media.name ?? "节点图片"} />;
  if (media.kind === "video" && source) return <video src={source} muted preload="metadata" />;
  return <div className="flow-node-audio"><span>♪</span><strong>{media.name ?? "音频"}</strong></div>;
}

function imageMime(name = ""): string {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.gif$/i.test(name)) return "image/gif";
  return "image/jpeg";
}

function kindClass(value: string): string {
  if (value.includes("条件")) return "condition";
  if (value.includes("延迟")) return "delay";
  if (value.includes("动作")) return "action";
  if (value.includes("图片")) return "image";
  if (value.includes("音频")) return "audio";
  if (value.includes("视频")) return "video";
  if (value.includes("图集") || value.includes("模板")) return "gallery";
  return "message";
}
