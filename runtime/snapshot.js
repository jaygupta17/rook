import { egoError } from "./errors.js";

/**
 * Snapshot v1: Accessibility tree -> indented text tree + refs.
 *
 * Grammar (snapshot-result.test.mjs:9-90):
 *   root
 *     role "name" [ref=N, loc=css:...]
 *       text "..."
 *   iframe [ref=N]
 *     root
 *       button "Frame action" [ref=M]
 * 2 spaces per level, names JSON-quoted, metadata only in a `[ref=...]` block.
 *
 * Every ref carries a real `backendNodeId` and, for nodes that live in a child
 * frame, the real `frameId` of the frame that owns the node:
 * page-model.ts:1738-1750 looks the frame up in Page.getFrameTree and throws
 * "Page changed during snapshot" when a ref has no known frame, so a ref
 * without a frame id inside a frame is worse than no ref at all.
 *
 * Frames come in two flavours:
 *  - same-process frames are reachable from the page session with
 *    `Accessibility.getFullAXTree({frameId})`; their DOMSnapshot documents
 *    arrive in the page session's captureSnapshot;
 *  - OOPIFs are separate targets, so they need their own `Target.attachToTarget`
 *    session, and their own Accessibility/DOMSnapshot reads.
 * A frame's owner element is resolved with `DOM.getFrameOwner` in the session
 * that owns the parent document, because backend node ids are session-local.
 */

const INTERACTIVE_ROLES = new Set([
  "alertdialog",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "grid",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "tree",
  "treeitem",
  "iframe",
]);

const SKIPPED_ROLES = new Set(["inlinetextbox"]);

/** connection -> (OOPIF targetId -> Promise<sessionId>) */
const OOPIF_SESSIONS = new WeakMap();

export async function captureSnapshot({ connection, targetId, attach, options = {} }) {
  if (typeof targetId !== "string" || targetId === "") {
    throw egoError("No active tab to snapshot", "EGO_WEB_CONTENTS_UNAVAILABLE");
  }
  const pageSessionId = await attach(targetId);
  const graph = await discoverFrames({ connection, targetId, pageSessionId, attach });

  const metricsResult = await connection
    .request(
      "Runtime.evaluate",
      {
        expression: "({w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY})",
        returnByValue: true,
      },
      pageSessionId,
    )
    .catch(() => null);

  const scope = normalizeScope(options.scope);
  const state = {
    connection,
    attach,
    mainFrameId: graph.mainFrameId,
    frames: graph.frames,
    order: graph.order,
    children: graph.children,
    refs: [],
    refsByNode: new Map(),
    nextRefId: 1,
    viewportScope: scope === "only_within_viewport",
    topViewport: normalizeViewport(metricsResult?.result?.value),
    /** frameId -> Promise<{nodes, byNodeId, rootNode, ownerByBackend} | null> */
    loaded: new Map(),
    /** sessionId -> Promise<{byFrame: Map<frameId, docIndex>}> */
    dom: new Map(),
    /** frameId -> Promise<context> */
    contexts: new Map(),
    /** frameId -> Promise<viewport | undefined> */
    viewports: new Map(),
  };

  const lines = ["root"];
  let renderedSubtree = false;
  if (scope === "subtree" && Number.isSafeInteger(options.root)) {
    const found = await findSubtreeRoot(options.root, state);
    if (found) {
      lines.push(...(await renderNode(found.node, 1, undefined, found.context, true)));
      renderedSubtree = true;
    }
  }

  if (!renderedSubtree) {
    const mainFrame = graph.frames.get(graph.mainFrameId);
    const mainContext = await frameContext(mainFrame, state);
    if (!mainContext.entry || mainContext.entry.nodes.length === 0) {
      throw egoError("The page returned an empty accessibility tree", "EGO_SNAPSHOT_FAILED");
    }
    lines.push(
      ...(await renderChildren(mainContext.entry.rootNode, 1, undefined, mainContext)),
    );
  }

  if (process.env.ROOK_DEBUG === "1") {
    let nodes = 0;
    for (const frameId of state.order) {
      const loaded = await state.loaded.get(frameId)?.catch(() => null);
      nodes += loaded?.nodes.length ?? 0;
    }
    process.stderr.write(
      `[rook] snapshot: ${nodes} AX nodes across ${state.order.length} frames, ${state.refs.length} refs\n`,
    );
  }

  let content = lines.join("\n");
  const maxResultLength = options.maxResultLength;
  if (Number.isFinite(maxResultLength) && maxResultLength > 0) {
    content = content.slice(0, maxResultLength);
  }
  return { content, refs: state.refs };
}

