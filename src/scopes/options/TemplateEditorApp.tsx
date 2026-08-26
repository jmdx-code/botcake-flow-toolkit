import { useEffect, useMemo, useState } from "react";
import { createTemplateArchive, loadTemplateArchive } from "../../core/archive";
import { assignMediaInput, detachMediaInput, inputUsageCount, plainTextToRawText, pruneUnusedTemplateInputs, reconcileTemplateInputBindings, removeUnusedTemplateInput, replaceTemplateSection, syncBlockRichTextMirrors, syncBlockTextInputBindings, syncTextInputBindings } from "../../core/template-editor";
import { getActionNodeView, getConditionNodeView, getDelayNodeView, type ConditionRuleView } from "../../core/node-adapters";
import {
  buildTemplateGraph,
  getBlocks,
  getBlockContentItems,
  getBlockMediaFields,
  type TemplateContentItem,
  type TemplateMediaField,
  type TemplateTextField,
} from "../../core/template-graph";
import { flowTemplateSchema } from "../../core/template-schema";
import { assertTemplateContract } from "../../core/template-contract";
import type { FlowTemplateV1, LoadedTemplate, MediaKind, TemplateInput } from "../../shared/types";
import { deepClone, setByPath } from "../../shared/utils";
import { downloadBytes } from "../content/bridge";
import { TemplateGraphCanvas } from "./TemplateGraphCanvas";

type Notice = { kind: "info" | "success" | "error"; text: string };
type WorkspaceView = "flow" | "settings" | "json";
type SettingsView = "overview" | "inputs" | "media" | "botFields";
type TemplateWorkspace = {
  id: string;
  loaded: LoadedTemplate;
  editorText: string;
  selectedNodeId: string;
  view: WorkspaceView;
  settingsView: SettingsView;
  inspectorMode: "visual" | "json";
  query: string;
};

