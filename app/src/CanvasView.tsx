import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { api } from "./api";
import ConfirmPopover from "./ConfirmPopover";
import { AddMaterialIcon, AddStagedIcon, ArrowIcon, CloseIcon, EmptyStagedIcon, ExportIcon, FitIcon, HtmlIcon, MoveIcon, TrashIcon, TrayIcon } from "./Icons";
import SelectMenu from "./SelectMenu";
import type { AssetRecord, ItemRecord } from "./types";

interface CanvasViewProps {
  item: ItemRecord;
  allItems: ItemRecord[];
  onBack: (withTransition?: boolean) => void;
  onChange: (item: ItemRecord) => void;
  onLibraryChange: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

// 和服务端保持一致：预览图最长边上限、画布尺寸上下限。
const PREVIEW_CAP = 2400;
const MAX_CANVAS_SIZE = 12000;
const MIN_CANVAS_WIDTH = 120;
const MIN_CANVAS_HEIGHT = 90;
// 进入画布时单张素材的目标显示宽度（屏幕 px）：宁可让内容溢出视口，也不为了塞下全部素材而缩到看不清。
const COMFORTABLE_NODE_WIDTH = 300;

interface Viewport { x: number; y: number; scale: number }

// 节点在视口内（含预加载余量）才值得加载原图。
function isNearViewport(asset: AssetRecord, viewport: Viewport, margin = 240): boolean {
  const screenX = viewport.x + asset.x * viewport.scale;
  const screenY = viewport.y + asset.y * viewport.scale;
  const screenWidth = asset.canvasWidth * viewport.scale;
  const screenHeight = asset.canvasHeight * viewport.scale;
  return screenX + screenWidth > -margin
    && screenY + screenHeight > -margin
    && screenX < window.innerWidth + margin
    && screenY < window.innerHeight + margin;
}

// 预览图的实际像素宽度：服务端只在长边超过 PREVIEW_CAP 时才等比压缩，小图保持原分辨率。
function previewPixelWidth(asset: AssetRecord): number {
  if (!asset.width || !asset.height) return PREVIEW_CAP;
  const maxDimension = Math.max(asset.width, asset.height);
  return maxDimension > PREVIEW_CAP ? (asset.width * PREVIEW_CAP) / maxDimension : asset.width;
}

// 按需加载原图：素材总量可能几百 MB，绝不能把所有原图同时拉进画布。
// 只有节点在视口内、且显示所需像素已经追平预览分辨率（此时预览会发虚）才叠加原图。
// 原图叠在预览之上淡入，加载期间看到的仍是预览而不是空白；一旦加载完成就保持原图，
// 避免缩放来回切换 src 造成反复变糊，滚出视口才卸载。
function wantsOriginal(asset: AssetRecord, viewport: Viewport, loaded: boolean): boolean {
  if (asset.kind !== "image" || !asset.width || !asset.height) return false;
  if (!isNearViewport(asset, viewport)) return false;
  if (loaded) return true;
  const devicePixels = asset.canvasWidth * viewport.scale * (window.devicePixelRatio || 1);
  return devicePixels > previewPixelWidth(asset) * 0.9;
}

function imageClipboardType(name: string): string | null {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
  } as Record<string, string>)[extension] ?? null;
}

async function imageAsPng(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法转换这张图片。 ");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("浏览器无法转换这张图片。 ")), "image/png");
    });
  } finally {
    bitmap.close();
  }
}

type ResizeCorner = "nw" | "ne" | "sw" | "se";
interface NodeOrigin { x: number; y: number; width: number; height: number }
interface Gesture {
  type: "pan" | "press" | "drag" | "resize" | "marquee";
  pointerId: number;
  startX: number;
  startY: number;
  panX?: number;
  panY?: number;
  primaryId?: string;
  ids?: string[];
  origins?: Map<string, NodeOrigin>;
  corner?: ResizeCorner;
  baseSelection?: string[];
}
// 框选矩形：容器内的屏幕坐标。
interface Marquee { left: number; top: number; width: number; height: number }
// 对齐吸附线：世界坐标下的起点和终点。
interface AlignmentGuide { x1: number; y1: number; x2: number; y2: number }
interface SnapCandidate { value: number; type: "edge" | "center" }
interface SnapTarget { pos: number; min: number; max: number }
interface SnapGroup { pos: number; targets: SnapTarget[] }

// 单轴吸附：先在 candidates（被拖节点的边/中心）与 targets（其他节点的边/中心）
// 之间找最近修正量 delta；吸附生效后再收集所有真正对齐的线（同线对齐的多个节点
// 合并成一条统一对齐线），并按“边优先于中心”过滤——同尺寸重叠时只显示边线。
function snapAxis(candidates: SnapCandidate[], targets: SnapTarget[], threshold: number, epsilon: number): { delta: number; groups: SnapGroup[] } | null {
  let bestDelta: number | null = null;
  for (const candidate of candidates) {
    for (const target of targets) {
      const delta = target.pos - candidate.value;
      if (Math.abs(delta) > threshold) continue;
      if (bestDelta !== null && Math.abs(bestDelta) <= Math.abs(delta)) continue;
      bestDelta = delta;
    }
  }
  if (bestDelta === null) return null;
  const edgeGroups: SnapGroup[] = [];
  const centerGroups: SnapGroup[] = [];
  for (const candidate of candidates) {
    const alignedPos = candidate.value + bestDelta;
    const matched = targets.filter((target) => Math.abs(target.pos - alignedPos) <= epsilon);
    if (matched.length === 0) continue;
    (candidate.type === "edge" ? edgeGroups : centerGroups).push({ pos: alignedPos, targets: matched });
  }
  return { delta: bestDelta, groups: edgeGroups.length > 0 ? edgeGroups : centerGroups };
}