// --- frame graph ---------------------------------------------------------

/**
 * Build the frame graph for one Page: the page session's frame tree, plus every
 * OOPIF target that descends from it and the same-process frames inside those
 * OOPIFs. Frames are keyed by the real Page frame id so refs can name them.
 */
async function discoverFrames({ connection, targetId, pageSessionId, attach }) {
  const treeResult = await connection
    .request("Page.getFrameTree", {}, pageSessionId)
    .catch(() => null);
  const mainTree = treeResult?.frameTree;
  const mainFrameId = mainTree?.frame?.id;
  if (typeof mainFrameId !== "string" || mainFrameId === "") {
    throw egoError("Could not read the page frame tree", "EGO_SNAPSHOT_FAILED");
  }

  const frames = new Map();
  const order = [];
  registerFrameTree(frames, order, mainTree, pageSessionId, { root: true });

  // Backend-scoped target list: `Target.getTargets` is process-wide, so each
  // backend narrows it to this space before it gets here (see backends/index.js).
  const targetInfos = (await connection.targets().catch(() => [])) ?? [];
  const pageContextId =
    targetInfos.find((info) => info?.targetId === targetId)?.browserContextId ?? null;
  const oopifInfos = targetInfos.filter(
    (info) =>
      info?.type === "iframe" &&
      typeof info.targetId === "string" &&
      (pageContextId === null || (info.browserContextId ?? null) === pageContextId),
  );

  // An iframe target reports its parent as a frame id, which may itself live
  // in an OOPIF we have not attached yet, so keep sweeping until stable.
  const attachedTargets = new Set();
  let progress = oopifInfos.length > 0;
  while (progress) {
    progress = false;
    for (const info of oopifInfos) {
      if (attachedTargets.has(info.targetId)) continue;
      const parentFrameId =
        typeof info.parentId === "string" ? info.parentId : info.parentFrameId;
      if (typeof parentFrameId !== "string" || !frames.has(parentFrameId)) continue;
      attachedTargets.add(info.targetId);
      progress = true;
      let sessionId;
      try {
        sessionId = await cachedOopifSession(connection, info.targetId, attach);
      } catch {
        continue;
      }
      const tree = await connection
        .request("Page.getFrameTree", {}, sessionId)
        .catch(() => null);
      const rootTree = tree?.frameTree;
      if (typeof rootTree?.frame?.id !== "string" || rootTree.frame.id === "") continue;
      registerFrameTree(frames, order, rootTree, sessionId, {
        root: !frames.has(rootTree.frame.id),
        targetId: info.targetId,
      });
    }
  }

  const children = new Map();
  for (const frameId of order) {
    const frame = frames.get(frameId);
    const parentFrameId = frame?.parentFrameId;
    if (typeof parentFrameId !== "string" || !frames.has(parentFrameId)) continue;
    const siblings = children.get(parentFrameId);
    if (siblings) siblings.push(frame);
    else children.set(parentFrameId, [frame]);
  }

  return { mainFrameId, frames, order, children };
}

function registerFrameTree(frames, order, node, sessionId, { root = false, targetId } = {}) {
  const frame = node?.frame;
  if (typeof frame?.id !== "string" || frame.id === "") return;
  if (!frames.has(frame.id)) {
    frames.set(frame.id, {
      frameId: frame.id,
      parentFrameId: typeof frame.parentId === "string" ? frame.parentId : undefined,
      sessionId,
      rootOfSession: root,
      oopifTargetId: targetId,
    });
    order.push(frame.id);
  }
  for (const child of node.childFrames ?? []) {
    registerFrameTree(frames, order, child, sessionId, {});
  }
}