export function TemplateEditorApp() {
  const [workspaces, setWorkspaces] = useState<TemplateWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [notice, setNotice] = useState<Notice>({ kind: "info", text: "打开一个插件导出的 ZIP 模板包开始编辑。" });
  const [busy, setBusy] = useState(false);
  const [editingInputKey, setEditingInputKey] = useState("");

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const loaded = activeWorkspace?.loaded;
  const editorText = activeWorkspace?.editorText ?? "";
  const selectedNodeId = activeWorkspace?.selectedNodeId ?? "";
  const view = activeWorkspace?.view ?? "flow";
  const settingsView = activeWorkspace?.settingsView ?? "overview";
  const inspectorMode = activeWorkspace?.inspectorMode ?? "visual";
  const query = activeWorkspace?.query ?? "";

  const graph = useMemo(() => loaded ? buildTemplateGraph(loaded.template) : undefined, [loaded]);
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  const editingInput = loaded?.template.inputs.find((input) => input.key === editingInputKey);
  const contentItems = useMemo(() => loaded && selectedNode
    ? getBlockContentItems(loaded.template, selectedNode.blockIndex)
    : [], [loaded, selectedNode]);
  const mediaFields = useMemo(() => loaded && selectedNode
    ? getBlockMediaFields(loaded.template, selectedNode.blockIndex)
    : [], [loaded, selectedNode]);
  const nodeBotFields = useMemo(() => {
    if (!loaded || !selectedNode) return [];
    const block = getBlocks(loaded.template)[selectedNode.blockIndex];
    const json = JSON.stringify(block ?? {});
    return loaded.template.dependencies.botFields.filter((field) =>
      (field.sourceId && json.includes(`{{${field.sourceId}/|`)) || json.includes(`|${field.name}}}`));
  }, [loaded, selectedNode]);

  function patchActiveWorkspace(patch: Partial<TemplateWorkspace> | ((workspace: TemplateWorkspace) => Partial<TemplateWorkspace>)) {
    setWorkspaces((current) => current.map((workspace) => {
      if (workspace.id !== activeWorkspaceId) return workspace;
      const next = typeof patch === "function" ? patch(workspace) : patch;
      return { ...workspace, ...next };
    }));
  }

  function setSelectedNodeId(value: string) {
    patchActiveWorkspace({ selectedNodeId: value, inspectorMode: "visual" });
    setEditingInputKey("");
  }
  function setEditorText(value: string) { patchActiveWorkspace({ editorText: value }); }
  function setView(value: WorkspaceView) { patchActiveWorkspace({ view: value }); }
  function setSettingsView(value: SettingsView) { patchActiveWorkspace({ settingsView: value }); }
  function setInspectorMode(value: "visual" | "json") { patchActiveWorkspace({ inspectorMode: value }); }
  function setQuery(value: string) { patchActiveWorkspace({ query: value }); }

  function switchWorkspace(id: string) {
    setActiveWorkspaceId(id);
    setEditingInputKey("");
  }

  function closeWorkspace(id: string) {
    const closing = workspaces.find((workspace) => workspace.id === id);
    if (!closing || !window.confirm(`关闭“${closing.loaded.template.meta.name}”？未导出的修改将丢失。`)) return;
    const index = workspaces.findIndex((workspace) => workspace.id === id);
    const remaining = workspaces.filter((workspace) => workspace.id !== id);
    setWorkspaces(remaining);
    if (id === activeWorkspaceId) setActiveWorkspaceId(remaining[Math.min(index, remaining.length - 1)]?.id ?? "");
    setEditingInputKey("");
  }

  async function openArchive(file: File) {
    setBusy(true);
    try {
      const next = loadTemplateArchive(new Uint8Array(await file.arrayBuffer()), file.name);
      const removedInputs = pruneUnusedTemplateInputs(next.template);
      const nextGraph = buildTemplateGraph(next.template);
      const workspace: TemplateWorkspace = {
        id: crypto.randomUUID(),
        loaded: next,
        editorText: JSON.stringify(next.template, null, 2),
        selectedNodeId: next.template.flow.entryBlockKey || nextGraph.nodes[0]?.id || "",
        view: "flow",
        settingsView: "overview",
        inspectorMode: "visual",
        query: "",
      };
      setWorkspaces((current) => [...current, workspace]);
      setActiveWorkspaceId(workspace.id);
      setEditingInputKey("");
      setNotice({ kind: "success", text: removedInputs.length
        ? `已打开 ${file.name}，并自动清理 ${removedInputs.length} 个未使用变量。`
        : `已打开 ${file.name}，点击流程图节点即可编辑内容。` });
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  function mutateTemplate(update: (template: FlowTemplateV1) => void) {
    patchActiveWorkspace((workspace) => {
      try {
        const template = deepClone(workspace.loaded.template);
        update(template);
        return { loaded: { ...workspace.loaded, template }, editorText: JSON.stringify(template, null, 2) };
      } catch (error) {
        setNotice({ kind: "error", text: messageOf(error) });
        return {};
      }
    });
  }

  function updateTextField(field: TemplateTextField, value: string) {
    mutateTemplate((template) => {
      setByPath(template.flow.post, field.path, value);
      if (field.rawTextPath) setByPath(template.flow.post, field.rawTextPath, plainTextToRawText(value));
      syncTextInputBindings(template, field.path, value, field.multiline);
    });
  }

  function updateNodeValue(path: string, value: unknown) {
    mutateTemplate((template) => setByPath(template.flow.post, path, value));
  }

  function updateInput(key: string, patch: Partial<TemplateInput>) {
    mutateTemplate((template) => {
      const input = template.inputs.find((item) => item.key === key);
      if (input) Object.assign(input, patch, { retainWhenUnused: true });
    });
  }

  function makeMediaVariable(media: TemplateMediaField) {
    mutateTemplate((template) => {
      const key = media.key.startsWith("fixed_") ? nextMediaInputKey(template, media.kind) : media.key;
      assignMediaInput(template, media.path, key);
    });
    setEditingInputKey("");
    setNotice({ kind: "success", text: `${media.label}已设为导入时可替换；用户不选择时继续使用内置素材。` });
  }

  function assignMediaVariable(media: TemplateMediaField, key: string): boolean {
    const normalized = key.trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
      setNotice({ kind: "error", text: "变量标识只能包含字母、数字、点、横线和下划线。" });
      return false;
    }
    const existing = loaded?.template.inputs.find((input) => input.key === normalized);
    if (existing && existing.kind !== media.kind) {
      setNotice({ kind: "error", text: `变量 [[${normalized}]] 已用于${inputKindLabel(existing.kind)}，不能绑定当前${media.label}。` });
      return false;
    }
    mutateTemplate((template) => { assignMediaInput(template, media.path, normalized); });
    setNotice({ kind: "success", text: `当前${media.label}已绑定到 [[${normalized}]]。` });
    return true;
  }

  function keepMediaFixed(media: TemplateMediaField) {
    mutateTemplate((template) => { detachMediaInput(template, media.path); });
    if (editingInputKey === media.key) setEditingInputKey("");
    setNotice({ kind: "success", text: `${media.label}已恢复为固定素材。` });
  }

  function updateMeta(patch: Partial<FlowTemplateV1["meta"]>) {
    mutateTemplate((template) => {
      Object.assign(template.meta, patch);
      if (patch.name != null) template.flow.name = patch.name;
    });
  }

  function cleanUnusedInputs() {
    let removed: string[] = [];
    mutateTemplate((template) => { removed = pruneUnusedTemplateInputs(template); });
    setNotice({ kind: "success", text: removed.length ? `已删除 ${removed.length} 个空临时变量：${removed.join("、")}` : "没有发现可自动清理的空临时变量。" });
  }

  function removeUnusedInput(key: string) {
    if (!window.confirm(`确定删除未使用变量 [[${key}]] 及其预置选项吗？`)) return;
    mutateTemplate((template) => {
      if (!removeUnusedTemplateInput(template, key)) throw new Error(`变量“${key}”不存在`);
    });
    if (editingInputKey === key) setEditingInputKey("");
    setNotice({ kind: "success", text: `已删除变量 [[${key}]]。` });
  }

  function applyNodeJson(blockIndex: number, value: unknown) {
    if (!loaded) return;
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("节点 JSON 必须是对象");
      const template = deepClone(loaded.template);
      const blocks = getBlocks(template);
      const currentKey = blocks[blockIndex]?.key;
      const nextKey = (value as Record<string, unknown>).key;
      if (nextKey !== currentKey) throw new Error("当前节点 JSON 模式不能修改节点 key；如确需修改请使用完整 JSON");
      (template.flow.post.blocks as unknown[])[blockIndex] = value;
      syncBlockRichTextMirrors(template, blockIndex);
      syncBlockTextInputBindings(template, blockIndex);
      const parsed = flowTemplateSchema.parse(template) as FlowTemplateV1;
      assertTemplateContract(parsed);
      patchActiveWorkspace({ loaded: { ...loaded, template: parsed }, editorText: JSON.stringify(parsed, null, 2) });
      setNotice({ kind: "success", text: "当前节点 JSON 已校验并同步到流程图。" });
    } catch (error) {
      setNotice({ kind: "error", text: `节点 JSON 无效：${messageOf(error)}` });
    }
  }

  function applySectionJson(section: "inputs" | "media" | "botFields", value: unknown) {
    if (!loaded) return;
    try {
      const template = deepClone(loaded.template);
      replaceTemplateSection(template, section, value);
      reconcileTemplateInputBindings(template);
      const parsed = flowTemplateSchema.parse(template) as FlowTemplateV1;
      assertTemplateContract(parsed);
      patchActiveWorkspace({ loaded: { ...loaded, template: parsed }, editorText: JSON.stringify(parsed, null, 2) });
      setNotice({ kind: "success", text: "分区 JSON 已校验并应用。" });
    } catch (error) {
      setNotice({ kind: "error", text: `分区 JSON 无效：${messageOf(error)}` });
    }
  }

  function validateAndApply(): FlowTemplateV1 | undefined {
    try {
      const template = flowTemplateSchema.parse(JSON.parse(editorText)) as FlowTemplateV1;
      reconcileTemplateInputBindings(template);
      assertTemplateContract(template);
      patchActiveWorkspace((workspace) => ({ loaded: { ...workspace.loaded, template }, editorText: JSON.stringify(template, null, 2) }));
      const nextGraph = buildTemplateGraph(template);
      if (!nextGraph.nodes.some((node) => node.id === selectedNodeId)) setSelectedNodeId(template.flow.entryBlockKey || nextGraph.nodes[0]?.id || "");
      setNotice({ kind: "success", text: "模板 JSON 校验通过，并已同步到流程图。" });
      return template;
    } catch (error) {
      setNotice({ kind: "error", text: `模板无效：${messageOf(error)}` });
      return undefined;
    }
  }

  function validateCurrentTemplate(): FlowTemplateV1 | undefined {
    if (!loaded) return undefined;
    try {
      const template = flowTemplateSchema.parse(loaded.template) as FlowTemplateV1;
      assertTemplateContract(template);
      const nextGraph = buildTemplateGraph(template);
      if (nextGraph.missingTargets.length) throw new Error(`存在 ${nextGraph.missingTargets.length} 个失效的节点连接`);
      setNotice({ kind: "success", text: "模板校验通过。" });
      return template;
    } catch (error) {
      setNotice({ kind: "error", text: `模板无效：${messageOf(error)}` });
      return undefined;
    }
  }

  async function exportArchive() {
    if (!loaded) return;
    const template = view === "json" ? validateAndApply() : validateCurrentTemplate();
    if (!template) return;
    setBusy(true);
    try {
      const archive = createTemplateArchive(template, loaded.assets);
      await downloadBytes(archive, `${safeName(template.meta.name)}.zip`, "application/zip");
      setNotice({ kind: "success", text: "编辑后的模板包已下载，流程结构和内置素材均已保留。" });
    } catch (error) {
      setNotice({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return <main className={`editor-shell ${workspaces.length ? "has-template-tabs" : ""}`}>
    <header className="topbar">
      <div className="workspace-brand"><strong>Botcake 模板工作区</strong><small>只读流程图 · 点击节点编辑模板内容</small></div>
      {workspaces.length > 0 && <nav className="template-tabs" aria-label="已打开的模板">
        <div>{workspaces.map((workspace) => <div className={`template-tab ${workspace.id === activeWorkspaceId ? "active" : ""}`} key={workspace.id}>
          <button className="template-tab-select" title={workspace.loaded.sourceName} onClick={() => switchWorkspace(workspace.id)}><strong>{workspace.loaded.template.meta.name}</strong><small>{workspace.loaded.sourceName}</small></button>
          <button className="template-tab-close" aria-label={`关闭 ${workspace.loaded.template.meta.name}`} onClick={() => closeWorkspace(workspace.id)}>×</button>
        </div>)}</div>
        <label className="template-tab-add" title="再打开一个模板">＋<input type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openArchive(file); }} /></label>
      </nav>}
      <div className="top-actions">
        <label className="open-button">打开 ZIP 模板<input type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openArchive(file); }} /></label>
      </div>
    </header>

    <div className="template-commandbar">
      <div className={`notice ${notice.kind}`}>{busy && <span className="spinner" />}{notice.text}</div>
      {workspaces.length > 0 && <nav className="view-tabs" aria-label="当前模板视图">
        <button className={view === "flow" ? "active" : ""} onClick={() => { setEditingInputKey(""); setView("flow"); }}>流程图</button>
        <button className={view === "settings" ? "active" : ""} onClick={() => { setEditingInputKey(""); setView("settings"); }}>模板设置</button>
        <button className={view === "json" ? "active" : ""} onClick={() => { setEditingInputKey(""); setView("json"); }}>高级 JSON</button>
      </nav>}
      {workspaces.length > 0 && <button className="primary export-current" disabled={!loaded || busy} onClick={exportArchive}>导出当前模板</button>}
    </div>

    {!loaded || !graph ? <EmptyWorkspace onOpen={openArchive} /> : <>
      {view === "flow" && <div className={`flow-workspace ${inspectorMode === "json" ? "json-focus" : ""} ${editingInput ? "has-variable-editor" : ""}`}>
        <section className="graph-panel">
          <div className="graph-toolbar">
            <div><strong>{loaded.template.meta.name}</strong><span>{graph.nodes.length} 个节点 · {graph.edges.length} 组连线</span></div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点名称、文案或标识" />
          </div>
          {graph.missingTargets.length > 0 && <div className="graph-warning">发现 {graph.missingTargets.length} 个失效节点连接，导出前需要处理。</div>}
          <div className="graph-canvas"><TemplateGraphCanvas graph={graph} assets={loaded.assets} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} query={query} /></div>
        </section>
        {editingInput && <VariableSettingsPanel input={editingInput} usage={inputUsageCount(loaded.template, editingInput)} onUpdate={(patch) => updateInput(editingInput.key, patch)} onDelete={() => removeUnusedInput(editingInput.key)} />}
        <NodeInspector loaded={loaded} node={selectedNode} contentItems={contentItems} mediaFields={mediaFields} botFields={nodeBotFields} mode={inspectorMode} onModeChange={setInspectorMode} onUpdateText={updateTextField} onUpdateNodeValue={updateNodeValue} onEditInput={setEditingInputKey} onMakeMediaVariable={makeMediaVariable} onAssignMediaVariable={assignMediaVariable} onKeepMediaFixed={keepMediaFixed} onApplyNodeJson={applyNodeJson} />
      </div>}

      {view === "settings" && <div className={`settings-docked-layout ${editingInput ? "has-variable-editor" : ""}`}><TemplateSettings loaded={loaded} graphNodeCount={graph.nodes.length} mode={settingsView} editingInputKey={editingInput?.key} onModeChange={(mode) => { setEditingInputKey(""); setSettingsView(mode); }} onUpdateMeta={updateMeta} onCleanUnusedInputs={cleanUnusedInputs} onEditInput={setEditingInputKey} onRemoveUnusedInput={removeUnusedInput} onApplySectionJson={applySectionJson} />{editingInput && <VariableSettingsPanel input={editingInput} usage={inputUsageCount(loaded.template, editingInput)} onUpdate={(patch) => updateInput(editingInput.key, patch)} onDelete={() => removeUnusedInput(editingInput.key)} />}</div>}

      {view === "json" && <section className="json-panel standalone-panel">
        <div className="panel-heading"><div><h1>template.json</h1><p>高级模式会直接修改模板结构，验证后同步回流程图。</p></div><button disabled={busy} onClick={validateAndApply}>验证并应用</button></div>
        <textarea value={editorText} onChange={(event) => setEditorText(event.target.value)} spellCheck={false} />
      </section>}
    </>}
  </main>;
}

