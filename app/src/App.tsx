import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "./api";
import CanvasView from "./CanvasView";
import ConfirmPopover from "./ConfirmPopover";
import { CloseIcon, EmptyItemIcon, FrontIcon, HtmlIcon, MoveIcon, PlusIcon, RestoreIcon, SearchIcon, TrashIcon, TrayIcon } from "./Icons";
import SelectMenu from "./SelectMenu";
import type { AssetRecord, ItemRecord, TrashRecord } from "./types";

type Drawer = "staging" | "trash" | null;

// 拖动预览正方形的边长，和 CSS --drag-tile-size 保持一致（响应式 clamp）。
function dragTileSize(): number {
  const vw = window.innerWidth;
  return Math.max(168, Math.min(232, vw * 0.16));
}
interface GroupPress {
  sourceId: string;
  startX: number;
  startY: number;
  timer: number | null;
  active: boolean;
  original: ItemRecord[];
  latestIds: string[];
  originTop: number;
  originLeft: number;
  masonryTop: number;
  masonryLeft: number;
  tile: number;
}

export default function App() {
  const [items, setItems] = useState<ItemRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ItemRecord | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ text: string; kind: "error" | "success" } | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<{ id: string; top: number; left: number } | null>(null);
  const groupPressRef = useRef<GroupPress | null>(null);
  const suppressGestureClickRef = useRef(false);
  const suppressGestureFrameRef = useRef<number | null>(null);
  const libraryScrollRef = useRef(0);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const previousCardRectsRef = useRef(new Map<string, DOMRect>());
  const cardAnimationsRef = useRef(new Map<string, Animation>());
  const loadGenerationRef = useRef(0);
  const errorTimerRef = useRef<number | null>(null);
  const itemOrderKey = items.map((item) => item.id).join("\0");

  const cancelCardAnimations = useCallback(() => {
    cardAnimationsRef.current.forEach((animation) => animation.cancel());
    cardAnimationsRef.current.clear();
  }, []);

  const refreshCardRectBaseline = useCallback(() => {
    cancelCardAnimations();
    const nextRects = new Map<string, DOMRect>();
    cardElementsRef.current.forEach((element, id) => nextRects.set(id, element.getBoundingClientRect()));
    previousCardRectsRef.current = nextRects;
  }, [cancelCardAnimations]);

  const load = useCallback(async (search = query, minimumMs = 0) => {
    const generation = ++loadGenerationRef.current;
    const startedAt = Date.now();
    try {
      const next = await api.items(search);
      if (generation === loadGenerationRef.current) setItems(next);
    } catch (reason) {
      if (generation === loadGenerationRef.current) showError(reason instanceof Error ? reason.message : "无法读取内容库。 ");
    } finally {
      const remaining = minimumMs - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => load(query), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (importOpen) setImportOpen(false);
        else if (drawer) setDrawer(null);
      }
      if (event.key === "/" && !selected && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#library-search")?.focus();
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [drawer, importOpen, selected]);

  useEffect(() => {
    if (!drawer) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".library-drawer, .top-actions, [data-radix-popper-content-wrapper], .confirm-popover")) return;
      // An open Radix layer disables pointer events outside it, so its dismiss click arrives
      // targeted at <html>. Let the layer close first; the next outside click closes the drawer.
      if (document.querySelector("[data-radix-popper-content-wrapper]")) return;
      setDrawer(null);
    };
    // Observe the original target before Radix replaces the collapsed trigger icon on pointerdown.
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [drawer]);

  useEffect(() => {
    const consumeGestureClick = (event: MouseEvent) => {
      if (!suppressGestureClickRef.current) return;
      suppressGestureClickRef.current = false;
      if (suppressGestureFrameRef.current !== null) window.cancelAnimationFrame(suppressGestureFrameRef.current);
      suppressGestureFrameRef.current = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", consumeGestureClick, true);
    return () => document.removeEventListener("click", consumeGestureClick, true);
  }, []);

  useLayoutEffect(() => {
    cancelCardAnimations();
    const nextRects = new Map<string, DOMRect>();
    cardElementsRef.current.forEach((element, id) => {
      const next = element.getBoundingClientRect();
      nextRects.set(id, next);
      const previous = previousCardRectsRef.current.get(id);
      if (!previous || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      // The dragged card follows the pointer directly; only the cards it passes animate aside.
      if (groupPressRef.current?.active && groupPressRef.current.sourceId === id) return;
      const x = previous.left - next.left;
      const y = previous.top - next.top;
      if (Math.abs(x) < 1 && Math.abs(y) < 1) return;
      const isReordering = groupPressRef.current?.active === true;
      const animation = element.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
        isReordering
          ? { duration: 90, easing: "ease-out" }
          : { duration: 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
      );
      cardAnimationsRef.current.set(id, animation);
      const forget = () => {
        if (cardAnimationsRef.current.get(id) === animation) cardAnimationsRef.current.delete(id);
      };
      animation.onfinish = forget;
      animation.oncancel = forget;
    });
    previousCardRectsRef.current = nextRects;
  }, [cancelCardAnimations, draggedItemId, itemOrderKey]);

  useLayoutEffect(() => {
    if (selected || loading || pendingScrollRestoreRef.current === null) return;
    const scrollTop = pendingScrollRestoreRef.current;
    pendingScrollRestoreRef.current = null;
    window.requestAnimationFrame(() => window.scrollTo(0, scrollTop));
  }, [loading, selected]);

  const showToast = useCallback((text: string, kind: "error" | "success") => {
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    setToast({ text, kind });
    errorTimerRef.current = window.setTimeout(() => {
      setToast(null);
      errorTimerRef.current = null;
    }, 4200);
  }, []);
  const showError = useCallback((message: string) => showToast(message, "error"), [showToast]);
  const showSuccess = useCallback((message: string) => showToast(message, "success"), [showToast]);

  async function frontItem(itemId: string) {
    const previous = items;
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) return;
    cancelCardAnimations();
    setItems([item, ...items.filter((candidate) => candidate.id !== itemId)]);
    try {
      const ordered = await api.frontItem(itemId);
      if (query) void load(query);
      else setItems(ordered);
    } catch (reason) {
      setItems(previous);
      showError(reason instanceof Error ? reason.message : "置顶失败。 ");
    }
  }

  const finishGroupPress = useCallback((outcome: "commit" | "cancel") => {
    const press = groupPressRef.current;
    if (!press) return;
    if (press.timer !== null) window.clearTimeout(press.timer);
    groupPressRef.current = null;
    document.body.classList.remove("is-reordering-groups");
    setDraggedItemId(null);
    setDragPosition(null);
    if (!press.active) return;
    if (outcome === "cancel") {
      suppressGestureClickRef.current = false;
      cancelCardAnimations();
      setItems(press.original);
      return;
    }
    suppressGestureClickRef.current = true;
    if (suppressGestureFrameRef.current !== null) window.cancelAnimationFrame(suppressGestureFrameRef.current);
    suppressGestureFrameRef.current = window.requestAnimationFrame(() => {
      suppressGestureClickRef.current = false;
      suppressGestureFrameRef.current = null;
    });
    // 乐观更新：立刻按拖动期间算出的顺序渲染，避免松手后先“弹回原位”再飞向新位置。
    const optimistic = press.latestIds
      .map((id) => press.original.find((item) => item.id === id))
      .filter((item): item is ItemRecord => Boolean(item));
    setItems(optimistic);
    void api.reorderItems(press.latestIds).then((ordered) => setItems(ordered)).catch((reason) => {
      cancelCardAnimations();
      setItems(press.original);
      showError(reason instanceof Error ? reason.message : "排序失败。 ");
    });
  }, [cancelCardAnimations, showError]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const press = groupPressRef.current;
      if (!press) return;
      // 长按激活前不拦截移动：真人按住时手会抖、也可能提前拖动，超过阈值就取消会让拖动永远启动不了。
      if (!press.active) return;
      event.preventDefault();
      setDragPosition({
        id: press.sourceId,
        top: event.clientY - press.masonryTop - press.tile / 2,
        left: event.clientX - press.masonryLeft - press.tile / 2,
      });
      setItems((current) => {
        // 以卡片的几何中心比较位置（统一用 masonry 坐标）：
        // 被拖动卡片的中心就是当前光标，所以光标在哪，正方形就被“塞”进哪个槽位，
        // 自然能放到第一行之上和两侧空白处。
        const draggedCx = event.clientX - press.masonryLeft;
        const draggedCy = event.clientY - press.masonryTop;
        const next = current.map((item) => {
          const element = cardElementsRef.current.get(item.id);
          if (item.id === press.sourceId) {
            return { item, cx: draggedCx, cy: draggedCy };
          }
          const cx = (element?.offsetLeft ?? 0) + (element?.offsetWidth ?? 0) / 2;
          const cy = (element?.offsetTop ?? 0) + (element?.offsetHeight ?? 0) / 2;
          return { item, cx, cy };
        }).sort((a, b) => {
          const cyDelta = Math.round(a.cy) - Math.round(b.cy);
          return cyDelta || Math.round(a.cx) - Math.round(b.cx);
        }).map(({ item }) => item);
        const nextIds = next.map((item) => item.id);
        if (nextIds.every((id, index) => id === current[index]?.id)) return current;
        cancelCardAnimations();
        press.latestIds = nextIds;
        return next;
      });
    };
    const up = () => finishGroupPress("commit");
    const cancel = () => finishGroupPress("cancel");
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [cancelCardAnimations, finishGroupPress]);

  function beginGroupPress(event: ReactPointerEvent<HTMLElement>, itemId: string) {
    if (query || event.button !== 0 || (event.target as HTMLElement).closest(".card-order-actions")) return;
    const masonryEl = document.querySelector<HTMLElement>(".masonry");
    const masonryRect = masonryEl?.getBoundingClientRect();
    const press: GroupPress = {
      sourceId: itemId,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      active: false,
      original: items,
      latestIds: items.map((item) => item.id),
      originTop: event.currentTarget.offsetTop,
      originLeft: event.currentTarget.offsetLeft,
      masonryTop: masonryRect?.top ?? 0,
      masonryLeft: masonryRect?.left ?? 0,
      tile: dragTileSize(),
    };
    press.timer = window.setTimeout(() => {
      if (groupPressRef.current !== press) return;
      press.active = true;
      press.timer = null;
      // 变形为以光标为中心的正方形预览（masonry 坐标系）。
      const top = press.startY - press.masonryTop - press.tile / 2;
      const left = press.startX - press.masonryLeft - press.tile / 2;
      setDraggedItemId(itemId);
      setDragPosition({ id: itemId, top, left });
      document.body.classList.add("is-reordering-groups");
    }, 320);
    groupPressRef.current = press;
  }

  function openItem(item: ItemRecord) {
    enterDetail(item);
  }

  function enterDetail(item: ItemRecord) {
    libraryScrollRef.current = window.scrollY;
    setSelected(item);
  }

  function toggleDrawer(kind: Exclude<Drawer, null>) {
    if (drawer !== kind) libraryScrollRef.current = window.scrollY;
    setDrawer(drawer === kind ? null : kind);
  }

  useEffect(() => () => {
    finishGroupPress("cancel");
    cancelCardAnimations();
    loadGenerationRef.current += 1;
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    if (suppressGestureFrameRef.current !== null) window.cancelAnimationFrame(suppressGestureFrameRef.current);
  }, [cancelCardAnimations, finishGroupPress]);

  if (selected) {
    return (
      <>
        <CanvasView
          item={selected}
          allItems={items}
          onBack={(withTransition = false) => { pendingScrollRestoreRef.current = libraryScrollRef.current; setLoading(true); setSelected(null); void load(query, withTransition ? 240 : 0); }}
          onChange={setSelected}
          onLibraryChange={() => load()}
          onError={showError}
          onSuccess={showSuccess}
        />
        {toast && <div className={`toast ${toast.kind === "success" ? "is-success" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>{toast.text}</div>}
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Taste 首页"><img src="/taste-mark.svg?v=2" alt="" /></a>
        <div className="search-wrap">
          <SearchIcon />
          <input id="library-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索备注或标签" autoComplete="off" />
          {query && <button className="clear-search" onClick={() => setQuery("")} aria-label="清空搜索"><CloseIcon /></button>}
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => setImportOpen(true)} aria-label="新建内容组"><PlusIcon /></button>
          <button className={`icon-button ${drawer === "staging" ? "is-active" : ""}`} onClick={() => toggleDrawer("staging")} aria-label="暂存区"><TrayIcon /></button>
          <button className={`icon-button danger-icon ${drawer === "trash" ? "is-active" : ""}`} onClick={() => toggleDrawer("trash")} aria-label="废纸篓"><TrashIcon /></button>
        </div>
      </header>

      <main className="library-main">
        {loading ? (
          <LibrarySkeleton />
        ) : items.length === 0 ? (
          <div className="quiet-state">
            <span>{query ? "没有匹配的内容" : "内容库还是空的"}</span>
            {!query && <button onClick={() => setImportOpen(true)}>新建第一个内容组</button>}
          </div>
        ) : (
          <MasonryWall
            items={items}
            draggedItemId={draggedItemId}
            dragPosition={dragPosition}
            onOpen={openItem}
            onFront={frontItem}
            onPress={beginGroupPress}
            onLayoutSettled={refreshCardRectBaseline}
            register={(itemId, element) => { if (element) cardElementsRef.current.set(itemId, element); else cardElementsRef.current.delete(itemId); }}
          />
        )}
      </main>

      {drawer && <LibraryDrawer kind={drawer} items={items} onClose={() => setDrawer(null)} onChanged={() => load()} onOpen={setSelected} onError={showError} />}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={(item) => { setImportOpen(false); load(); enterDetail(item); }} onError={showError} />}
      {toast && <div className={`toast ${toast.kind === "success" ? "is-success" : ""}`} role={toast.kind === "error" ? "alert" : "status"}>{toast.text}</div>}
    </div>
  );
}

function LibrarySkeleton() {
  return (
    <div className="masonry skeleton-wall" aria-label="正在整理内容墙" aria-busy="true">
      {[248, 340, 220, 304, 264, 376, 232, 320, 280, 356, 244, 296, 332, 224, 368].map((height, index) => (
        <span key={`${height}-${index}`} className="skeleton-card" style={{ height }} />
      ))}
    </div>
  );
}

function MasonryWall({ items, draggedItemId, dragPosition, onOpen, onFront, onPress, onLayoutSettled, register }: {
  items: ItemRecord[];
  draggedItemId: string | null;
  dragPosition: { id: string; top: number; left: number } | null;
  onOpen: (item: ItemRecord) => void;
  onFront: (itemId: string) => void;
  onPress: (event: ReactPointerEvent<HTMLElement>, itemId: string) => void;
  onLayoutSettled: () => void;
  register: (itemId: string, element: HTMLElement | null) => void;
}) {
  const wallRef = useRef<HTMLDivElement>(null);
  const [wallWidth, setWallWidth] = useState(0);

  useLayoutEffect(() => {
    const wall = wallRef.current;
    if (!wall) return;
    const update = () => setWallWidth(wall.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wall);
    return () => observer.disconnect();
  }, []);

  const { height, placements } = useMemo(() => {
    if (!wallWidth) return { height: 0, placements: new Map<string, CSSProperties>() };
    const compact = wallWidth <= 756;
    const gap = compact ? 8 : 16;
    const minimumWidth = compact ? 140 : 232;
    const maximumColumns = compact ? 2 : 5;
    const columnCount = Math.max(1, Math.min(maximumColumns, Math.floor((wallWidth + gap) / (minimumWidth + gap))));
    const columnWidth = (wallWidth - gap * (columnCount - 1)) / columnCount;
    const bottoms = Array.from({ length: columnCount }, () => 0);
    const nextPlacements = new Map<string, CSSProperties>();

    for (const item of items) {
      const column = bottoms.reduce((best, value, index) => value < bottoms[best] ? index : best, 0);
      const cover = item.assets[0];
      const naturalWidth = cover?.width ?? cover?.canvasWidth ?? 0;
      const naturalHeight = cover?.height ?? cover?.canvasHeight ?? 0;
      const cardHeight = cover && naturalWidth > 0 && naturalHeight > 0
        ? Math.round(columnWidth * naturalHeight / naturalWidth)
        : 208;
      nextPlacements.set(item.id, {
        width: columnWidth,
        height: cardHeight,
        left: column * (columnWidth + gap),
        top: bottoms[column],
      });
      bottoms[column] += cardHeight + gap;
    }

    return { height: Math.max(0, ...bottoms) - gap, placements: nextPlacements };
  }, [items, wallWidth]);

  useLayoutEffect(() => {
    if (wallWidth) onLayoutSettled();
  }, [onLayoutSettled, wallWidth]);

  return (
    <div ref={wallRef} className="masonry" style={{ height }} aria-label="内容库">
      {items.map((item) => (
        <LibraryCard
          key={item.id}
          item={item}
          style={placements.get(item.id)}
          isDragging={draggedItemId === item.id}
          dragPosition={draggedItemId === item.id ? dragPosition : null}
          onOpen={() => onOpen(item)}
          onFront={() => onFront(item.id)}
          onPress={(event) => onPress(event, item.id)}
          register={(element) => register(item.id, element)}
        />
      ))}
    </div>
  );
}

function LibraryCard({ item, style, isDragging, dragPosition, onOpen, onFront, onPress, register }: {
  item: ItemRecord;
  style?: CSSProperties;
  isDragging: boolean;
  dragPosition: { id: string; top: number; left: number } | null;
  onOpen: () => void;
  onFront: () => void;
  onPress: (event: ReactPointerEvent<HTMLElement>) => void;
  register: (element: HTMLElement | null) => void;
}) {
  const cover = item.assets[0];
  const [suppressHover, setSuppressHover] = useState(false);
  const cardStyle = isDragging && dragPosition
    ? { top: dragPosition.top, left: dragPosition.left }
    : style;
  return (
    <article ref={register} style={cardStyle} data-library-item-id={item.id} className={`library-card ${cover ? "" : "is-empty"} ${isDragging ? "is-dragging" : ""} ${suppressHover ? "suppress-hover" : ""}`} onPointerDown={onPress} onPointerLeave={() => setSuppressHover(false)} onDragStart={(event) => event.preventDefault()}>
      <button className="library-card-open" onClick={onOpen} aria-label={item.title}>
        {!cover ? (
          <span className="empty-card"><PlusIcon /><span>{item.title}</span></span>
        ) : cover.kind === "html" && !cover.hasPreview
          ? <span className="html-placeholder">HTML</span>
          : <img src={cover.previewUrl} alt="" loading="lazy" draggable={false} />}
      </button>
      <span className="card-order-actions">
        <button onClick={(event) => { event.currentTarget.blur(); setSuppressHover(true); onFront(); }} aria-label={`将${item.title}移到最前`} title="移到最前"><FrontIcon /></button>
      </span>
      {cover?.kind === "html" && cover.htmlUrl && (
        <a
          className="html-badge"
          href={cover.htmlUrl}
          target="_blank"
          rel="noreferrer"
          draggable={false}
          aria-label={`在新标签页打开${item.title}的 HTML 素材`}
          title="在新标签页打开 HTML"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        ><HtmlIcon /></a>
      )}
      {(item.tags.length > 0 || item.note) && (
        <span className="card-caption">
          {item.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
        </span>
      )}
    </article>
  );
}

function ImportDialog({ onClose, onImported, onError }: { onClose: () => void; onImported: (item: ItemRecord) => void; onError: (message: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const parsedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      const item = files.length > 0 ? await api.upload(files, title, note, parsedTags) : await api.createItem(title, note, parsedTags);
      onImported(item);
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传失败。 ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <div className="dialog-head"><h2 id="import-title">新建内容组</h2><button className="icon-button" onClick={onClose} aria-label="关闭新建内容组"><CloseIcon /></button></div>
        <label className="drop-area">
          <PlusIcon />
          <strong>{files.length ? `${files.length} 个素材` : "添加图片或单体 HTML（可选）"}</strong>
          <span>可以先建立内容组，素材稍后再加</span>
          <input type="file" accept="image/*,.html,.htm" multiple onChange={(event) => setFiles([...(event.target.files ?? [])])} />
        </label>
        <label className="field-label" htmlFor="import-group-title">标题</label>
        <input id="import-group-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="未填写时使用首个素材名称" />
        <label className="field-label" htmlFor="import-note">备注</label>
        <textarea id="import-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="可稍后补充" />
        <label className="field-label" htmlFor="import-tags">标签</label>
        <input id="import-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="多个标签用逗号分隔" />
        <button className="primary-button" disabled={busy} onClick={submit}>{busy ? "正在创建…" : "创建内容组"}</button>
      </section>
    </div>
  );
}

function LibraryDrawer({ kind, items, onClose, onChanged, onOpen, onError }: {
  kind: Exclude<Drawer, null>;
  items: ItemRecord[];
  onClose: () => void;
  onChanged: () => void;
  onOpen: (item: ItemRecord) => void;
  onError: (message: string) => void;
}) {
  const [staged, setStaged] = useState<AssetRecord[]>([]);
  const [trash, setTrash] = useState<TrashRecord>({ items: [], assets: [] });
  const [busy, setBusy] = useState(false);

  const loadDrawer = useCallback(async () => {
    try {
      if (kind === "staging") setStaged(await api.staged());
      else setTrash(await api.trash());
    } catch (error) {
      onError(error instanceof Error ? error.message : "抽屉读取失败。 ");
    }
  }, [kind, onError]);

  useEffect(() => { loadDrawer(); }, [loadDrawer]);
  const trashCount = useMemo(() => trash.assets.length + trash.items.reduce((sum, item) => sum + item.assets.length, 0), [trash]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await loadDrawer();
      onChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : "操作失败。 ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="library-drawer" aria-label={kind === "staging" ? "暂存区" : "废纸篓"}>
      <div className="drawer-head">
        <div><h2>{kind === "staging" ? "暂存区" : "废纸篓"}</h2><span>{kind === "staging" ? `${staged.length} 个待整理素材` : `${trashCount} 个素材`}</span></div>
        <button className="icon-button" onClick={onClose} aria-label={`关闭${kind === "staging" ? "暂存区" : "废纸篓"}`}><CloseIcon /></button>
      </div>
      {kind === "staging" ? (
        <div className="drawer-list">
          {staged.length === 0 && <div className="drawer-empty">没有暂存素材</div>}
          {staged.map((asset) => (
            <div className="drawer-row is-staged" key={asset.id}>
              {asset.kind === "html" && !asset.hasPreview ? <span className="drawer-placeholder">HTML</span> : <img src={asset.previewUrl} alt="" />}
              <div><span>{asset.name}</span></div>
              <div className="drawer-row-actions">
                <button disabled={busy} onClick={() => act(() => api.createFromStaged([asset.id]))} title="建立内容组" aria-label="建立内容组"><EmptyItemIcon /></button>
                {items.length > 0 && <SelectMenu ariaLabel="加入内容组" placeholder="加入内容组…" compact expandable collapsedIcon={<MoveIcon />} options={items.map((item) => ({ value: item.id, label: item.title }))} onSelect={(itemId) => act(() => api.moveAsset(asset.id, itemId))} />}
                <ConfirmPopover message="将这个暂存素材移到废纸篓？" onConfirm={() => act(() => api.trashAsset(asset.id))} trigger={<button className="danger-icon" disabled={busy} title="移到废纸篓" aria-label="将暂存素材移到废纸篓"><TrashIcon /></button>} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="drawer-list">
            {trash.items.length === 0 && trash.assets.length === 0 && <div className="drawer-empty">废纸篓是空的</div>}
            {trash.items.map((item) => {
              const cover = item.assets.find((asset) => asset.id === item.coverAssetId) ?? item.assets[0];
              return <div className="drawer-row" key={item.id}>{cover && (cover.kind === "html" && !cover.hasPreview ? <span className="drawer-placeholder">HTML</span> : <img src={cover.previewUrl} alt="" />)}<div><span>{item.title}</span><button disabled={busy} onClick={() => act(async () => { const restored = await api.restoreItem(item.id); onOpen(restored); })}><RestoreIcon />恢复</button></div></div>;
            })}
            {trash.assets.map((asset) => <div className="drawer-row" key={asset.id}>{asset.kind === "html" && !asset.hasPreview ? <span className="drawer-placeholder">HTML</span> : <img src={asset.previewUrl} alt="" />}<div><span>{asset.name}</span><button disabled={busy} onClick={() => act(() => api.restoreAsset(asset.id))}><RestoreIcon />恢复</button></div></div>)}
          </div>
          {(trashCount > 0 || trash.items.length > 0) && <ConfirmPopover message={`将永久删除 ${trashCount} 个素材和 ${trash.items.length} 个内容组。Taste 无法恢复。`} confirmLabel="永久清空" onConfirm={() => act(() => api.emptyTrash())} trigger={<button className="empty-trash" disabled={busy}>永久清空废纸篓</button>} />}
        </>
      )}
    </aside>
  );
}