function cachedOopifSession(connection, targetId, attach) {
  let sessions = OOPIF_SESSIONS.get(connection);
  if (!sessions) {
    sessions = new Map();
    OOPIF_SESSIONS.set(connection, sessions);
  }
  const existing = sessions.get(targetId);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(() => attach(targetId))
    .then((sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error("Target.attachToTarget returned no sessionId");
      }
      return sessionId;
    });
  pending.catch(() => {
    if (sessions.get(targetId) === pending) sessions.delete(targetId);
  });
  sessions.set(targetId, pending);
  return pending;
}

// --- per-frame reads -----------------------------------------------------

/**
 * Read one frame's AX tree, its owner links to child frames and (when scope
 * filters by viewport) the frame's own viewport.
 */
async function frameContext(frame, state) {
  const cached = state.contexts.get(frame.frameId);
  if (cached) return cached;
  const pending = (async () => {
    const [entry, dom, viewport] = await Promise.all([
      loadFrame(frame, state),
      loadSessionDom(frame.sessionId, state),
      state.viewportScope ? loadFrameViewport(frame, state) : Promise.resolve(undefined),
    ]);
    return {
      frame,
      entry,
      box: dom.byFrame.get(frame.frameId),
      viewport,
      state,
    };
  })();
  state.contexts.set(frame.frameId, pending);
  return pending;
}

async function loadFrame(frame, state) {
  const cached = state.loaded.get(frame.frameId);
  if (cached) return cached;
  const pending = (async () => {
    let result = null;
    try {
      result = await requestInFrame(state, frame, "Accessibility.getFullAXTree", {
        frameId: frame.frameId,
      });
    } catch (error) {
      // An OOPIF root answers to the bare call; a stale same-process frame id
      // is not worth failing the whole snapshot over.
      if (!frame.rootOfSession) return null;
      result = await requestInFrame(state, frame, "Accessibility.getFullAXTree", {}).catch(
        () => null,
      );
    }
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    if (nodes.length === 0) return null;

    const byNodeId = new Map();
    for (const node of nodes) byNodeId.set(node.nodeId, node);
    let rootNode = byNodeId.get(nodes[0].nodeId);
    for (const node of nodes) {
      if (roleOf(node) === "rootwebarea") {
        rootNode = node;
        break;
      }
    }

    const ownerByBackend = new Map();
    for (const child of state.children.get(frame.frameId) ?? []) {
      const owner = await requestInFrame(state, frame, "DOM.getFrameOwner", {
        frameId: child.frameId,
      }).catch(() => null);
      if (Number.isInteger(owner?.backendNodeId) && owner.backendNodeId > 0) {
        ownerByBackend.set(owner.backendNodeId, child);
      }
    }
    return { frame, nodes, byNodeId, rootNode, ownerByBackend };
  })();
  state.loaded.set(frame.frameId, pending);
  return pending;
}

async function requestInFrame(state, frame, method, params = {}) {
  try {
    return await state.connection.request(method, params, frame.sessionId);
  } catch (error) {
    const oopifTargetId = frame.oopifTargetId;
    if (!oopifTargetId || !isMissingSessionError(error)) throw error;
    const sessions = OOPIF_SESSIONS.get(state.connection);
    sessions?.delete(oopifTargetId);
    const sessionId = await cachedOopifSession(state.connection, oopifTargetId, state.attach);
    frame.sessionId = sessionId;
    return state.connection.request(method, params, sessionId);
  }
}

function isMissingSessionError(error) {
  const message = String(error?.message ?? "");
  return /session (?:with (?:the )?given id|not found)|no session with given id/i.test(message);
}

/**
 * Bounds and locator metadata for every node of one renderer, keyed by backend
 * node id. A session's captureSnapshot returns one document per same-process
 * frame, so each frame only indexes its own document - ids are session-local
 * and a locator must be unique within the document that prints it.
 */