type InspectorProps = {
  loaded: LoadedTemplate;
  node?: ReturnType<typeof buildTemplateGraph>["nodes"][number];
  contentItems: TemplateContentItem[];
  mediaFields: TemplateMediaField[];
  botFields: LoadedTemplate["template"]["dependencies"]["botFields"];
  mode: "visual" | "json";
  onModeChange: (mode: "visual" | "json") => void;
  onUpdateText: (field: TemplateTextField, value: string) => void;
  onUpdateNodeValue: (path: string, value: unknown) => void;
  onEditInput: (key: string) => void;
  onMakeMediaVariable: (media: TemplateMediaField) => void;
  onAssignMediaVariable: (media: TemplateMediaField, key: string) => boolean;
  onKeepMediaFixed: (media: TemplateMediaField) => void;
  onApplyNodeJson: (blockIndex: number, value: unknown) => void;
};

function NodeInspector({ loaded, node, contentItems, mediaFields, botFields, mode, onModeChange, onUpdateText, onUpdateNodeValue, onEditInput, onMakeMediaVariable, onAssignMediaVariable, onKeepMediaFixed, onApplyNodeJson }: InspectorProps) {
  if (!node) return <aside className="inspector-panel empty-inspector"><strong>选择一个节点</strong><p>点击流程图中的节点，在这里查看并编辑它的文案、素材和变量。</p></aside>;
  const block = getBlocks(loaded.template)[node.blockIndex];
  return <aside className="inspector-panel">
    <div className="inspector-heading"><div><span>{node.type}{node.entry && " · 入口节点"}</span><h2>{node.title}</h2><small>{node.id}</small></div><div className="inspector-mode"><button className={mode === "visual" ? "active" : ""} onClick={() => onModeChange("visual")}>可视化</button><button className={mode === "json" ? "active" : ""} onClick={() => onModeChange("json")}>节点 JSON</button></div></div>
    {mode === "json" ? <div className="node-json-view"><JsonDraftEditor value={block} onApply={(value) => onApplyNodeJson(node.blockIndex, value)} title="当前节点 JSON" description="只编辑当前节点；节点 key 在此模式下保持不变。" /></div> :
    <div className="inspector-scroll">
      {node.kind === "condition" ? <ConditionInspector loaded={loaded} blockIndex={node.blockIndex} onUpdate={onUpdateNodeValue} /> :
      node.kind === "delay" ? <DelayInspector loaded={loaded} blockIndex={node.blockIndex} onUpdate={onUpdateNodeValue} /> :
      node.kind === "action" ? <ActionInspector loaded={loaded} blockIndex={node.blockIndex} /> :
      node.kind === "message" ? <>
      <SectionHeading title="内容" count={contentItems.length} />
      {contentItems.length ? contentItems.map((item) => item.kind === "button"
        ? <div className="button-field-group" key={item.title.path}><strong>{item.label}</strong><TextFieldEditor field={item.title} inputs={loaded.template.inputs} displayLabel="按钮文字" input={findExactInput(loaded.template.inputs, item.title.value)} onUpdate={(value) => onUpdateText(item.title, value)} onEditInput={onEditInput} /><TextFieldEditor field={item.link} inputs={loaded.template.inputs} displayLabel="打开链接" input={findExactInput(loaded.template.inputs, item.link.value)} onUpdate={(value) => onUpdateText(item.link, value)} onEditInput={onEditInput} /></div>
        : <TextFieldEditor key={item.field.path} field={item.field} inputs={loaded.template.inputs} input={findExactInput(loaded.template.inputs, item.field.value)} onUpdate={(value) => onUpdateText(item.field, value)} onEditInput={onEditInput} />) : <EmptySection text="这个节点没有识别到可编辑内容。" />}
      <SectionHeading title="素材" count={mediaFields.length} />
      {mediaFields.length ? mediaFields.map((media) => <MediaPreview key={media.path} media={media} loaded={loaded} input={loaded.template.inputs.find((item) => item.key === media.key && item.kind === media.kind)} onMakeVariable={() => onMakeMediaVariable(media)} onAssignKey={(key) => onAssignMediaVariable(media, key)} onKeepFixed={() => onKeepMediaFixed(media)} onEditInput={onEditInput} />) : <EmptySection text="这个节点没有图片或音频。" />}
      <SectionHeading title="机器人变量" count={botFields.length} />
      {botFields.length ? <div className="dependency-list">{botFields.map((field) => <div key={`${field.sourceId}-${field.name}`}><strong>{field.name}</strong><span>{field.fieldType ?? "自动识别类型"}</span><small>目标专页同名复用，没有则自动创建</small></div>)}</div> : <EmptySection text="这个节点没有使用机器人变量。" />}
      </> : <UnknownNodeInspector block={block} />}
    </div>}
  </aside>;
}