export default function CanvasView({ item, allItems, onBack, onChange, onLibraryChange, onError, onSuccess }: CanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const copyingRef = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const addFeedbackTimer = useRef<number | null>(null);
  const defaultScaleRef = useRef(0.85);
  // 双击还原原始尺寸前的画布尺寸，用于再次双击切回来。
  const previousSizeRef = useRef(new Map<string, { width: number; height: number }>());
  const [assets, setAssets] = useState(item.assets);
  const assetsRef = useRef(item.assets);
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 96, scale: 0.85 });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 工具条挂在最后一次点击的素材上，但动作作用于整个选择。
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [interactiveId, setInteractiveId] = useState<string | null>(null);
  const [loadedOriginals, setLoadedOriginals] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [tags, setTags] = useState(item.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [staged, setStaged] = useState<AssetRecord[]>([]);
  const [stagedOpen, setStagedOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addFeedback, setAddFeedback] = useState("");
  const titleRef = useRef(item.title);
  const noteRef = useRef(item.note);
  const tagsRef = useRef(item.tags);
  const tagDraftRef = useRef("");
  const lastSavedRef = useRef(JSON.stringify({ title: item.title, note: item.note, tags: item.tags }));
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);

  useEffect(() => {
    setAssets(item.assets);
    assetsRef.current = item.assets;
    previousSizeRef.current.clear();
    setLoadedOriginals(new Set());
    setTitle(item.title);
    setNote(item.note);
    setTags(item.tags);
    titleRef.current = item.title;
    noteRef.current = item.note;
    tagsRef.current = item.tags;
    lastSavedRef.current = JSON.stringify({ title: item.title, note: item.note, tags: item.tags });
  }, [item.id]);

  // 两种取景方式共用一套边界计算：
  // enter 进画布看的是素材本身——按中位素材的舒适显示宽度取景，不强行把全部素材塞进视口；
  // fit 才是“适应全部内容”，把整个内容组完整放进可用区域。
  const applyView = useCallback((mode: "enter" | "fit") => {
    const container = containerRef.current;
    const list = assetsRef.current;
    if (!container || list.length === 0) return;
    const minX = Math.min(...list.map((asset) => asset.x));
    const minY = Math.min(...list.map((asset) => asset.y));
    const maxX = Math.max(...list.map((asset) => asset.x + asset.canvasWidth));
    const maxY = Math.max(...list.map((asset) => asset.y + asset.canvasHeight));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const reserved = panelOpen ? 390 : 80;
    const availableWidth = Math.max(320, container.clientWidth - reserved - 96);
    const availableHeight = Math.max(320, container.clientHeight - 148);
    let scale: number;
    if (mode === "fit") {
      scale = Math.max(0.14, Math.min(1.25, availableWidth / width, availableHeight / height));
    } else {
      const widths = list.map((asset) => asset.canvasWidth).sort((left, right) => left - right);
      const median = widths[Math.floor(widths.length / 2)] || 420;
      const wholeWidth = Math.min(1.25, availableWidth / width);
      scale = Math.max(0.2, Math.min(1.25, Math.max(COMFORTABLE_NODE_WIDTH / median, wholeWidth)));
      defaultScaleRef.current = scale;
    }
    const contentWidth = width * scale;
    const contentHeight = height * scale;
    setViewport({
      scale,
      x: 48 + (contentWidth <= availableWidth ? (availableWidth - contentWidth) / 2 : 0) - minX * scale,
      y: 74 + (contentHeight <= availableHeight ? (availableHeight - contentHeight) / 2 : 0) - minY * scale,
    });
  }, [panelOpen]);

  // Take the entry framing once after the detail canvas has real dimensions. Asset movement must not retrigger it.
  useLayoutEffect(() => {
    applyView("enter");
  }, [item.id]);

  const persistDraft = useCallback(async (): Promise<void> => {
    if (savePromiseRef.current) await savePromiseRef.current;
    const normalizedTitle = titleRef.current.trim() || "未命名内容组";
    if (normalizedTitle !== titleRef.current) {
      titleRef.current = normalizedTitle;
      setTitle(normalizedTitle);
    }
    const patch = { title: normalizedTitle, note: noteRef.current, tags: tagsRef.current };
    const snapshot = JSON.stringify(patch);
    if (snapshot === lastSavedRef.current) return;
    setSaving(true);
    const pending = (async () => {
      const updated = await api.updateItem(item.id, patch);
      lastSavedRef.current = snapshot;
      onChange({ ...updated, assets: assetsRef.current });
      onLibraryChange();
    })();
    savePromiseRef.current = pending;
    try {
      await pending;
    } catch (error) {
      onError(error instanceof Error ? error.message : "保存失败。 ");
      throw error;
    } finally {
      if (savePromiseRef.current === pending) savePromiseRef.current = null;
      setSaving(false);
    }
    if (JSON.stringify({ title: titleRef.current, note: noteRef.current, tags: tagsRef.current }) !== lastSavedRef.current) {
      await persistDraft();
    }
  }, [item.id, onChange, onError, onLibraryChange]);

  useEffect(() => {
    const snapshot = JSON.stringify({ title, note, tags });
    if (snapshot === lastSavedRef.current) return;
    const timer = window.setTimeout(() => { void persistDraft().catch(() => undefined); }, 500);
    return () => window.clearTimeout(timer);
  }, [title, note, persistDraft, tags]);

  useEffect(() => {
    const preserveLatestDraft = () => {
      const patch = { title: titleRef.current, note: noteRef.current, tags: tagsRef.current };
      if (JSON.stringify(patch) !== lastSavedRef.current) api.updateItemKeepalive(item.id, patch);
    };
    window.addEventListener("pagehide", preserveLatestDraft);
    return () => {
      window.removeEventListener("pagehide", preserveLatestDraft);
      preserveLatestDraft();
    };
  }, [item.id]);

  const otherItems = useMemo(() => allItems.filter((candidate) => candidate.id !== item.id), [allItems, item.id]);

  const loadStaged = useCallback(async () => {
    try {
      setStaged(await api.staged());
    } catch (error) {
      onError(error instanceof Error ? error.message : "暂存区读取失败。 ");
    }
  }, [onError]);

  useEffect(() => { void loadStaged(); }, [loadStaged]);

  useEffect(() => () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    if (addFeedbackTimer.current !== null) window.clearTimeout(addFeedbackTimer.current);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setAnchorId(null);
  }, []);

  const resetTransientState = useCallback((closeStaged = false) => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    gesture.current = null;
    clearSelection();
    setDraggingId(null);
    setInteractiveId(null);
    setMarquee(null);
    setGuides([]);
    if (closeStaged) setStagedOpen(false);
  }, [clearSelection]);

  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    setViewport((current) => {
      const nextScale = Math.max(0.14, Math.min(2.5, current.scale * Math.exp(-deltaY * 0.0015)));
      const worldX = (pointX - current.x) / current.scale;
      const worldY = (pointY - current.y) / current.scale;
      return { scale: nextScale, x: pointX - worldX * nextScale, y: pointY - worldY * nextScale };
    });
  }, []);

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    // Wheel inside an open dropdown scrolls its list; only outside wheel resets the selection.
    if (target?.closest("[data-radix-popper-content-wrapper]")) return;
    event.preventDefault();
    if (selectedIds.length > 0 || interactiveId) resetTransientState();
    zoomAt(event.clientX, event.clientY, event.deltaY);
  }

  useEffect(() => {
    // An open Radix layer disables pointer events elsewhere, so outside wheel events target
    // <html> and never reach the stage. Handle them here: reset selection (which closes the
    // menu), then zoom — mirroring the stage wheel behavior.
    const onWindowWheel = (event: globalThis.WheelEvent) => {
      if (!document.querySelector("[data-radix-popper-content-wrapper]")) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-radix-popper-content-wrapper]")) return;
      event.preventDefault();
      resetTransientState();
      zoomAt(event.clientX, event.clientY, event.deltaY);
    };
    window.addEventListener("wheel", onWindowWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWindowWheel, { capture: true });
  }, [resetTransientState, zoomAt]);

  // 空白处：直接拖动是平移画布，按住 Shift/⌘ 拖动是框选。
  function beginStage(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, iframe, [role='combobox'], [role='listbox']")) return;
    if (event.target !== event.currentTarget && target.closest(".canvas-world")) return;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (additive) {
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { type: "marquee", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseSelection: selectedIds };
      setInteractiveId(null);
      return;
    }
    if (selectedIds.length > 0) {
      clearSelection();
      setInteractiveId(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { type: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: viewport.x, panY: viewport.y };
    setInteractiveId(null);
  }

  function updateMarquee(event: ReactPointerEvent<HTMLDivElement>, active: Gesture) {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const left = Math.min(active.startX, event.clientX) - rect.left;
    const top = Math.min(active.startY, event.clientY) - rect.top;
    const right = Math.max(active.startX, event.clientX) - rect.left;
    const bottom = Math.max(active.startY, event.clientY) - rect.top;
    setMarquee({ left, top, width: right - left, height: bottom - top });
    const worldLeft = (left - viewport.x) / viewport.scale;
    const worldTop = (top - viewport.y) / viewport.scale;
    const worldRight = (right - viewport.x) / viewport.scale;
    const worldBottom = (bottom - viewport.y) / viewport.scale;
    const hits = assetsRef.current
      .filter((asset) => asset.x < worldRight && asset.x + asset.canvasWidth > worldLeft && asset.y < worldBottom && asset.y + asset.canvasHeight > worldTop)
      .map((asset) => asset.id);
    const base = active.baseSelection ?? [];
    const next = [...base, ...hits.filter((id) => !base.includes(id))];
    setSelectedIds(next);
    setAnchorId(next[next.length - 1] ?? null);
  }

  function moveGesture(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current) return;
    if (current.type === "pan") {
      setViewport((value) => ({ ...value, x: (current.panX ?? 0) + event.clientX - current.startX, y: (current.panY ?? 0) + event.clientY - current.startY }));
      return;
    }
    if (current.type === "marquee") {
      updateMarquee(event, current);
      return;
    }
    if (current.type === "press") {
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      if (distance < 4) return;
      if (longPressTimer.current !== null) {
        window.clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
      // 指针捕获只在真正开始拖动时接管：按下就捕获会让浏览器把 click/dblclick
      // 重定向到画布容器，素材上的双击永远收不到。
      containerRef.current?.setPointerCapture(current.pointerId);
      gesture.current = { ...current, type: "drag" };
      setDraggingId(current.primaryId ?? null);
    }
    const active = gesture.current;
    if (!active || (active.type !== "drag" && active.type !== "resize")) return;
    const ids = active.ids ?? [];
    const origins = active.origins;
    if (!origins || ids.length === 0) return;
    const originList = ids.map((id) => origins.get(id)).filter((origin): origin is NodeOrigin => Boolean(origin));
    if (originList.length === 0) return;
    const dx = (event.clientX - active.startX) / viewport.scale;
    const dy = (event.clientY - active.startY) / viewport.scale;
    const corner = active.corner ?? "se";
    const isDrag = active.type === "drag";

    // 参与吸附的几何：拖动用整个选择的包围盒，缩放用被拖的那个角带动的两条边。
    let boxLeft: number;
    let boxTop: number;
    let boxRight: number;
    let boxBottom: number;
    if (isDrag) {
      boxLeft = Math.min(...originList.map((origin) => origin.x)) + dx;
      boxTop = Math.min(...originList.map((origin) => origin.y)) + dy;
      boxRight = Math.max(...originList.map((origin) => origin.x + origin.width)) + dx;
      boxBottom = Math.max(...originList.map((origin) => origin.y + origin.height)) + dy;
    } else {
      const origin = originList[0];
      boxLeft = origin.x;
      boxTop = origin.y;
      boxRight = origin.x + origin.width;
      boxBottom = origin.y + origin.height;
      if (corner === "nw" || corner === "sw") boxLeft = Math.min(origin.x + dx, boxRight - MIN_CANVAS_WIDTH);
      else boxRight = Math.max(boxRight + dx, boxLeft + MIN_CANVAS_WIDTH);
      if (corner === "nw" || corner === "ne") boxTop = Math.min(origin.y + dy, boxBottom - MIN_CANVAS_HEIGHT);
      else boxBottom = Math.max(boxBottom + dy, boxTop + MIN_CANVAS_HEIGHT);
    }

    // 把被操作素材的边/中心与画布上其他素材的边/中心做对齐吸附；阈值换算成世界坐标，
    // 约等于屏幕上 6px。
    const threshold = 6 / viewport.scale;
    const others = assetsRef.current.filter((asset) => !ids.includes(asset.id));
    const nextGuides: AlignmentGuide[] = [];
    let appliedDx = dx;
    let appliedDy = dy;
    if (others.length > 0) {
      const targetsX: SnapTarget[] = [];
      const targetsY: SnapTarget[] = [];
      for (const asset of others) {
        const top = asset.y;
        const bottom = asset.y + asset.canvasHeight;
        const left = asset.x;
        const right = asset.x + asset.canvasWidth;
        targetsX.push({ pos: left, min: top, max: bottom });
        targetsX.push({ pos: right, min: top, max: bottom });
        targetsX.push({ pos: (left + right) / 2, min: top, max: bottom });
        targetsY.push({ pos: top, min: left, max: right });
        targetsY.push({ pos: bottom, min: left, max: right });
        targetsY.push({ pos: (top + bottom) / 2, min: left, max: right });
      }
      // 拖动时包围盒的边和中心都参与吸附；缩放时只吸正在移动的那两条边。
      const movingLeft = corner === "nw" || corner === "sw";
      const movingTop = corner === "nw" || corner === "ne";
      const candidatesX: SnapCandidate[] = isDrag
        ? [{ value: boxLeft, type: "edge" }, { value: (boxLeft + boxRight) / 2, type: "center" }, { value: boxRight, type: "edge" }]
        : [{ value: movingLeft ? boxLeft : boxRight, type: "edge" }];
      const candidatesY: SnapCandidate[] = isDrag
        ? [{ value: boxTop, type: "edge" }, { value: (boxTop + boxBottom) / 2, type: "center" }, { value: boxBottom, type: "edge" }]
        : [{ value: movingTop ? boxTop : boxBottom, type: "edge" }];
      const epsilon = 1.5 / viewport.scale;
      const snapX = snapAxis(candidatesX, targetsX, threshold, epsilon);
      const snapY = snapAxis(candidatesY, targetsY, threshold, epsilon);
      if (snapX) {
        if (isDrag) {
          appliedDx += snapX.delta;
          boxLeft += snapX.delta;
          boxRight += snapX.delta;
        } else if (movingLeft) {
          boxLeft = Math.min(boxLeft + snapX.delta, boxRight - MIN_CANVAS_WIDTH);
        } else {
          boxRight = Math.max(boxRight + snapX.delta, boxLeft + MIN_CANVAS_WIDTH);
        }
      }
      if (snapY) {
        if (isDrag) {
          appliedDy += snapY.delta;
          boxTop += snapY.delta;
          boxBottom += snapY.delta;
        } else if (movingTop) {
          boxTop = Math.min(boxTop + snapY.delta, boxBottom - MIN_CANVAS_HEIGHT);
        } else {
          boxBottom = Math.max(boxBottom + snapY.delta, boxTop + MIN_CANVAS_HEIGHT);
        }
      }
      // 吸附线覆盖“被操作素材”和“同线对齐的所有素材”在垂直方向上的重叠范围，两端各延长一点。
      if (snapX) {
        for (const group of snapX.groups) {
          const top = Math.min(boxTop, ...group.targets.map((target) => target.min)) - 8;
          const bottom = Math.max(boxBottom, ...group.targets.map((target) => target.max)) + 8;
          nextGuides.push({ x1: group.pos, y1: top, x2: group.pos, y2: bottom });
        }
      }
      if (snapY) {
        for (const group of snapY.groups) {
          const left = Math.min(boxLeft, ...group.targets.map((target) => target.min)) - 8;
          const right = Math.max(boxRight, ...group.targets.map((target) => target.max)) + 8;
          nextGuides.push({ x1: left, y1: group.pos, x2: right, y2: group.pos });
        }
      }
    }
    setGuides(nextGuides);

    const nextAssets = assetsRef.current.map((asset) => {
      const origin = origins.get(asset.id);
      if (!origin) return asset;
      if (isDrag) return { ...asset, x: origin.x + appliedDx, y: origin.y + appliedDy };
      return { ...asset, x: boxLeft, y: boxTop, canvasWidth: boxRight - boxLeft, canvasHeight: boxBottom - boxTop };
    });
    assetsRef.current = nextAssets;
    setAssets(nextAssets);
  }

  async function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const current = gesture.current;
    gesture.current = null;
    setDraggingId(null);
    setGuides([]);
    setMarquee(null);
    if (!current || current.type === "pan" || current.type === "press" || current.type === "marquee") return;
    const moved = (current.ids ?? []).map((id) => assetsRef.current.find((candidate) => candidate.id === id)).filter((asset): asset is AssetRecord => Boolean(asset));
    try {
      await Promise.all(moved.map((asset) => api.layout(asset.id, { x: asset.x, y: asset.y, width: asset.canvasWidth, height: asset.canvasHeight })));
    } catch (error) {
      onError(error instanceof Error ? error.message : "画布保存失败。 ");
    }
  }

  // 素材上按下：先结算选择（Shift/⌘ 追加或取消），再开始拖动或缩放。
  // 拖动作用于整个选择，缩放只作用于被拖的那一个。
  function beginNode(event: ReactPointerEvent<HTMLDivElement>, asset: AssetRecord, type: "drag" | "resize") {
    if ((event.target as HTMLElement).closest("button, iframe, [role='combobox'], [role='listbox']")) return;
    event.stopPropagation();
    const additive = type === "drag" && (event.shiftKey || event.metaKey || event.ctrlKey);
    let selection: string[];
    if (additive) selection = selectedIds.includes(asset.id) ? selectedIds.filter((id) => id !== asset.id) : [...selectedIds, asset.id];
    else selection = selectedIds.includes(asset.id) ? selectedIds : [asset.id];
    setSelectedIds(selection);
    setAnchorId(selection.includes(asset.id) ? asset.id : (selection[selection.length - 1] ?? null));
    if (!selection.includes(asset.id)) {
      gesture.current = null;
      return;
    }
    if (type === "resize") containerRef.current?.setPointerCapture(event.pointerId);
    const ids = type === "resize" ? [asset.id] : selection;
    const origins = new Map<string, NodeOrigin>();
    for (const id of ids) {
      const target = assetsRef.current.find((candidate) => candidate.id === id);
      if (target) origins.set(id, { x: target.x, y: target.y, width: target.canvasWidth, height: target.canvasHeight });
    }
    const pending: Gesture = {
      type: type === "drag" ? "press" : "resize",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      primaryId: asset.id,
      ids,
      origins,
      corner: type === "resize" ? ((event.currentTarget as HTMLElement).dataset.corner as ResizeCorner | undefined) : undefined,
    };
    gesture.current = pending;
    if (type === "drag") {
      setInteractiveId(null);
      if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
      longPressTimer.current = window.setTimeout(() => {
        if (gesture.current === pending) {
          containerRef.current?.setPointerCapture(pending.pointerId);
          gesture.current = { ...pending, type: "drag" };
          setDraggingId(asset.id);
        }
        longPressTimer.current = null;
      }, 180);
    }
  }

  async function refreshOrExit() {
    try {
      const updated = await api.item(item.id);
      if (updated.state !== "active") {
        onBack(true);
        return;
      }
      onChange(updated);
      assetsRef.current = updated.assets;
      setAssets(updated.assets);
    } catch {
      onBack(true);
    }
    onLibraryChange();
  }

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      clearSelection();
      await refreshOrExit();
      await loadStaged();
    } catch (error) {
      onError(error instanceof Error ? error.message : "操作失败。 ");
    }
  }

  // 选中的素材依次执行同一个动作：多选时一次操作一批，中途失败即停并保留已完成的部分。
  async function actOnSelection(run: (assetId: string) => Promise<unknown>) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    await act(async () => {
      for (const id of ids) await run(id);
    });
  }

  // 导出素材：后端弹原生对话框选地址，把原文件复制一份过去。素材本身不改动，
  // 所以不刷新画布；单个选“存储为”，多选选一个文件夹，取消则静默。
  async function exportSelection() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    try {
      if (ids.length === 1) {
        const result = await api.exportAsset(ids[0]);
        if (result.cancelled) return;
        if (result.path) onSuccess(`已导出到 ${result.path}`);
        return;
      }
      const result = await api.exportAssets(ids);
      if (result.cancelled) return;
      const directory = result.paths?.[0]?.replace(/\/[^/]*$/, "") ?? "";
      if (result.paths?.length) onSuccess(`已导出 ${result.paths.length} 个素材到 ${directory}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "导出失败。 ");
    }
  }

  // 从原图地址读取完整分辨率内容。浏览器能直接写入原格式时保留原文件字节；
  // 剪贴板不支持该格式时（如部分浏览器中的 JPEG/WebP）才转为同分辨率 PNG。
  async function copySelection() {
    if (copyingRef.current) return;
    if (selectedIds.length !== 1) {
      onError("一次只能复制一个图片素材。 ");
      return;
    }
    const asset = assetsRef.current.find((candidate) => candidate.id === selectedIds[0]);
    if (!asset || asset.kind !== "image") {
      onError("当前选中的素材不是图片。 ");
      return;
    }
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      onError("当前浏览器不支持复制图片到剪贴板。 ");
      return;
    }

    copyingRef.current = true;
    try {
      const sourceType = imageClipboardType(asset.name);
      const canWriteOriginal = Boolean(sourceType && (typeof ClipboardItem.supports !== "function"
        ? sourceType === "image/png"
        : ClipboardItem.supports(sourceType)));
      const original = fetch(asset.originalUrl).then(async (response) => {
        if (!response.ok) throw new Error("原图读取失败。 ");
        return response.blob();
      });
      const targetType = canWriteOriginal && sourceType ? sourceType : "image/png";
      const content = canWriteOriginal ? original : original.then(imageAsPng);
      // 立即发起 write，让异步原图读取仍归属于这次 Command+C 用户操作。
      await navigator.clipboard.write([new ClipboardItem({ [targetType]: content })]);
      onSuccess(canWriteOriginal ? "已复制原图" : "已复制原始分辨率图片");
    } catch (error) {
      onError(error instanceof Error ? error.message : "复制图片失败。 ");
    } finally {
      copyingRef.current = false;
    }
  }

  async function applySize(asset: AssetRecord, size: { width: number; height: number }) {
    // 以素材中心为锚点改尺寸，双击的那张不会跑到别处去。
    const x = asset.x + (asset.canvasWidth - size.width) / 2;
    const y = asset.y + (asset.canvasHeight - size.height) / 2;
    const nextAssets = assetsRef.current.map((candidate) => (
      candidate.id === asset.id ? { ...candidate, x, y, canvasWidth: size.width, canvasHeight: size.height } : candidate
    ));
    assetsRef.current = nextAssets;
    setAssets(nextAssets);
    try {
      await api.layout(asset.id, { x, y, width: size.width, height: size.height });
    } catch (error) {
      onError(error instanceof Error ? error.message : "画布保存失败。 ");
    }
  }

  // 双击图片在“原始像素尺寸”和上一次的画布尺寸之间切换；原图长边超过画布上限时等比缩到上限。
  function toggleNaturalSize(asset: AssetRecord) {
    if (asset.kind !== "image" || !asset.width || !asset.height) return;
    const ratio = Math.min(1, MAX_CANVAS_SIZE / Math.max(asset.width, asset.height));
    const natural = { width: Math.max(MIN_CANVAS_WIDTH, asset.width * ratio), height: Math.max(MIN_CANVAS_HEIGHT, asset.height * ratio) };
    const atNatural = Math.abs(asset.canvasWidth - natural.width) < 1 && Math.abs(asset.canvasHeight - natural.height) < 1;
    if (atNatural) {
      const previous = previousSizeRef.current.get(asset.id);
      if (!previous) return;
      previousSizeRef.current.delete(asset.id);
      void applySize(asset, previous);
      return;
    }
    previousSizeRef.current.set(asset.id, { width: asset.canvasWidth, height: asset.canvasHeight });
    void applySize(asset, natural);
  }

  function addTag() {
    const next = tagDraftRef.current.trim();
    if (next && !tagsRef.current.includes(next)) {
      const updated = [...tagsRef.current, next];
      tagsRef.current = updated;
      setTags(updated);
    }
    tagDraftRef.current = "";
    setTagDraft("");
  }

  async function leaveCanvas() {
    addTag();
    try {
      await persistDraft();
      onBack();
    } catch {
      // The error is shown by persistDraft; staying here prevents silent loss.
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const typing = Boolean((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable='true']"));
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        // Escape 先退出当前选择，没有选择时才离开画布。
        if (!typing && selectedIds.length > 0) {
          resetTransientState();
          return;
        }
        void leaveCanvas();
        return;
      }
      if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const all = assetsRef.current.map((asset) => asset.id);
        setSelectedIds(all);
        setAnchorId(all[all.length - 1] ?? null);
        return;
      }
      if (!typing && event.metaKey && event.key.toLowerCase() === "c" && selectedIds.length > 0) {
        event.preventDefault();
        if (!event.repeat) void copySelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function addFiles(files: File[]) {
    if (files.length === 0 || adding) return;
    if (addFeedbackTimer.current !== null) {
      window.clearTimeout(addFeedbackTimer.current);
      addFeedbackTimer.current = null;
    }
    setAdding(true);
    setAddFeedback("正在添加素材…");
    try {
      const updated = await api.upload(files, "", "", [], item.id);
      onChange(updated);
      assetsRef.current = updated.assets;
      setAssets(updated.assets);
      onLibraryChange();
      setAddFeedback(`已添加 ${files.length} 个素材`);
      addFeedbackTimer.current = window.setTimeout(() => {
        setAddFeedback("");
        addFeedbackTimer.current = null;
      }, 2200);
    } catch (error) {
      setAddFeedback("");
      onError(error instanceof Error ? error.message : "添加失败。 ");
    } finally {
      setAdding(false);
    }
  }

  const corners: ResizeCorner[] = ["nw", "ne", "sw", "se"];

  return (
    <main className="canvas-shell">
      <div
        ref={containerRef}
        className="canvas-stage"
        onWheel={onWheel}
        onPointerDown={beginStage}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <div className="canvas-grid" aria-hidden="true" />
        <div
          className="canvas-world"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, "--canvas-scale": viewport.scale } as CSSProperties}
        >
          <svg className="canvas-guides" aria-hidden="true">
            {guides.map((guide, index) => (
              <line key={index} x1={guide.x1} y1={guide.y1} x2={guide.x2} y2={guide.y2} strokeWidth={3 / viewport.scale} />
            ))}
          </svg>
          {assets.map((asset) => (
            <div
              key={asset.id}
              className={`canvas-node ${selectedIds.includes(asset.id) ? "is-selected" : ""} ${draggingId === asset.id ? "is-dragging" : ""}`}
              style={{ left: asset.x, top: asset.y, width: asset.canvasWidth, height: asset.canvasHeight }}
              onPointerDown={(event) => beginNode(event, asset, "drag")}
              onDoubleClick={(event) => {
                event.stopPropagation();
                if (asset.kind === "html") setInteractiveId(asset.id);
                else toggleNaturalSize(asset);
              }}
            >
              {interactiveId === asset.id && asset.htmlUrl ? (
                <>
                  <iframe title={asset.name} src={asset.htmlUrl} sandbox="allow-scripts" />
                  <button className="exit-interaction" onClick={() => setInteractiveId(null)}>退出交互</button>
                </>
              ) : asset.kind === "html" && !asset.hasPreview ? (
                <div className="canvas-html-placeholder"><span>HTML</span><small>{asset.name}</small></div>
              ) : (
                <div className="node-media">
                  <img src={asset.previewUrl} alt={asset.name} draggable={false} />
                  {wantsOriginal(asset, viewport, loadedOriginals.has(asset.id)) && (
                    <img
                      className={`node-original ${loadedOriginals.has(asset.id) ? "is-ready" : ""}`}
                      src={asset.originalUrl}
                      alt=""
                      draggable={false}
                      onLoad={() => setLoadedOriginals((current) => (current.has(asset.id) ? current : new Set(current).add(asset.id)))}
                    />
                  )}
                </div>
              )}
              {asset.kind === "html" && asset.htmlUrl && interactiveId !== asset.id && (
                <a
                  className="html-badge canvas-html-badge"
                  href={asset.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  draggable={false}
                  aria-label={`在新标签页打开${asset.name}`}
                  title="在新标签页打开 HTML"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                ><HtmlIcon /></a>
              )}
              {anchorId === asset.id && selectedIds.includes(asset.id) && (
                <div className="node-actions" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                  {selectedIds.length > 1 && <span className="node-actions-count">{selectedIds.length} 个素材</span>}
                  <button title="移到暂存区" aria-label="移到暂存区" onClick={() => void actOnSelection((id) => api.moveAsset(id, null))}><TrayIcon /></button>
                  {otherItems.length > 0 && (
                    <SelectMenu
                      ariaLabel="移动到其他内容组"
                      placeholder="移动到…"
                      compact
                      expandable
                      collapsedIcon={<MoveIcon />}
                      options={otherItems.map((candidate) => ({ value: candidate.id, label: candidate.title }))}
                      onSelect={(targetItemId) => void actOnSelection((id) => api.moveAsset(id, targetItemId))}
                    />
                  )}
                  <button title="导出素材" aria-label="导出素材" onClick={() => void exportSelection()}><ExportIcon /></button>
                  <ConfirmPopover
                    message={selectedIds.length > 1 ? `将这 ${selectedIds.length} 个素材移到废纸篓？` : "将这个素材移到废纸篓？"}
                    onConfirm={() => void actOnSelection((id) => api.trashAsset(id))}
                    trigger={<button className="danger-icon" title="移到废纸篓" aria-label="移到废纸篓"><TrashIcon /></button>}
                  />
                </div>
              )}
              {selectedIds.length === 1 && selectedIds[0] === asset.id && corners.map((corner) => (
                <div
                  key={corner}
                  className={`resize-handle is-${corner}`}
                  data-corner={corner}
                  onPointerDown={(event) => beginNode(event, asset, "resize")}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              ))}
            </div>
          ))}
        </div>
        {marquee && <div className="canvas-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }} aria-hidden="true" />}
        <div className="canvas-nav">
          <button className="round-button" onClick={() => void leaveCanvas()} aria-label="返回素材墙"><ArrowIcon /></button>
          <button className="round-button" onClick={() => { resetTransientState(); applyView("fit"); }} aria-label="适应全部内容"><FitIcon /></button>
          <span className="zoom-readout">{Math.round((viewport.scale / defaultScaleRef.current) * 100)}%</span>
        </div>
      </div>

      {panelOpen ? (
        <aside className="info-float">
          <div className="info-float-head">
            <span>{saving ? "保存中" : `${assets.length} 个素材`}</span>
            <button className="icon-button" onClick={() => { resetTransientState(true); setPanelOpen(false); }} aria-label="收起内容组信息"><CloseIcon /></button>
          </div>
          <label className="field-label" htmlFor="item-title">标题</label>
          <input id="item-title" value={title} onChange={(event) => { titleRef.current = event.target.value; setTitle(event.target.value); }} placeholder="内容组标题" />
          <label className="field-label" htmlFor="item-note">备注</label>
          <textarea id="item-note" value={note} onChange={(event) => { noteRef.current = event.target.value; setNote(event.target.value); }} placeholder="写下为什么留下它…" />
          <span className="field-label">标签</span>
          <div className="tag-list">
            {tags.map((tag) => <button key={tag} className="tag-chip" onClick={() => { const updated = tagsRef.current.filter((value) => value !== tag); tagsRef.current = updated; setTags(updated); }}>{tag}<CloseIcon /></button>)}
          </div>
          <input
            className="tag-input"
            value={tagDraft}
            onChange={(event) => { tagDraftRef.current = event.target.value; setTagDraft(event.target.value); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }}
            onBlur={addTag}
            placeholder="输入标签，回车添加"
          />
          <div className="material-actions">
          <button className="material-icon-button" disabled={adding} title="添加素材副本" aria-label="添加素材副本" onClick={() => fileInputRef.current?.click()}><AddMaterialIcon /></button>
          <input ref={fileInputRef} className="visually-hidden" tabIndex={-1} type="file" accept="image/*,.html,.htm" multiple onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void addFiles(files); }} />
          <button className={`material-icon-button ${stagedOpen ? "is-active" : ""}`} title="添加暂存区素材" aria-label="添加暂存区素材" onClick={() => setStagedOpen((value) => !value)}><AddStagedIcon /></button>
          <ConfirmPopover message="将整个内容组移到废纸篓？" onConfirm={() => act(() => api.trashItem(item.id))} trigger={<button className="material-icon-button danger-icon" title="将内容组移到废纸篓" aria-label="将内容组移到废纸篓"><TrashIcon /></button>} />
          </div>
          {addFeedback && <div className="material-feedback" role="status">{addFeedback}</div>}
          {stagedOpen && (
            <section className="staged-picker" aria-label="暂存区素材">
              <div className="staged-picker-head"><strong>暂存区素材</strong><span>{staged.length}</span></div>
              {staged.length === 0 ? (
                <div className="staged-picker-empty"><EmptyStagedIcon /><span>暂存区暂无素材</span></div>
              ) : (
                <div className="staged-picker-list">
                  {staged.map((asset) => (
                    <button key={asset.id} className="staged-material" onClick={() => act(() => api.moveAsset(asset.id, item.id))}>
                      <span title={asset.name}>{asset.name}</span>
                      {asset.kind === "html" && !asset.hasPreview ? <span className="staged-html">HTML</span> : <img src={asset.previewUrl} alt="" />}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
        </aside>
      ) : (
        <button className="panel-reopen" onClick={() => setPanelOpen(true)}>内容组信息</button>
      )}
    </main>
  );
}