async function loadSessionDom(sessionId, state) {
  const cached = state.dom.get(sessionId);
  if (cached) return cached;
  const pending = (async () => {
    const snapshot = await state.connection
      .request(
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includePaintOrder: false, includeDOMRects: false },
        sessionId,
      )
      .catch(() => null);
    const byFrame = new Map();
    if (snapshot && Array.isArray(snapshot.documents)) {
      const strings = Array.isArray(snapshot.strings) ? snapshot.strings : [];
      const read = (value) =>
        typeof value === "string"
          ? value
          : typeof value === "number" && value >= 0
            ? strings[value] ?? ""
            : "";
      for (const doc of snapshot.documents) {
        const frameId = read(doc.frameId);
        if (typeof frameId === "string" && frameId !== "" && !byFrame.has(frameId)) {
          byFrame.set(frameId, buildDocumentIndex(doc, read));
        }
      }
    }
    return { byFrame };
  })();
  state.dom.set(sessionId, pending);
  return pending;
}

async function loadFrameViewport(frame, state) {
  if (frame.frameId === state.mainFrameId) return state.topViewport;
  const cached = state.viewports.get(frame.frameId);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const world = await requestInFrame(state, frame, "Page.createIsolatedWorld", {
        frameId: frame.frameId,
        worldName: "rook-snapshot",
      });
      const contextId = world?.executionContextId;
      if (!Number.isInteger(contextId)) return undefined;
      const result = await requestInFrame(state, frame, "Runtime.evaluate", {
        expression: "({w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY})",
        returnByValue: true,
        contextId,
      });
      return viewportFromValue(result?.result?.value);
    } catch {
      // An unreadable frame viewport must not hide the frame's content.
      return undefined;
    }
  })();
  state.viewports.set(frame.frameId, pending);
  return pending;
}

// --- rendering -----------------------------------------------------------

async function findSubtreeRoot(backendNodeId, state) {
  for (const frameId of state.order) {
    const frame = state.frames.get(frameId);
    if (!frame) continue;
    const context = await frameContext(frame, state);
    const node = context.entry?.nodes.find(
      (candidate) => candidate.backendDOMNodeId === backendNodeId,
    );
    if (node) return { node, context };
  }
  return null;
}

async function renderChildren(node, depth, inheritedBounds, context) {
  const childIds = Array.isArray(node?.childIds) ? node.childIds : [];
  const output = [];
  for (const childId of childIds) {
    const child = context.entry?.byNodeId.get(childId);
    if (child) output.push(...(await renderNode(child, depth, inheritedBounds, context)));
  }
  return output;
}

/**
 * A frame body is `root` plus the frame document's own tree. Its nodes are in
 * the frame's coordinate space, so inherited bounds from the parent document
 * must not leak in.
 */
async function renderFrameBody(frame, depth, parentContext) {
  const context = await frameContext(frame, parentContext.state);
  if (!context.entry?.rootNode) return [];
  return [
    `${indent(depth)}root`,
    ...(await renderChildren(context.entry.rootNode, depth + 1, undefined, context)),
  ];
}

async function renderNode(node, depth, inheritedBounds, context, forceRoot = false) {
  if (node.ignored === true) {
    return renderChildren(node, depth, inheritedBounds, context);
  }
  const role = roleOf(node);
  if (SKIPPED_ROLES.has(role)) {
    return renderChildren(node, depth, inheritedBounds, context);
  }

  const ownBounds = boundsOf(node, context);
  const bounds = ownBounds ?? inheritedBounds;
  const inside =
    forceRoot ||
    !context.state.viewportScope ||
    context.viewport === undefined ||
    bounds === undefined ||
    intersects(bounds, context.viewport);

  const line = lineFor(node, role, context);
  // A frame owner is normally an `iframe` node, but `<object>`/`<embed>` hosts
  // can carry another role; the owner lookup is what actually finds the frame.
  const childFrame = context.entry?.ownerByBackend.get(node.backendDOMNodeId);
  const isFrameOwner = Boolean(childFrame) || role === "iframe";

  let children;
  if (!inside) {
    // A frame owner outside the viewport hides its whole frame: the contents
    // live in the frame's own coordinate space and cannot be judged from the
    // parent document.
    if (isFrameOwner) return [];
    children = await renderChildren(node, depth + 1, bounds, context);
  } else if (childFrame) {
    children = await renderFrameBody(childFrame, depth + 1, context);
  } else {
    children = await renderChildren(node, depth + 1, bounds, context);
  }

  if (line === null) return children;
  if (isFrameOwner) return [`${indent(depth)}${line}`, ...children];
  if (!inside && children.length === 0) return [];
  return [`${indent(depth)}${line}`, ...children];
}