function ActionInspector({ loaded, blockIndex }: { loaded: LoadedTemplate; blockIndex: number }) {
  const actionNode = getActionNodeView(loaded.template, blockIndex);
  if (!actionNode) return <EmptySection text="无法读取这个动作节点，请使用节点 JSON。" />;
  return <>
    <SectionHeading title="执行动作" count={actionNode.actions.length} />
    <div className="action-list">
      {actionNode.actions.map((item) => <div className="action-item" key={item.path}>
        <div><strong>{item.label}</strong><code>{item.action}</code></div>
        {item.tagNames.length > 0 && <p>标签：{item.tagNames.join("、")}</p>}
        <small>{item.tagNames.length
          ? "导入时按名称复用目标专页标签；没有同名标签会自动创建"
          : item.portable ? "此动作不依赖专页对象，导入时完整保留" : "尚未适配专页依赖，请检查节点 JSON"}</small>
      </div>)}
      {!actionNode.actions.length && <EmptySection text="这个节点没有动作。" />}
    </div>
    <div className="node-target default-target"><span>动作后进入</span><code>{actionNode.targetBlockKey || "未设置"}</code></div>
  </>;
}

function ConditionInspector({ loaded, blockIndex, onUpdate }: {
  loaded: LoadedTemplate;
  blockIndex: number;
  onUpdate: (path: string, value: unknown) => void;
}) {
  const condition = getConditionNodeView(loaded.template, blockIndex);
  if (!condition) return <EmptySection text="无法读取这个条件节点，请使用节点 JSON。" />;
  return <>
    <SectionHeading title="条件分支" count={condition.branches.length} />
    {condition.branches.map((branch) => <div className="condition-branch" key={branch.path}>
      <div className="condition-branch-heading"><strong>分支 {branch.index + 1}</strong><span>{branch.operator.toUpperCase()}</span></div>
      {branch.rules.length ? branch.rules.map((rule, ruleIndex) => <ConditionRuleEditor key={rule.path} rule={rule} index={ruleIndex} onUpdate={onUpdate} />) : <EmptySection text="这个分支没有条件。" />}
      <div className="node-target"><span>满足后进入</span><code>{branch.targetBlockKey || "未设置"}</code></div>
    </div>)}
    <div className="node-target default-target"><span>其他情况进入</span><code>{condition.defaultTargetBlockKey || "未设置"}</code></div>
  </>;
}

function ConditionRuleEditor({ rule, index, onUpdate }: {
  rule: ConditionRuleView;
  index: number;
  onUpdate: (path: string, value: unknown) => void;
}) {
  const isCurrentTime = rule.type === "current_time";
  return <div className="condition-rule">
    <div className="condition-rule-title"><strong>{rule.title}</strong><small>{rule.type}</small></div>
    {isCurrentTime ? <>
      <div className="time-range-editor">
        <label>开始<input type="time" value={timeValue(rule.beginHour, rule.beginMinute)} onChange={(event) => updateTime(rule.path, "begin", event.target.value, onUpdate)} /></label>
        <span>至</span>
        <label>结束<input type="time" value={timeValue(rule.endHour, rule.endMinute)} onChange={(event) => updateTime(rule.path, "end", event.target.value, onUpdate)} /></label>
      </div>
      <div className="weekday-editor">{[1, 2, 3, 4, 5, 6, 7].map((day) => <button className={rule.weekDays.includes(day) ? "active" : ""} key={day} onClick={() => onUpdate(`${rule.path}.week_days`, rule.weekDays.includes(day) ? rule.weekDays.filter((item) => item !== day) : [...rule.weekDays, day].sort())}>{`一二三四五六日`[day - 1]}</button>)}</div>
    </> : rule.type === "tags" ? <>
      <div className="dependency-list">{rule.tags.map((tag) => <div key={tag}><strong>{tag}</strong><small>导入时按名称匹配；目标专页没有时自动创建</small></div>)}</div>
      {!rule.tags.length && <EmptySection text="这个标签条件没有可识别的标签。" />}
    </> : <>
      <p className="condition-fallback">已识别条件类型；下面仅开放可安全编辑的基础值，完整结构可在节点 JSON 中修改。</p>
      {rule.values.map((field) => <label key={field.key}>{field.key}<input value={String(field.value)} onChange={(event) => onUpdate(`${rule.path}.${field.key}`, coercePrimitive(event.target.value, field.value))} /></label>)}
      {!rule.values.length && <EmptySection text={`条件 ${index + 1} 暂无可视化字段。`} />}
    </>}
  </div>;
}

function DelayInspector({ loaded, blockIndex, onUpdate }: {
  loaded: LoadedTemplate;
  blockIndex: number;
  onUpdate: (path: string, value: unknown) => void;
}) {
  const delay = getDelayNodeView(loaded.template, blockIndex);
  if (!delay) return <EmptySection text="无法读取这个延迟节点，请使用节点 JSON。" />;
  return <>
    <SectionHeading title="延迟设置" count={1} />
    <div className="delay-editor">
      <div className="delay-row"><label>等待时长<input type="number" min="0" value={delay.delayValue} onChange={(event) => onUpdate(`${delay.path}.delayValue`, Number(event.target.value))} /></label><label>单位<select value={delay.delayUnits} onChange={(event) => onUpdate(`${delay.path}.delayUnits`, event.target.value)}><option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></label></div>
      <label className="switch-label"><input type="checkbox" checked={delay.useTimeWindow} onChange={(event) => onUpdate(`${delay.path}.useTimeWindow`, event.target.checked)} />只在指定发送时段继续</label>
      {delay.useTimeWindow && <div className="delay-row"><label>开始时间<input type="number" min="0" max="23" value={delay.sendingTimeStart} onChange={(event) => onUpdate(`${delay.path}.sendingTimeStart`, Number(event.target.value))} /></label><label>结束时间<input type="number" min="0" max="23" value={delay.sendingTimeEnd} onChange={(event) => onUpdate(`${delay.path}.sendingTimeEnd`, Number(event.target.value))} /></label></div>}
      <div className="node-target"><span>延迟后进入</span><code>{delay.targetBlockKey || "未设置"}</code></div>
    </div>
  </>;
}

function UnknownNodeInspector({ block }: { block: Record<string, unknown> }) {
  const type = typeof block.type === "string" ? block.type : "未声明类型";
  return <div className="unknown-node"><strong>暂未适配：{type}</strong><p>这个节点不会按文本消息处理，因此不会误改内部字段。可切换到“节点 JSON”查看和编辑完整结构。</p></div>;
}