function indent(depth) {
  return "  ".repeat(depth);
}

function lineFor(node, role, context) {
  if (role === "rootwebarea" || role === "webarea") return "root";
  const name = nameOf(node);
  if (role === "statictext") {
    return name ? `text ${JSON.stringify(name)}` : null;
  }
  const head = name ? `${role} ${JSON.stringify(name)}` : role;
  const metadata = refMetadata(node, role, name, context);
  return metadata ? `${head} ${metadata}` : head;
}

function refMetadata(node, role, name, context) {
  if (!INTERACTIVE_ROLES.has(role)) return null;
  const backendNodeId = node.backendDOMNodeId;
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return null;

  const frameId = context.frame.frameId;
  // backendNodeIds are renderer-local, so the same number can name different
  // nodes in two frames. Ref identity must include the owning frame.
  const key = `${frameId}:${backendNodeId}`;
  const existing = context.state.refsByNode.get(key);
  if (existing) return `[ref=${existing}]`;

  const refId = context.state.nextRefId++;
  const entry = context.box?.info.get(backendNodeId);
  const ref = {
    refId,
    backendNodeId,
    role,
    name: name || undefined,
  };
  // Main-frame refs deliberately carry no frameId: page-model resolves the
  // owning document through #pageDocuments' "" entry (page-model.ts:2916), and
  // page-actions only calls DOM.getFrameOwner for refs that have a frameId
  // (page-actions.ts:294). A main frame id here makes every click fail with
  // "Frame with the given id does not belong to the target". A node inside a
  // child frame, on the other hand, must name its frame or the Page would
  // resolve it in the wrong document.
  if (frameId !== context.state.mainFrameId) ref.frameId = frameId;
  const loc = locatorFor(entry, context.box);
  if (loc) ref.loc = loc;
  if (entry?.url) ref.url = entry.url;

  const parts = [`ref=${refId}`];
  if (ref.loc) parts.push(`loc=${ref.loc}`);
  if (ref.url) parts.push(`url=${ref.url}`);

  context.state.refs.push(ref);
  context.state.refsByNode.set(key, refId);
  return `[${parts.join(", ")}]`;
}

function locatorFor(entry, box) {
  if (!entry || !box) return undefined;
  if (entry.id && box.idCounts.get(entry.id) === 1 && /^[A-Za-z_][\w-]*$/.test(entry.id)) {
    return `css:#${entry.id}`;
  }
  if (entry.hrefKey && box.hrefCounts.get(entry.hrefKey) === 1) {
    return `href:${entry.hrefKey}`;
  }
  return undefined;
}

// --- viewport ------------------------------------------------------------

function normalizeScope(scope) {
  if (scope === "only_within_viewport" || scope === "subtree") return scope;
  return "full_page";
}

function normalizeViewport(value) {
  const w = Number(value?.w);
  const h = Number(value?.h);
  const sx = Number(value?.sx);
  const sy = Number(value?.sy);
  return {
    x: Number.isFinite(sx) ? sx : 0,
    y: Number.isFinite(sy) ? sy : 0,
    w: Number.isFinite(w) && w > 0 ? w : 1280,
    h: Number.isFinite(h) && h > 0 ? h : 800,
  };
}

function viewportFromValue(value) {
  const w = Number(value?.w);
  const h = Number(value?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  const sx = Number(value?.sx);
  const sy = Number(value?.sy);
  return {
    x: Number.isFinite(sx) ? sx : 0,
    y: Number.isFinite(sy) ? sy : 0,
    w,
    h,
  };
}

function boundsOf(node, context) {
  const backendNodeId = node?.backendDOMNodeId;
  if (!Number.isInteger(backendNodeId)) return undefined;
  return context.box?.info.get(backendNodeId)?.bounds;
}

function intersects(bounds, viewport) {
  const [x, y, width, height] = bounds;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return true;
  if (width <= 0 || height <= 0) return true;
  return (
    x < viewport.x + viewport.w &&
    x + width > viewport.x &&
    y < viewport.y + viewport.h &&
    y + height > viewport.y
  );
}

// --- AX helpers ----------------------------------------------------------

function roleOf(node) {
  const value = axValue(node?.role);
  return typeof value === "string" ? value.toLowerCase() : "";
}

function nameOf(node) {
  const value = axValue(node?.name);
  return typeof value === "string" ? value : "";
}

function axValue(entry) {
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === "string") return entry;
  return entry.value;
}

// --- DOMSnapshot indexing ------------------------------------------------

function buildDocumentIndex(doc, read) {
  const info = new Map();
  const idCounts = new Map();
  const hrefCounts = new Map();
  const nodes = normalizeNodeList(doc.nodes);
  const layout = doc.layout ?? {};
  const boundsByIndex = new Map();
  const nodeIndexes = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
  const layoutBounds = layout.bounds;
  nodeIndexes.forEach((nodeIndex, position) => {
    const rect = Array.isArray(layoutBounds) ? layoutBounds[position] : undefined;
    if (Array.isArray(rect) && rect.length >= 4) {
      boundsByIndex.set(nodeIndex, rect.slice(0, 4).map(Number));
    }
  });

  const documentURL = read(doc.documentURL);
  nodes.forEach((node, index) => {
    const backendNodeId = node.backendNodeId;
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) return;

    const attributes = readAttributes(node.attributes, read);
    const tag = read(node.nodeName).toLowerCase();
    const id = attributes.get("id");
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    const href = tag === "a" ? attributes.get("href") : undefined;
    const hrefKey = href ? hrefLocatorKey(href, documentURL) : undefined;
    if (hrefKey) hrefCounts.set(hrefKey, (hrefCounts.get(hrefKey) ?? 0) + 1);

    info.set(backendNodeId, {
      tag,
      id,
      href,
      hrefKey,
      url: href ? absoluteHref(href, documentURL) : undefined,
      bounds: boundsByIndex.get(index),
    });
  });
  return { info, idCounts, hrefCounts };
}

/**
 * Modern Chromium (151 here) returns DOMSnapshot documents in a columnar form:
 * `nodes` is an object of parallel arrays whose string fields are indexes into
 * `snapshot.strings`. Older builds return an array of objects. Support both.
 */
function normalizeNodeList(nodes) {
  if (Array.isArray(nodes)) {
    return nodes.map((node) => ({
      nodeName: node?.nodeName,
      backendNodeId: node?.backendNodeId,
      attributes: node?.attributes,
    }));
  }
  if (nodes && Array.isArray(nodes.backendNodeId)) {
    const count = nodes.backendNodeId.length;
    const list = new Array(count);
    for (let index = 0; index < count; index += 1) {
      list[index] = {
        nodeName: nodes.nodeName?.[index],
        backendNodeId: nodes.backendNodeId[index],
        attributes: nodes.attributes?.[index],
      };
    }
    return list;
  }
  return [];
}

function readAttributes(raw, read) {
  const attributes = new Map();
  if (!Array.isArray(raw) || raw.length === 0) return attributes;
  const first = raw[0];
  if (Array.isArray(first)) {
    // Columnar form: array of [nameIndex, valueIndex] pairs.
    for (const pair of raw) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      attributes.set(read(pair[0]), read(pair[1]));
    }
    return attributes;
  }
  if (first && typeof first === "object") {
    // NameValue[] form.
    for (const pair of raw) {
      if (pair && typeof pair === "object") {
        attributes.set(read(pair.name), read(pair.value));
      }
    }
    return attributes;
  }
  // Flat name/value list (legacy form).
  for (let index = 0; index + 1 < raw.length; index += 2) {
    attributes.set(read(raw[index]), read(raw[index + 1]));
  }
  return attributes;
}

function hrefLocatorKey(href, documentURL) {
  try {
    const base = documentURL || "http://localhost/";
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const baseUrl = new URL(base);
    if (url.origin !== baseUrl.origin) return url.href;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function absoluteHref(href, documentURL) {
  try {
    return new URL(href, documentURL || "http://localhost/").href;
  } catch {
    return undefined;
  }
}