function timeValue(hour?: number, minute?: number): string {
  return `${String(hour ?? 0).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

function updateTime(path: string, prefix: "begin" | "end", value: string, onUpdate: (path: string, value: unknown) => void) {
  const [hour, minute] = value.split(":").map(Number);
  onUpdate(`${path}.${prefix}_hour`, hour);
  onUpdate(`${path}.${prefix}_min`, minute);
}

function coercePrimitive(value: string, original: string | number | boolean): string | number | boolean {
  if (typeof original === "number") return Number(value);
  if (typeof original === "boolean") return value === "true";
  return value;
}

function TextFieldEditor({ field, input, inputs, displayLabel, onUpdate, onEditInput }: {
  field: TemplateTextField;
  input?: TemplateInput;
  inputs: TemplateInput[];
  displayLabel?: string;
  onUpdate: (value: string) => void;
  onEditInput: (key: string) => void;
}) {
  const inlineKeys = [...new Set([...field.value.matchAll(/\[\[([A-Za-z0-9_.-]+)]]/g)].map((match) => match[1]))];
  const inlineInputs = inlineKeys.flatMap((key) => {
    const definition = inputs.find((item) => item.key === key);
    return definition ? [definition] : [];
  });
  const botVariables = [...new Map([...field.value.matchAll(/\{\{(\d+)\/\|([^}]+)}}/g)].map((match) => [match[2].trim().toLocaleLowerCase(), { id: match[1], name: match[2].trim() }])).values()];
  return <div className={`text-field-card ${input ? "variable" : ""}`}>
    <div className="field-title"><strong>{displayLabel ?? field.label}</strong>{input && <span>变量</span>}</div>
    <textarea rows={field.multiline ? 5 : 2} value={field.value} onChange={(event) => onUpdate(event.target.value)} />
    {input ? <VariableReference input={input} onEdit={() => onEditInput(input.key)} /> : <>
      {(inlineKeys.length > 0 || botVariables.length > 0) && <div className="inline-variable-list">{inlineKeys.map((key) => <code key={key}>[[{key}]]</code>)}{botVariables.map((variable) => <span className="bot-variable-chip" key={`${variable.id}-${variable.name}`}>机器人变量 · {variable.name}</span>)}</div>}
      {inlineInputs.length > 0 && <div className="inline-variable-settings-list">{inlineInputs.map((definition) => <VariableReference key={definition.key} input={definition} onEdit={() => onEditInput(definition.key)} />)}</div>}
    </>}
  </div>;
}

function VariableReference({ input, onEdit }: { input: TemplateInput; onEdit: () => void }) {
  return <button className="variable-reference" onClick={onEdit}><div><code>[[{input.key}]]</code><strong>{input.label}</strong></div><span>{input.required ? "必填" : "选填"} · {input.options?.length ?? 0} 个选项</span><b>编辑变量</b></button>;
}

function MediaPreview({ media, loaded, input, onMakeVariable, onAssignKey, onKeepFixed, onEditInput }: {
  media: TemplateMediaField;
  loaded: LoadedTemplate;
  input?: TemplateInput;
  onMakeVariable: () => void;
  onAssignKey: (key: string) => boolean;
  onKeepFixed: () => void;
  onEditInput: (key: string) => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const [keyDraft, setKeyDraft] = useState(media.key);
  useEffect(() => setKeyDraft(media.key), [media.key]);
  useEffect(() => {
    const bytes = media.asset ? loaded.assets.get(media.asset) : undefined;
    if (!bytes) { setObjectUrl(undefined); return; }
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaMime(media.kind, media.name ?? media.asset) }));
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [loaded.assets, media.asset, media.kind]);
  function commitKey(): boolean {
    const next = keyDraft.trim();
    if (next === media.key) return true;
    if (!/^[A-Za-z0-9_.-]+$/.test(next)) { setKeyDraft(media.key); return false; }
    const saved = onAssignKey(next);
    if (!saved) setKeyDraft(media.key);
    return saved;
  }
  function editVariable() {
    const next = keyDraft.trim();
    if (next !== media.key && !commitKey()) return;
    onEditInput(next || input?.key || media.key);
  }
  const source = objectUrl ?? media.url;
  return <div className="media-card">
    {media.kind === "image" && source && <img src={source} alt={media.name ?? "模板图片"} />}
    {media.kind === "audio" && source && <audio src={source} controls preload="metadata" />}
    {media.kind === "video" && source && <video src={source} controls preload="metadata" />}
    <div className="media-info"><strong>{media.name ?? media.label}</strong><span>{media.asset ? `内置：${media.asset}` : "使用远程素材"}</span></div>
    {input ? <div className="media-variable-settings">
      <div className="field-title"><strong>导入时可替换</strong><span>素材变量</span></div>
      <div className="media-binding-row"><label>当前素材的变量标识<input value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} onBlur={commitKey} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setKeyDraft(media.key); event.currentTarget.blur(); } }} spellCheck={false} /></label><button onMouseDown={(event) => event.preventDefault()} onClick={editVariable}>编辑变量</button></div>
      <small>输入已有标识可共享同一素材；改成新标识即可单独拆分。失焦后自动保存。</small>
      <button className="subtle danger-text" onClick={onKeepFixed}>恢复为固定素材</button>
    </div> : <div className="media-variable-action">
      <p>当前为固定素材，导入模板时不会显示上传框。</p>
      <button onClick={onMakeVariable}>设为导入时可替换</button>
    </div>}
  </div>;
}

function TemplateSettings({ loaded, graphNodeCount, mode, editingInputKey, onModeChange, onUpdateMeta, onCleanUnusedInputs, onEditInput, onRemoveUnusedInput, onApplySectionJson }: {
  loaded: LoadedTemplate;
  graphNodeCount: number;
  mode: SettingsView;
  editingInputKey?: string;
  onModeChange: (mode: SettingsView) => void;
  onUpdateMeta: (patch: Partial<FlowTemplateV1["meta"]>) => void;
  onCleanUnusedInputs: () => void;
  onEditInput: (key: string) => void;
  onRemoveUnusedInput: (key: string) => void;
  onApplySectionJson: (section: "inputs" | "media" | "botFields", value: unknown) => void;
}) {
  const template = loaded.template;
  const section = mode === "overview" ? undefined : mode;
  const sectionValue = section === "inputs" ? template.inputs : section === "media" ? template.dependencies.media : section === "botFields" ? template.dependencies.botFields : undefined;
  const sectionTitle = section === "inputs" ? "输入变量 JSON" : section === "media" ? "素材依赖 JSON" : "机器人变量 JSON";
  return <div className="settings-shell">
    <nav className="settings-section-tabs" aria-label="模板设置分区">
      <button className={mode === "overview" ? "active" : ""} onClick={() => onModeChange("overview")}>基本设置</button>
      <button className={mode === "inputs" ? "active" : ""} onClick={() => onModeChange("inputs")}>输入变量 JSON</button>
      <button className={mode === "media" ? "active" : ""} onClick={() => onModeChange("media")}>素材依赖 JSON</button>
      <button className={mode === "botFields" ? "active" : ""} onClick={() => onModeChange("botFields")}>机器人变量 JSON</button>
    </nav>
    {section ? <div className="settings-json-panel"><JsonDraftEditor value={sectionValue} onApply={(value) => onApplySectionJson(section, value)} title={sectionTitle} description="这里只编辑一个分区；应用后会校验整份模板并同步到其他视图。" /></div> : <div className="settings-workspace">
    <section className="settings-card"><h2>模板信息</h2><label>模板名称<input value={template.meta.name} onChange={(event) => onUpdateMeta({ name: event.target.value })} /></label><label>模板说明<textarea rows={4} value={template.meta.description ?? ""} onChange={(event) => onUpdateMeta({ description: event.target.value })} /></label><dl><div><dt>入口节点</dt><dd>{template.flow.entryBlockKey}</dd></div><div><dt>节点</dt><dd>{graphNodeCount}</dd></div><div><dt>输入项</dt><dd>{template.inputs.length}</dd></div><div><dt>机器人变量</dt><dd>{template.dependencies.botFields.length}</dd></div><div><dt>标签</dt><dd>{template.dependencies.tags?.length ?? 0}</dd></div><div><dt>素材</dt><dd>{loaded.assets.size}</dd></div></dl></section>
    <section className="settings-card wide"><div className="settings-card-heading"><div><h2>全部输入变量</h2><p>点击变量后在右侧栏编辑，不会离开当前设置页。</p></div><button onClick={onCleanUnusedInputs}>清理空临时变量</button></div>{template.inputs.length ? <div className="input-table">{template.inputs.map((input) => { const usage = inputUsageCount(template, input); const active = editingInputKey === input.key; return <div className={`input-summary-row ${active ? "editing" : ""}`} key={input.key}><code>[[{input.key}]]</code><strong>{input.label}</strong><span>{inputKindLabel(input.kind)}</span><span>{usage} 处使用</span><span>{input.options?.length ? `${input.options.length} 个选项` : "无预置选项"}</span><div className="input-summary-actions"><button onClick={() => onEditInput(input.key)}>{active ? "编辑中" : "编辑变量"}</button>{usage === 0 && <button className="subtle danger-text" onClick={() => onRemoveUnusedInput(input.key)}>删除</button>}</div></div>; })}</div> : <EmptySection text="还没有模板输入项，请从流程图选择文案并设置变量。" />}</section>
    <section className="settings-card wide"><h2>资源和依赖</h2><div className="settings-columns"><div><h3>内置素材</h3>{[...loaded.assets.entries()].map(([name, bytes]) => <p key={name}><span>{name}</span><small>{formatBytes(bytes.byteLength)}</small></p>)}{!loaded.assets.size && <p className="muted">没有内置素材</p>}</div><div><h3>机器人变量</h3>{template.dependencies.botFields.map((field) => <p key={`${field.sourceId}-${field.name}`}><span>{field.name}</span><small>{field.fieldType ?? "自动"}</small></p>)}{!template.dependencies.botFields.length && <p className="muted">没有机器人变量</p>}</div></div>{template.dependencies.unsupported.length > 0 && <div className="unsupported-box"><strong>需要人工处理的绑定</strong>{template.dependencies.unsupported.map((item) => <p key={`${item.path}-${item.key}`}>{item.reason}<small>{item.path}</small></p>)}</div>}</section>
    </div>}
  </div>;
}

function VariableSettingsPanel({ input, usage, onUpdate, onDelete }: {
  input: TemplateInput;
  usage: number;
  onUpdate: (patch: Partial<TemplateInput>) => void;
  onDelete: () => void;
}) {
  const isMedia = isMediaKind(input.kind);
  return <aside className="variable-editor-panel" role="region" aria-label={`编辑变量 ${input.label}`}>
      <header className="variable-editor-heading">
        <div><span>变量选项编辑</span><h2>{input.label}</h2><code>[[{input.key}]]</code></div>
        <small>{usage} 处使用</small>
      </header>
      <div className="variable-editor-scroll">
        <section className="variable-basic-card">
          <h3>基本信息</h3>
          <div className="variable-basic-grid">
            <label>显示名称<input value={input.label} onChange={(event) => onUpdate({ label: event.target.value })} /></label>
            {isMedia ? <label>输入类型<input value={inputKindLabel(input.kind)} readOnly /></label> : <label>输入类型<select value={input.kind} onChange={(event) => { const kind = event.target.value as TemplateInput["kind"]; onUpdate(kind === "random" ? { kind, default: undefined, required: true } : { kind }); }}><option value="text">文字</option><option value="number">数字</option><option value="random">随机选项</option></select></label>}
          </div>
          <label className="variable-required"><input type="checkbox" checked={input.required ?? false} onChange={(event) => onUpdate({ required: event.target.checked })} />导入流程时必填</label>
          <label>填写说明<textarea rows={3} value={input.description ?? ""} onChange={(event) => onUpdate({ description: event.target.value || undefined })} placeholder="显示给使用模板的人" /></label>
          {!isMedia && input.kind !== "random" && <label>默认值<textarea rows={input.kind === "text" ? 4 : 2} value={input.default == null ? "" : String(input.default)} onChange={(event) => onUpdate({ default: event.target.value || undefined })} placeholder="不填写时使用的内容（可选）" /></label>}
          {input.kind === "random" && <p className="variable-media-note">用户可以指定一个预置选项；未选择时，每次导入流程随机使用其中一项。同一变量的所有位置使用同一次随机结果。</p>}
          {isMedia && <p className="variable-media-note">用户没有选择素材时，继续使用模板包中的固定素材。</p>}
        </section>
        <section className="variable-options-card">
          <InputOptionsEditor input={input} onUpdate={(options) => onUpdate({ options })} />
        </section>
        {usage === 0 && <button className="variable-delete-button danger-text" onClick={onDelete}>删除未使用变量</button>}
      </div>
  </aside>;
}

function InputOptionsEditor({ input, onUpdate }: { input: TemplateInput; onUpdate: (options: NonNullable<TemplateInput["options"]>) => void }) {
  const options = input.options ?? [];
  const isMedia = isMediaKind(input.kind);
  function patchOption(index: number, patch: Partial<NonNullable<TemplateInput["options"]>[number]>) {
    onUpdate(options.map((option, optionIndex) => optionIndex === index ? { ...option, ...patch } : option));
  }
  return <div className="input-options-editor">
    <div className="option-editor-heading"><strong>预置选项</strong><small>{isMedia ? "URL 支持公开 Google Drive 文件" : "可直接填写内容，也可从公开文本链接读取"}</small></div>
    {options.map((option, index) => <div className="input-option-row" key={index}>
      <label>选项标题<input value={option.label} onChange={(event) => patchOption(index, { label: event.target.value })} placeholder={`选项 ${index + 1}`} /></label>
      {isMedia ? <>
        <label>素材 URL<input value={option.url ?? ""} onChange={(event) => patchOption(index, { url: event.target.value || undefined })} placeholder="普通 URL 或公开 Google Drive 链接" /></label>
        <label>资源包内路径<input value={option.asset ?? ""} onChange={(event) => patchOption(index, { asset: event.target.value || undefined })} placeholder={`例如 assets/${input.kind}_1.${input.kind === "image" ? "png" : input.kind === "audio" ? "mp3" : "mp4"}（可选）`} /></label>
      </> : <>
        <label>实际内容{input.kind === "number" ? <input type="number" value={option.value ?? ""} onChange={(event) => patchOption(index, { value: event.target.value })} placeholder="用户选择后填入流程的数字" /> : <textarea rows={4} value={option.value ?? ""} onChange={(event) => patchOption(index, { value: event.target.value })} placeholder="用户选择后填入流程的完整内容" />}</label>
        <label>远程文本 URL<input value={option.url ?? ""} onChange={(event) => patchOption(index, { url: event.target.value || undefined })} placeholder="可选；设置后优先读取该链接" /></label>
      </>}
      <button className="subtle danger-text" onClick={() => onUpdate(options.filter((_option, optionIndex) => optionIndex !== index))}>删除此选项</button>
    </div>)}
    <button onClick={() => onUpdate([...options, { label: `选项 ${options.length + 1}`, value: isMedia ? undefined : "" }])}>＋ 添加一个选项</button>
  </div>;
}

function JsonDraftEditor({ value, onApply, title, description }: {
  value: unknown;
  onApply: (value: unknown) => void;
  title: string;
  description: string;
}) {
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState("");
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  function apply() {
    try {
      const next = JSON.parse(text) as unknown;
      setError("");
      onApply(next);
    } catch (parseError) {
      setError(`JSON 语法错误：${messageOf(parseError)}`);
    }
  }
  return <section className="section-json-editor">
    <div className="section-json-heading"><div><h3>{title}</h3><p>{description}</p></div><button onClick={apply}>校验并应用</button></div>
    {error && <div className="json-error">{error}</div>}
    <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} />
  </section>;
}

function EmptyWorkspace({ onOpen }: { onOpen: (file: File) => Promise<void> }) {
  return <div className="empty-workspace"><div><strong>打开模板 ZIP 开始编辑</strong><p>流程图会按照 Botcake 原坐标显示，节点和连线保持只读。</p><label className="open-button primary">选择 ZIP 文件<input type="file" accept=".zip,application/zip" onChange={(event) => event.target.files?.[0] && void onOpen(event.target.files[0])} /></label></div></div>;
}

function SectionHeading({ title, count }: { title: string; count: number }) { return <div className="section-heading"><h3>{title}</h3><span>{count}</span></div>; }
function EmptySection({ text }: { text: string }) { return <p className="empty-section">{text}</p>; }
function findExactInput(inputs: TemplateInput[], value: string): TemplateInput | undefined { const key = exactVariable(value); return key ? inputs.find((item) => item.key === key) : undefined; }
function exactVariable(value: string): string | undefined { return value.match(/^\[\[([A-Za-z0-9_.-]+)]]$/)?.[1]; }
function inputKindLabel(kind: TemplateInput["kind"]): string { return ({ text: "文字", number: "数字", random: "随机选项", image: "图片", audio: "音频", video: "视频" } as const)[kind]; }
function nextMediaInputKey(template: FlowTemplateV1, kind: MediaKind): string { const used = new Set([...template.inputs.map((input) => input.key), ...template.dependencies.media.map((media) => media.key)]); let index = 1; while (used.has(`${kind}_${index}`)) index += 1; return `${kind}_${index}`; }
function isMediaKind(kind: TemplateInput["kind"]): kind is MediaKind { return kind === "image" || kind === "audio" || kind === "video"; }
function mediaMime(kind: MediaKind, name = ""): string { if (kind === "image") return /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : "image/jpeg"; if (kind === "audio") return /\.m4a$/i.test(name) ? "audio/mp4" : "audio/mpeg"; return /\.webm$/i.test(name) ? "video/webm" : /\.mov$/i.test(name) ? "video/quicktime" : "video/mp4"; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeName(value: string): string { return value.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "botcake-template"; }
function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes}B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`; return `${(bytes / 1024 / 1024).toFixed(2)}MB`; }
