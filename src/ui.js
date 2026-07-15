// ui.js — boots the editor. Two-column left panel, right canvas:
//   column 1 (#nav-panel) — RSTR wordmark, /Styles (fixed header: library +
//     Save/Del/Copy/Paste + Reset), /Effects (the ONLY scrolling region —
//     drag-reorderable, user-groupable; the ⚙ on the canvas overlay swaps it
//     for the enable/disable checklist, same order/groups).
//   column 2 (#panel)     — the workbench: PRE (always expanded, its own
//     RESET), the EDIT/NEW/OUTPUT panel (RESET + PRESETS modal trigger),
//     ADD TO MIX, LAYERS (the MIX stack, ◇ OUTPUT pinned on top), and a
//     pinned footer (EXPORT only).
// The edit panel edits ONE target:
//   NEW    — an effect picked from the list, previewed on top of the mix; ADD commits it
//   EDIT   — an existing mix layer, mutated in place (no ADD)
//   OUTPUT — the pinned OUTPUT layer (crop / scale / format + live SRC→OUT dims)
// The committed mix + the OUTPUT block define the exported style. Classic script.
(function (RSTR) {
  'use strict';

  const state = {
    mix: [], // committed effect layers: [{ effect, enabled, params }]
    // editTarget: { kind:'new', effect, params } | { kind:'layer', index } | { kind:'output' }
    editTarget: { kind: 'new', effect: RSTR.EFFECT_LIST[0].id, params: RSTR.defaultParams(RSTR.EFFECT_LIST[0].id) },
    output: RSTR.preset.defaultOutput(),
    outputEnabled: true, // UI toggle on the OUTPUT layer; off => passthrough
    imageName: 'rstr',
    disabled: new Set(), // effect ids hidden from the picker (loaded in boot)
    settingsOpen: false,
    pre: RSTR.preset.defaultPre(), // global PRE block — always applied first, see preLayer(); always expanded, no collapse state
    source: RSTR.preset.defaultSource(), // pinned "◇ ORIGINAL" row (bottom of LAYERS): {enabled, opacity} BASE PLATE composited under the finished stack as a final pass — NOT part of state.mix, see buildMixList()/src/pipeline.js render(). Defaults to enabled:false (see src/preset.js normalizeSource) so the checkbox starts UNCHECKED — turning it on for free would silently fill crt's transparent void and every other alpha-hole effect.
    // user-defined /Effects catalog order + grouping — persisted to
    // localStorage (rstr.effectOrder / rstr.effectGroups), loaded in boot via
    // loadOrderState(). effectOrder mixes plain effect ids (top-level,
    // ungrouped rows) with group-anchor tokens "@group:<id>" marking where a
    // group header sits; a group's members live in its OWN `effects` array,
    // never duplicated at the top level. See loadOrderState() for the
    // reconciliation that makes this robust to the registry changing.
    effectOrder: [],
    effectGroups: [], // [{ id, name, collapsed, effects: [id,…] }]
  };

  let pipeline = null;
  let outputDirty = false;
  let renderDirty = false;
  let els = {};

  function visibleEffectList() {
    return RSTR.EFFECT_LIST.filter((d) => !d.internal && !state.disabled.has(d.id));
  }

  // The PENDING PRE pass as a stack layer (empty when identity). PRE is a
  // live working buffer: it renders at the END of the committed mix (right
  // under the NEW-mode preview) and gets BAKED into the mix as an explicit
  // `preprocess` layer by addToMix — it is never serialized as a separate
  // style-code `pre` block anymore (old codes with one still load, see
  // applyStyle).
  function preLayer() {
    return RSTR.preset.preIsIdentity(state.pre) ? [] : [{ effect: 'preprocess', enabled: true, params: state.pre }];
  }

  // The output actually applied to preview/export/style: passthrough when the
  // OUTPUT layer is toggled off (keeps the schema unchanged — no `enabled` key).
  function effectiveOutput() {
    return state.outputEnabled ? state.output : RSTR.preset.defaultOutput();
  }

  // ---------- edit-target helpers ----------
  function currentEffectId() {
    const t = state.editTarget;
    if (t.kind === 'new') return t.effect;
    if (t.kind === 'layer') return state.mix[t.index].effect;
    return null; // output
  }
  function currentParams() {
    const t = state.editTarget;
    if (t.kind === 'new') return t.params;
    if (t.kind === 'layer') return state.mix[t.index].params;
    return null;
  }
  function setCurrentParams(params) {
    const t = state.editTarget;
    if (t.kind === 'new') t.params = params;
    else if (t.kind === 'layer') state.mix[t.index].params = params;
  }

  // ---------- rendering ----------
  // Live canvas = the enabled mix, then the pending PRE, then (in NEW mode)
  // the picked effect on top — exactly the order addToMix commits, so the
  // preview never jumps when a layer is added.
  function livePreviewStack() {
    const enabled = state.mix.filter((s) => s.enabled !== false);
    if (state.editTarget.kind === 'new') {
      return enabled.concat(preLayer(), [
        { effect: state.editTarget.effect, enabled: true, params: state.editTarget.params },
      ]);
    }
    return enabled.concat(preLayer());
  }

  function requestRender() {
    renderDirty = true;
  }
  function requestOutput() {
    outputDirty = true;
    renderDirty = true;
    refreshOutputVisuals();
  }

  function frame() {
    if (pipeline && pipeline.hasImage()) {
      if (outputDirty) {
        pipeline.applyOutput(effectiveOutput());
        outputDirty = false;
      }
      if (renderDirty) {
        pipeline.render(livePreviewStack(), state.source);
        renderDirty = false;
      }
      // The processing resolution (canvas backing store) changed.
      if (els.canvas.width !== view.lastW || els.canvas.height !== view.lastH) {
        const oldW = view.lastW;
        const oldH = view.lastH;
        view.lastW = els.canvas.width;
        view.lastH = els.canvas.height;
        if (view.freshImage || !oldW || !oldH) {
          // A brand-new source image (loadImageFile sets freshImage — see
          // there) — fit-to-view, capped at 100% so a small source opens 1:1
          // instead of blown up to fill the viewport.
          view.freshImage = false;
          refitView();
        } else {
          // Same image, buffer resized (e.g. dragging PRE's CANVAS scrub) —
          // snap to 1:1. The user wants the true pixels: at 100% the marks
          // hold their real size while the picture shrinks around them, which
          // IS the effect coarsening relative to the content. (An earlier
          // version compensated zoom to hold the on-screen size constant;
          // 1:1 shows the same fact without lying about the scale.)
          view.zoom = 1;
          centerView();
          applyView();
        }
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- viewport (display only — CSS transform on #canvas-transform) ----------
  // Panning/zooming never re-renders the pipeline; EXPORT and the engine always
  // use the full processing-resolution canvas backing store, independent of zoom.
  // freshImage: true right after a NEW source loads (or at boot) — the next
  // backing-store change should re-FIT (capped at 100%, see refitView), not
  // compensate zoom. Cleared the moment that fit runs; a later backing-store
  // change on the SAME image (e.g. dragging PRE's CANVAS scrub) preserves
  // on-screen size instead — see frame()'s width/height watcher below.
  const view = { zoom: 1, panX: 0, panY: 0, fitZoom: 1, lastW: 0, lastH: 0, freshImage: true };

  function applyView() {
    els.canvasTransform.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    const pct = Math.round(view.zoom * 100);
    els.zoomSlider.value = String(Math.max(5, Math.min(400, pct)));
    els.zoomReadout.textContent = pct + '%';
  }

  function centerView() {
    const vw = els.canvasWrap.clientWidth;
    const vh = els.canvasWrap.clientHeight;
    view.panX = (vw - els.canvas.width * view.zoom) / 2;
    view.panY = (vh - els.canvas.height * view.zoom) / 2;
  }

  // Fit-to-view preserving aspect (contain), capped at 100% — never upscale a
  // small source past its native size (a 256x256 image opens 1:1, not blown
  // up to fill the viewport). Only called for a genuinely NEW image (or the
  // Fit button / a window resize); a CANVAS-driven backing-store resize on
  // the SAME image instead compensates zoom directly — see frame(). Centered.
  function refitView() {
    const vw = els.canvasWrap.clientWidth;
    const vh = els.canvasWrap.clientHeight;
    const iw = els.canvas.width;
    const ih = els.canvas.height;
    if (!iw || !ih || !vw || !vh) return;
    view.fitZoom = Math.min(1, vw / iw, vh / ih);
    view.zoom = view.fitZoom;
    centerView();
    applyView();
  }

  function setZoom100() {
    view.zoom = 1;
    centerView();
    applyView();
  }

  // Zoom to `z`, keeping the image point under viewport coords (ax,ay) fixed.
  function zoomAt(z, ax, ay) {
    const nz = Math.max(0.05, Math.min(4, z));
    const imgX = (ax - view.panX) / view.zoom;
    const imgY = (ay - view.panY) / view.zoom;
    view.panX = ax - imgX * nz;
    view.panY = ay - imgY * nz;
    view.zoom = nz;
    applyView();
  }

  function wireViewport() {
    els.zoomSlider.addEventListener('input', () => {
      const vw = els.canvasWrap.clientWidth;
      const vh = els.canvasWrap.clientHeight;
      zoomAt(Number(els.zoomSlider.value) / 100, vw / 2, vh / 2);
    });
    els.zoomFit.addEventListener('click', refitView);
    els.zoom100.addEventListener('click', setZoom100);

    // Ctrl + wheel zooms toward the cursor; plain wheel does nothing.
    els.canvasWrap.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        const rect = els.canvasWrap.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoomAt(view.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );

    // Middle-mouse drag pans.
    let panning = false;
    let panStart = null;
    els.canvasWrap.addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      panning = true;
      panStart = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
    });
    els.canvasWrap.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!panning) return;
      view.panX = panStart.panX + (e.clientX - panStart.x);
      view.panY = panStart.panY + (e.clientY - panStart.y);
      applyView();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) panning = false;
    });

    window.addEventListener('resize', () => {
      if (pipeline && pipeline.hasImage()) refitView();
    });
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => els.toast.classList.remove('show'), 1600);
  }

  // ---------- built-in per-effect presets (array or legacy object) ----------
  function builtinPresets(def) {
    const p = def.presets;
    if (!p) return [];
    if (Array.isArray(p)) return p.map((x) => ({ name: x.name, params: x.params }));
    return Object.keys(p).map((name) => ({ name, params: p[name] }));
  }

  // ---------- settings view (gear) ----------
  // Scoped to column 1's /Effects section only (not a full-panel takeover):
  // swaps the flat effect-list for the enable/disable checklist. Column 2
  // (PRE/MIX/edit panel/footer) stays visible and usable throughout.
  function showSettings(open) {
    state.settingsOpen = open;
    els.settingsBtn.classList.toggle('active', open);
    els.effectList.style.display = open ? 'none' : '';
    els.settingsPanel.style.display = open ? 'block' : 'none';
  }

  function buildSettings() {
    const list = els.settingsList;
    list.innerHTML = '';
    const groupById = {};
    for (const g of state.effectGroups) groupById[g.id] = g;

    const makeRow = (def) => {
      const row = document.createElement('label');
      row.className = 'settings-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.disabled.has(def.id);
      cb.addEventListener('change', () => toggleEffect(def.id, cb.checked));
      const name = document.createElement('span');
      name.textContent = def.name;
      row.append(cb, name);
      return row;
    };

    for (const entry of state.effectOrder) {
      if (entry.indexOf('@group:') === 0) {
        const g = groupById[entry.slice(7)];
        if (!g) continue;
        const header = document.createElement('div');
        header.className = 'group-header';
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = g.name;
        header.appendChild(name);
        list.appendChild(header);
        for (const id of g.effects) {
          const def = RSTR.getEffect(id);
          if (!def) continue;
          const row = makeRow(def);
          row.classList.add('grouped');
          list.appendChild(row);
        }
      } else {
        const def = RSTR.getEffect(entry);
        if (!def) continue;
        list.appendChild(makeRow(def));
      }
    }
  }

  function toggleEffect(id, enabled) {
    if (enabled) state.disabled.delete(id);
    else state.disabled.add(id);
    RSTR.preset.saveDisabledEffects([...state.disabled]);
    // if the NEW-mode effect just got hidden, move to the first visible one
    if (state.editTarget.kind === 'new' && state.disabled.has(state.editTarget.effect)) {
      const visible = visibleEffectList();
      if (visible.length) selectEffect(visible[0].id);
    }
    buildEffectList();
  }

  // ---------- /Effects catalog: order + user groups (persisted) ----------
  // localStorage keys (rstr.* namespace). effectOrder is an array mixing
  // plain effect ids (top-level, ungrouped rows) with group-anchor tokens
  // "@group:<id>"; a group's own members live in effectGroups[i].effects,
  // never duplicated at the top level.
  const LS_ORDER = 'rstr.effectOrder';
  const LS_GROUPS = 'rstr.effectGroups';
  let groupSeq = 0;
  function makeGroupId() {
    return 'g' + Date.now().toString(36) + groupSeq++;
  }

  // Robust load: the effect registry changes between versions, so this must
  // never lose an effect and never crash on garbage storage.
  //  - unknown/stale ids (in order OR inside a group) are dropped
  //  - registry effects missing from storage are appended, ungrouped, at the end
  //  - group tokens with no matching group are dropped; groups missing a
  //    token get one appended at the end
  function loadOrderState() {
    let order, groups;
    try { order = JSON.parse(localStorage.getItem(LS_ORDER) || '[]'); } catch { order = []; }
    try { groups = JSON.parse(localStorage.getItem(LS_GROUPS) || '[]'); } catch { groups = []; }
    if (!Array.isArray(order)) order = [];
    if (!Array.isArray(groups)) groups = [];

    groups = groups
      .filter((g) => g && typeof g === 'object' && typeof g.name === 'string')
      .map((g) => ({
        id: typeof g.id === 'string' && g.id ? g.id : makeGroupId(),
        name: g.name,
        collapsed: !!g.collapsed,
        effects: Array.isArray(g.effects) ? g.effects.filter((x) => typeof x === 'string') : [],
      }));

    const validIds = RSTR.EFFECT_LIST.filter((d) => !d.internal).map((d) => d.id);
    const validSet = new Set(validIds);

    // drop stale ids from groups; track which ids a group has already claimed
    // (an id can only live in ONE place — first group wins if duplicated)
    const claimed = new Set();
    for (const g of groups) {
      g.effects = g.effects.filter((id) => validSet.has(id) && !claimed.has(id));
      g.effects.forEach((id) => claimed.add(id));
    }
    const groupIdSet = new Set(groups.map((g) => g.id));

    const seenTop = new Set();
    order = order.filter((entry) => {
      if (typeof entry !== 'string') return false;
      if (entry.indexOf('@group:') === 0) {
        const gid = entry.slice(7);
        if (!groupIdSet.has(gid) || seenTop.has(entry)) return false;
        seenTop.add(entry);
        return true;
      }
      if (!validSet.has(entry) || claimed.has(entry) || seenTop.has(entry)) return false;
      seenTop.add(entry);
      return true;
    });

    for (const g of groups) {
      const token = '@group:' + g.id;
      if (!seenTop.has(token)) {
        order.push(token);
        seenTop.add(token);
      }
    }
    for (const id of validIds) {
      if (!claimed.has(id) && !seenTop.has(id)) {
        order.push(id);
        seenTop.add(id);
      }
    }

    return { order, groups };
  }

  function saveOrderState() {
    try {
      localStorage.setItem(LS_ORDER, JSON.stringify(state.effectOrder));
      localStorage.setItem(LS_GROUPS, JSON.stringify(state.effectGroups));
    } catch {
      /* non-fatal */
    }
  }

  function removeEffectFromCurrentLocation(id) {
    const idx = state.effectOrder.indexOf(id);
    if (idx >= 0) state.effectOrder.splice(idx, 1);
    for (const g of state.effectGroups) {
      const gi = g.effects.indexOf(id);
      if (gi >= 0) {
        g.effects.splice(gi, 1);
        break;
      }
    }
  }

  // Move `id` to the top level (ungrouped), inserted relative to `targetId`
  // (another top-level id or a group token) — before or after it.
  function moveEffectToTopLevel(id, targetId, before) {
    removeEffectFromCurrentLocation(id);
    let idx = state.effectOrder.indexOf(targetId);
    if (idx < 0) idx = state.effectOrder.length;
    state.effectOrder.splice(before ? idx : idx + 1, 0, id);
  }

  // Move `id` into group `gid`. targetId null = append to the end of the
  // group; otherwise insert relative to that member (before/after).
  function moveEffectIntoGroup(id, gid, targetId, before) {
    removeEffectFromCurrentLocation(id);
    const g = state.effectGroups.find((x) => x.id === gid);
    if (!g) return;
    if (targetId == null) {
      g.effects.push(id);
      return;
    }
    let idx = g.effects.indexOf(targetId);
    if (idx < 0) idx = g.effects.length;
    g.effects.splice(before ? idx : idx + 1, 0, id);
  }

  // Move a whole group's anchor token to a new position among the top-level
  // effectOrder entries (other groups' tokens + ungrouped effect ids),
  // inserted relative to `targetEntry` (a raw effectOrder entry — a plain
  // effect id or another group's "@group:<id>" token). Groups only ever live
  // at the top level, so this never touches any group's `effects` array —
  // there is no nesting path here.
  function moveGroupToTopLevel(gid, targetEntry, before) {
    const token = '@group:' + gid;
    const idx = state.effectOrder.indexOf(token);
    if (idx >= 0) state.effectOrder.splice(idx, 1);
    let targetIdx = state.effectOrder.indexOf(targetEntry);
    if (targetIdx < 0) targetIdx = state.effectOrder.length;
    state.effectOrder.splice(before ? targetIdx : targetIdx + 1, 0, token);
  }

  function createGroupFlow() {
    openInline('New group name…', '', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      const g = { id: makeGroupId(), name, collapsed: false, effects: [] };
      state.effectGroups.push(g);
      state.effectOrder.push('@group:' + g.id);
      saveOrderState();
      buildEffectList();
      buildSettings();
      return null;
    });
  }

  function renameGroupFlow(gid) {
    const g = state.effectGroups.find((x) => x.id === gid);
    if (!g) return;
    openInline('Group name…', g.name, (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      g.name = name;
      saveOrderState();
      buildEffectList();
      buildSettings();
      return null;
    });
  }

  // Deleting a group ungroups its effects (they return to the top level, at
  // the group's old position) — it never deletes the effects themselves.
  function deleteGroup(gid) {
    const idx = state.effectGroups.findIndex((g) => g.id === gid);
    if (idx < 0) return;
    const g = state.effectGroups[idx];
    const token = '@group:' + gid;
    const orderIdx = state.effectOrder.indexOf(token);
    state.effectGroups.splice(idx, 1);
    if (orderIdx >= 0) state.effectOrder.splice(orderIdx, 1, ...g.effects);
    else state.effectOrder.push(...g.effects);
    saveOrderState();
    buildEffectList();
    buildSettings();
    showToast(`Deleted group "${g.name}"`);
  }

  // ---------- drag-to-reorder (native HTML5 DnD, no library) ----------
  // dragItem = { type: 'effect'|'group', id } for whatever is currently being
  // dragged; a 1px insertion line (top/bottom border color swap — see
  // .drop-before/.drop-after in CSS, shared by .effect-row AND .group-header)
  // marks where it will land; a group header additionally highlights
  // (.drop-into) when an EFFECT drop would join that group instead of
  // inserting a sibling row. Groups themselves never have a "join" target —
  // dragging a group only ever reorders it as a top-level sibling, so groups
  // can't nest inside groups.
  let dragItem = null;

  function clearDropIndicators() {
    const scope = els.effectList;
    if (!scope) return;
    scope.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
  }

  function wireEffectDrag(row, id) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragItem = { type: 'effect', id };
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', id);
      } catch {
        /* non-fatal — some embedders restrict dataTransfer */
      }
    });
    row.addEventListener('dragend', () => {
      dragItem = null;
      clearDropIndicators();
    });
  }

  // Whole-group drag: dragstart on the header carries the group id. Same
  // mechanism as wireEffectDrag, distinguished by dragItem.type so drop
  // targets can tell a dragged group apart from a dragged effect.
  function wireGroupDrag(header, gid) {
    header.draggable = true;
    header.addEventListener('dragstart', (e) => {
      dragItem = { type: 'group', id: gid };
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', '@group:' + gid);
      } catch {
        /* non-fatal — some embedders restrict dataTransfer */
      }
    });
    header.addEventListener('dragend', () => {
      dragItem = null;
      clearDropIndicators();
    });
  }

  // `el` is a row/header acting as a before/after sibling-insertion drop
  // target. `onDropEffect(draggedEffectId, before)` / `onDropGroup(draggedGroupId,
  // before)` perform the actual reorder — pass null for either to reject that
  // drag type on this target entirely (no indicator shown, no drop). `before`
  // is computed from pointer Y vs the target's vertical midpoint.
  function wireDropTarget(el, onDropEffect, onDropGroup) {
    el.addEventListener('dragover', (e) => {
      if (!dragItem) return;
      const cb = dragItem.type === 'effect' ? onDropEffect : dragItem.type === 'group' ? onDropGroup : null;
      if (!cb) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      clearDropIndicators();
      el.classList.add(before ? 'drop-before' : 'drop-after');
    });
    el.addEventListener('drop', (e) => {
      if (!dragItem) return;
      const cb = dragItem.type === 'effect' ? onDropEffect : dragItem.type === 'group' ? onDropGroup : null;
      if (!cb) return;
      e.preventDefault();
      const before = el.classList.contains('drop-before');
      const id = dragItem.id;
      clearDropIndicators();
      dragItem = null;
      cb(id, before);
    });
  }

  // Group headers are also a drop target for "drop straight onto me" (join
  // the group, appended at the end) — distinct from before/after which
  // reorders it as a top-level sibling of the header itself. Effect drags
  // only — a dragged GROUP never joins another group (no nesting).
  function wireGroupDropTarget(header, gid) {
    header.addEventListener('dragover', (e) => {
      if (!dragItem || dragItem.type !== 'effect') return;
      e.preventDefault();
      clearDropIndicators();
      header.classList.add('drop-into');
    });
    header.addEventListener('drop', (e) => {
      if (!dragItem || dragItem.type !== 'effect') return;
      e.preventDefault();
      const id = dragItem.id;
      clearDropIndicators();
      dragItem = null;
      moveEffectIntoGroup(id, gid, null, true);
      saveOrderState();
      buildEffectList();
      buildSettings();
    });
  }

  // ---------- /Effects picker (drag-reorderable, groupable) ----------
  function buildEffectList() {
    const list = els.effectList;
    list.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'group-grid';
    const activeNew = state.editTarget.kind === 'new' ? state.editTarget.effect : null;
    const groupById = {};
    for (const g of state.effectGroups) groupById[g.id] = g;
    let renderedAny = false;

    const makeEffectRow = (def, groupId) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'effect-row' + (def.id === activeNew ? ' active' : '') + (groupId ? ' grouped' : '');
      row.textContent = def.name;
      row.addEventListener('click', () => selectEffect(def.id));
      wireEffectDrag(row, def.id);
      wireDropTarget(
        row,
        (draggedId, before) => {
          if (draggedId === def.id) return;
          if (groupId) moveEffectIntoGroup(draggedId, groupId, def.id, before);
          else moveEffectToTopLevel(draggedId, def.id, before);
          saveOrderState();
          buildEffectList();
          buildSettings();
        },
        // A dragged GROUP may only land among top-level (ungrouped) rows —
        // never between two members of a group, which would be nesting.
        groupId
          ? null
          : (draggedGid, before) => {
              moveGroupToTopLevel(draggedGid, def.id, before);
              saveOrderState();
              buildEffectList();
              buildSettings();
            }
      );
      return row;
    };

    for (const entry of state.effectOrder) {
      if (entry.indexOf('@group:') === 0) {
        const g = groupById[entry.slice(7)];
        if (!g) continue;
        const header = document.createElement('div');
        header.className = 'group-header';
        const arrow = document.createElement('span');
        arrow.className = 'group-arrow';
        arrow.textContent = g.collapsed ? '▸' : '▾';
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = g.name;
        name.title = 'Double-click to rename';
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          renameGroupFlow(g.id);
        });
        const del = iconButton('✕', 'Delete group (keeps effects, ungrouped)', () => deleteGroup(g.id));
        del.classList.add('icon-btn-sm');
        header.append(arrow, name, del);
        header.addEventListener('click', (e) => {
          if (e.target === del) return;
          g.collapsed = !g.collapsed;
          saveOrderState();
          buildEffectList();
          buildSettings();
        });
        // Group headers accept two distinct drags: an EFFECT dropped onto
        // the header joins the group (wireGroupDropTarget, .drop-into); a
        // whole GROUP dropped onto the header reorders it as a top-level
        // sibling, before/after (wireDropTarget, .drop-before/.drop-after) —
        // never a "join", so groups can't nest.
        wireGroupDrag(header, g.id);
        wireGroupDropTarget(header, g.id);
        wireDropTarget(header, null, (draggedGid, before) => {
          if (draggedGid === g.id) return;
          moveGroupToTopLevel(draggedGid, '@group:' + g.id, before);
          saveOrderState();
          buildEffectList();
          buildSettings();
        });
        grid.appendChild(header);
        renderedAny = true;
        if (!g.collapsed) {
          for (const id of g.effects) {
            const def = RSTR.getEffect(id);
            if (!def || state.disabled.has(id)) continue;
            grid.appendChild(makeEffectRow(def, g.id));
            renderedAny = true;
          }
        }
      } else {
        const def = RSTR.getEffect(entry);
        if (!def || state.disabled.has(entry)) continue;
        grid.appendChild(makeEffectRow(def, null));
        renderedAny = true;
      }
    }

    if (!renderedAny) {
      const empty = document.createElement('div');
      empty.className = 'stack-empty';
      empty.textContent = 'All effects hidden — enable some in ⚙ Settings.';
      list.appendChild(empty);
      return;
    }
    list.appendChild(grid);
  }

  // ---------- target selection ----------
  function selectEffect(id) {
    // NEW mode — a fresh effect previewed on top of the mix
    state.editTarget = { kind: 'new', effect: id, params: RSTR.defaultParams(id) };
    buildEditor();
    buildEffectList();
    buildMixList();
    requestRender();
  }

  function selectLayer(index) {
    state.editTarget = { kind: 'layer', index };
    buildEditor();
    buildEffectList();
    buildMixList();
    requestRender();
  }

  function selectOutput() {
    state.editTarget = { kind: 'output' };
    buildEditor();
    buildEffectList();
    buildMixList();
    requestOutput();
  }

  // ---------- edit panel ----------
  function buildEditor() {
    closeColorPicker(); // the previous target's swatch anchors are about to be torn down
    closePresetsModal(); // switching targets while the modal is open would show stale presets
    const t = state.editTarget;
    if (t.kind === 'output') {
      els.targetHeader.textContent = 'EDIT · OUTPUT';
      els.effectEditor.style.display = 'none';
      els.outputEditor.style.display = 'block';
      // footer stays visible (EXPORT always applies) — only the per-effect
      // Presets/Reset/ADD (none meaningful for OUTPUT) hide.
      els.presetsBtn.style.display = 'none';
      els.settingsResetBtn.style.display = 'none';
      els.addBtn.style.display = 'none';
      buildOutputEditor();
      return;
    }
    const effectId = currentEffectId();
    const def = RSTR.getEffect(effectId);
    els.targetHeader.textContent = t.kind === 'new' ? `NEW · ${def.name}` : `EDIT · ${def.name} [${t.index + 1}]`;
    els.effectEditor.style.display = 'block';
    els.outputEditor.style.display = 'none';
    els.presetsBtn.style.display = '';
    els.settingsResetBtn.style.display = '';
    els.addBtn.style.display = t.kind === 'new' ? '' : 'none';
    buildActiveParams();
  }

  // Restores every param of the CURRENT effect target (NEW or EDIT) to the
  // registry defaults, live-renders, and (in EDIT mode) writes through to the
  // layer via setCurrentParams. Never touches the layer's opacity or its
  // position in the stack — same affordance PRE's own RESET has.
  function resetCurrentEffectParams() {
    const t = state.editTarget;
    if (t.kind === 'output') return;
    const id = currentEffectId();
    setCurrentParams(RSTR.defaultParams(id));
    buildActiveParams();
    requestRender();
  }

  // showIf: { key, in: [...] } — a param is visible only when the CURRENT
  // value of params[showIf.key] (falling back to that param's own default
  // when absent, same fallback the pipeline/renderParamControl use) is one
  // of showIf.in. UI-only: src/pipeline.js keeps uploading every param as a
  // uniform regardless of mode, so a hidden param's value is still live —
  // it's just not exposed to edit while its controller param doesn't select it.
  function paramVisible(param, params, def) {
    if (!param.showIf) return true;
    const controller = def.params.find((p) => p.key === param.showIf.key);
    const val = params[param.showIf.key] != null ? params[param.showIf.key] : controller && controller.default;
    return param.showIf.in.indexOf(val) >= 0;
  }

  function buildActiveParams() {
    closeColorPicker(); // rebuild is about to replace/remove any open swatch anchor
    const def = RSTR.getEffect(currentEffectId());
    const container = els.activeParams;
    container.innerHTML = '';
    // Opacity is layer-level, not an effect param — it lives on the layer's
    // row in the MIX stack (see buildMixList), not here.
    const params = currentParams();
    for (const param of def.params) {
      if (!paramVisible(param, params, def)) continue;
      container.appendChild(renderParamControl(param, params));
    }
    if (def.id === 'ascii') container.appendChild(buildAsciiCopyButton());
    if (def.id === 'gradientmap') container.appendChild(buildReverseColorsButton());
  }

  // ---------- ASCII: copy the last-rendered text grid ----------
  function buildAsciiCopyButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ascii-copy-btn';
    btn.textContent = 'COPY TEXT';
    btn.addEventListener('click', () => copyAsciiText(btn));
    return btn;
  }

  // ---------- REVERSE COLORS (gradientmap only) ----------
  // Rewrites existing param VALUES in place — not a new serialized param.
  // gradientmap's `stops` is a {pos,color}[] array: mirroring pos -> 1-pos
  // reverses which color sits at which luminance. (Pre-2026-07-13 this also
  // handled `recolor`'s 3 independently-keyed stop1/pos1..stop3/pos3 — that
  // branch is gone now that recolor is folded into gradientmap's `stops`
  // array; see src/effects.js / src/preset.js LEGACY_EFFECTS.)
  function buildReverseColorsButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reverse-colors-btn';
    btn.textContent = 'REVERSE';
    btn.title = 'Reverse the color mapping';
    btn.addEventListener('click', () => reverseColors());
    return btn;
  }

  function reverseColors() {
    const def = RSTR.getEffect(currentEffectId());
    if (def.id !== 'gradientmap') return;
    const params = currentParams();
    const stopsParam = def.params.find((p) => p.key === 'stops');
    const stops = ensureStopsArray(stopsParam, params);
    for (const s of stops) s.pos = 1 - s.pos;
    buildActiveParams();
    requestRender();
  }

  function copyAsciiText(btn) {
    const text = RSTR.asciiText;
    if (!text) return; // no ascii render yet — nothing to copy
    const onCopied = () => {
      btn.textContent = 'COPIED';
      setTimeout(() => {
        btn.textContent = 'COPY TEXT';
      }, 1000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onCopied, () => fallbackCopyText(text, onCopied));
    } else {
      fallbackCopyText(text, onCopied);
    }
  }

  // file:// pages can lack a working async Clipboard API — fall back to the
  // classic hidden-textarea + execCommand('copy') trick.
  function fallbackCopyText(text, onCopied) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      if (document.execCommand('copy')) onCopied();
    } catch {
      /* non-fatal — user can still select the button's text manually */
    }
    document.body.removeChild(ta);
  }

  // ---------- scrub bar (shared range control) ----------
  // Full-width horizontal bar: click/drag anywhere = absolute value (pointer
  // capture), wheel = ±step, dblclick = reset. One mechanism for both the PRE
  // block and every effect `range` param (replaced the PRE rotary knobs and
  // the native <input type=range> rows).
  // opts: { label, min, max, step, get, set, format?, reset, snap?, editable? }
  // get() may return null ("value not expressible" — fill pins to 100%, the
  // format() text carries the story); el.sync() repaints from get().
  // snap (opt-in, e.g. 100): MAGNETIC, not rounding — dragging tracks the
  // cursor at full `step` resolution (every intermediate value, e.g. 1234,
  // stays reachable), but a value that lands within SCRUB_MAGNET_TOLERANCE of
  // a multiple of `snap` sticks to that multiple. Wheel/dblclick ignore
  // `snap` entirely (still plain opts.step / opts.reset).
  // editable: click-to-type is the DEFAULT for every scrub (opt OUT with
  // `editable: false`) — click the value readout to swap in a text <input>;
  // Enter/blur commits the typed number, CLAMPED to [min,max] and rounded to
  // the param's own precision (derived from `step`), but NEVER snapped/
  // magnetised (typing is for exact values). Esc cancels. No native prompt().
  // Shift, held while dragging or wheeling, quantizes to 10x `step` — on a
  // `snap` scrub this OVERRIDES the magnet (coarse-and-predictable beats
  // "sticks to the wrong spot").
  const SCRUB_MAGNET_TOLERANCE = 8; // value-units; tuned so e.g. 1234 (34 away
  // from 1200) stays reachable while landing within 8 of a multiple of `snap` sticks.

  function makeScrub(opts) {
    const el = document.createElement('div');
    el.className = 'scrub';
    const fill = document.createElement('div');
    fill.className = 'scrub-fill';
    const lab = document.createElement('span');
    lab.className = 'scrub-label';
    lab.textContent = opts.label;
    const val = document.createElement('span');
    val.className = 'scrub-value';
    el.append(fill, lab, val);

    // Decimal precision implied by `step` (same 3-tier rule renderParamControl
    // uses for display) — governs how a TYPED value is rounded: an integer
    // (step >= 1) param can't end up storing "1.5", a step:0.01 param can.
    function stepDecimals() {
      const step = opts.step || 1;
      if (step >= 1) return 0;
      if (step >= 0.1) return 1;
      return 2;
    }
    function roundTo(v, decimals) {
      const f = Math.pow(10, decimals);
      return Math.round(v * f) / f;
    }
    function quantizeTo(v, stepSize) {
      const steps = Math.round((v - opts.min) / stepSize);
      const q = Math.min(opts.max, Math.max(opts.min, opts.min + steps * stepSize));
      return Math.round(q * 1000) / 1000;
    }
    function quantize(v) {
      return quantizeTo(v, opts.step);
    }
    function clamp(v) {
      return Math.min(opts.max, Math.max(opts.min, v));
    }
    // Magnetic snap: a step-quantized value that lands within tolerance of a
    // multiple of `snap` sticks to it; otherwise passes through untouched —
    // so every step-resolution value in between stays reachable by dragging.
    function magnetize(q) {
      const nearest = clamp(Math.round(q / opts.snap) * opts.snap);
      return Math.abs(q - nearest) <= SCRUB_MAGNET_TOLERANCE ? nearest : q;
    }
    let editing = false;
    let input = null;
    function cancelEditDom() {
      // Tear down the in-progress edit <input> WITHOUT recursing into sync()
      // — sync() itself calls this when state changes out from under an
      // open edit (e.g. a Reset button elsewhere).
      if (!editing) return;
      editing = false;
      if (input) input.remove();
      input = null;
      val.style.display = '';
    }
    function sync() {
      cancelEditDom();
      const v = opts.get();
      const t = v == null ? 1 : (v - opts.min) / (opts.max - opts.min);
      fill.style.width = Math.min(100, Math.max(0, t * 100)) + '%';
      val.textContent = opts.format ? opts.format(v) : String(v);
    }
    // Raw (unquantized) cursor position — the fill's smooth drag position;
    // the committed value is derived from it separately (committedValue).
    function rawFromEvent(e) {
      const rect = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      return opts.min + t * (opts.max - opts.min);
    }
    // The value actually committed for a drag/wheel tick: Shift always wins
    // (coarse 10x-step quantize, overriding any magnet); otherwise a `snap`
    // scrub magnetizes; otherwise plain step quantize.
    function committedValue(raw, shift) {
      if (shift) return quantizeTo(raw, opts.step * 10);
      const q = quantize(raw);
      return opts.snap ? magnetize(q) : q;
    }

    let dragId = null;
    let lastApplied = null;
    // Click-vs-drag on `.scrub-value`: a pointerdown that lands there no
    // longer stops propagation or short-circuits straight into the editor —
    // it arms a normal drag exactly like anywhere else on the bar (pointer
    // capture, dragId, listening for move). The one difference: while the
    // down started ON the readout, the FIRST commit is held back until the
    // pointer actually moves past CLICK_TOLERANCE px, so a plain click never
    // nudges the value out from under the user before the type-in editor
    // opens (Esc would otherwise "cancel" onto a value that already moved).
    // The instant real movement is seen, it graduates to an ordinary drag —
    // same position-to-value mapping as the rest of the bar from then on.
    // A pointerdown that starts elsewhere on the bar is untouched: it still
    // commits immediately, same as always.
    // (Previously the readout stopped propagation on its OWN pointerdown so
    // `el`'s drag handler never saw the event and a drag could never start
    // there — that made the rightmost ~25% of every scrub's range, where the
    // readout sits, unreachable by dragging.)
    const CLICK_TOLERANCE = 3; // px
    let pendingValueClick = false; // down started on .scrub-value, still within click tolerance
    let downX = 0;
    let downY = 0;
    function applyDrag(e) {
      const raw = rawFromEvent(e);
      const v = committedValue(raw, e.shiftKey);
      if (v !== lastApplied) {
        lastApplied = v;
        opts.set(v);
      }
      // The fill glides at full (raw) resolution only while magnetizing
      // (snap active, no Shift) so the pull toward a magnet is visible;
      // every other mode (plain step, Shift-coarse) shows the fill at the
      // committed value, same as any other scrub.
      const fillVal = opts.snap && !e.shiftKey ? raw : v;
      const t = (fillVal - opts.min) / (opts.max - opts.min);
      fill.style.width = Math.min(100, Math.max(0, t * 100)) + '%';
      val.textContent = opts.format ? opts.format(v) : String(v);
    }
    el.addEventListener('pointerdown', (e) => {
      if (editing) return; // let the edit <input> handle its own clicks
      el.setPointerCapture(e.pointerId);
      dragId = e.pointerId;
      lastApplied = null;
      downX = e.clientX;
      downY = e.clientY;
      if (opts.editable !== false && e.target === val) {
        pendingValueClick = true; // hold off committing until we know it's a drag, not a click
      } else {
        pendingValueClick = false;
        applyDrag(e);
      }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      if (pendingValueClick) {
        const moved = Math.abs(e.clientX - downX) > CLICK_TOLERANCE || Math.abs(e.clientY - downY) > CLICK_TOLERANCE;
        if (!moved) return; // still could be a click — don't touch the value yet
        pendingValueClick = false; // graduated to a real drag
      }
      applyDrag(e);
    });
    function settleDrag(e) {
      if (dragId !== e.pointerId) return false;
      dragId = null;
      sync(); // settle the fill exactly onto the committed value
      return true;
    }
    el.addEventListener('pointerup', (e) => {
      const wasPendingValueClick = pendingValueClick;
      pendingValueClick = false;
      if (settleDrag(e) && wasPendingValueClick) startEdit(); // released before it ever became a drag: a real click
    });
    el.addEventListener('pointercancel', (e) => {
      pendingValueClick = false;
      settleDrag(e);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (editing) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        const stepSize = e.shiftKey ? opts.step * 10 : opts.step;
        const cur = opts.get();
        opts.set(quantizeTo((cur == null ? opts.min : cur) + dir * stepSize, stepSize));
        sync();
      },
      { passive: false }
    );
    el.addEventListener('dblclick', () => {
      if (editing) return;
      opts.set(opts.reset);
      sync();
    });

    // ---- click-to-type readout (default for every scrub; opt out with editable:false) ----
    function endEdit(commit) {
      if (!editing) return;
      const raw = commit ? Number(input.value) : NaN;
      cancelEditDom();
      if (commit && !Number.isNaN(raw)) opts.set(clamp(roundTo(raw, stepDecimals()))); // typed: clamp + round to precision, never snap
      sync();
    }
    // Opens the type-in editor. Invoked from the shared pointerup handler
    // above (a no-movement release that started on `.scrub-value`) instead
    // of a `click` listener — that's what lets a drag starting on the
    // readout win whenever the pointer actually moves.
    function startEdit() {
      if (editing) return;
      editing = true;
      val.style.display = 'none';
      input = document.createElement('input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.className = 'scrub-edit-input';
      const cur = opts.get();
      input.value = cur == null ? '' : String(roundTo(cur, stepDecimals()));
      el.appendChild(input);
      input.focus();
      input.select();
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      input.addEventListener('wheel', (ev) => ev.stopPropagation());
      input.addEventListener('dblclick', (ev) => ev.stopPropagation());
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') {
          ev.preventDefault();
          endEdit(true);
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          endEdit(false);
        }
      });
      input.addEventListener('blur', () => endEdit(true));
    }
    if (opts.editable !== false) {
      // .scrub-value is `pointer-events: none` by default (CSS, shared by
      // every scrub) so clicks/drags pass through to the bar underneath —
      // opt back in ONLY here, scoped to this instance via inline style, so
      // this element hit-tests as the drag/click origin (`e.target === val`
      // above) and shows a text cursor. It no longer owns its own
      // pointerdown/click handlers.
      val.style.pointerEvents = 'auto';
      val.style.cursor = 'text';
    }

    el.sync = sync;
    sync();
    return el;
  }

  function renderParamControl(param, params) {
    // Gradient stops: a variable-length array value, never a single scalar —
    // built as its own block (not the label+single-control `.param-row`
    // pattern below) because it hosts several interactive children (canvas,
    // flag markers, swatch button, delete button). Wrapping that in a
    // <label> risks the browser's implicit "click label -> activate first
    // labelable descendant" forwarding firing on the WRONG child.
    if (param.type === 'stops') return buildStopsControl(param, params);

    if (param.type === 'range') {
      const step = param.step != null ? param.step : 1;
      const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
      return makeScrub({
        label: param.label,
        min: param.min,
        max: param.max,
        step,
        get: () => (params[param.key] != null ? params[param.key] : param.default),
        set: (v) => {
          params[param.key] = v;
          requestRender();
        },
        format: (v) => Number(v).toFixed(decimals),
        reset: param.default,
      });
    }

    const row = document.createElement('label');
    row.className = 'param-row';

    const labelText = document.createElement('span');
    labelText.className = 'param-label';
    labelText.textContent = param.label;
    row.appendChild(labelText);

    const current = params[param.key] != null ? params[param.key] : param.default;

    if (param.type === 'color') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch-btn';
      const box = document.createElement('span');
      box.className = 'color-swatch-box';
      box.style.background = current;
      const label = document.createElement('span');
      label.className = 'color-swatch-label';
      label.textContent = current;
      btn.append(box, label);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const value = params[param.key] != null ? params[param.key] : param.default;
        RSTR.ui.openColorPicker(btn, value, (hex) => {
          params[param.key] = hex;
          box.style.background = hex;
          label.textContent = hex;
          requestRender();
        });
      });
      row.appendChild(btn);
    } else if (param.type === 'select') {
      const select = document.createElement('select');
      for (const opt of param.options) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        if (String(opt.value) === String(current)) o.selected = true;
        select.appendChild(o);
      }
      select.addEventListener('change', () => {
        params[param.key] = Number(select.value);
        // If other params show/hide based on THIS select (e.g. dots' `mode`),
        // rebuild the panel so the visible param set updates immediately.
        const def = RSTR.getEffect(currentEffectId());
        if (def.params.some((p) => p.showIf && p.showIf.key === param.key)) {
          buildActiveParams();
        }
        requestRender();
      });
      row.appendChild(select);
    } else if (param.type === 'text') {
      // Free-text param (e.g. ascii's character set) — reaches cpu stages only,
      // never becomes a uniform, so the value must stay a string (no Number()).
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = current;
      input.style.flex = '1';
      input.style.minWidth = '0';
      input.addEventListener('input', () => {
        params[param.key] = input.value;
        requestRender();
      });
      row.appendChild(input);
    }
    return row;
  }

  // ---------- gradient stops (Figma-style) — gradientmap's `stops` param ----------
  // Defensive repair: params[key] should already be a valid >=2-entry stops
  // array by the time a settings panel is built (RSTR.defaultParams clones the
  // registry default; applySelectedPreset/validatePreset sanitize presets and
  // pasted style codes) — this is a last-resort guard against any path that
  // slips through, not the primary sanitizer.
  function ensureStopsArray(param, params) {
    const raw = params[param.key];
    const valid =
      Array.isArray(raw) &&
      raw.length >= 2 &&
      raw.every((s) => s && typeof s.pos === 'number' && typeof s.color === 'string');
    if (!valid) params[param.key] = JSON.parse(JSON.stringify(param.default));
    return params[param.key];
  }

  function buildStopsControl(param, params) {
    ensureStopsArray(param, params);
    const getStops = () => params[param.key];
    const gmDef = RSTR.getEffect('gradientmap');

    const wrap = document.createElement('div');
    wrap.className = 'param-row-stops';

    const labelRow = document.createElement('div');
    labelRow.className = 'stops-label-row';
    const labelText = document.createElement('span');
    labelText.className = 'param-label';
    labelText.textContent = param.label;
    labelRow.appendChild(labelText);
    wrap.appendChild(labelRow);

    // Gradient bar: painted from the LUT (RSTR.getEffect('gradientmap').buildLut) —
    // same interpolation the cpu() render stage uses, so the preview never drifts
    // from the actual output. Fixed 256px internal resolution == the LUT's own
    // resolution (CSS stretches it to the panel's full width; content may be
    // colorful, the chrome around it stays grayscale/1px/square).
    const barWrap = document.createElement('div');
    barWrap.className = 'stops-bar-wrap';
    const bar = document.createElement('canvas');
    bar.className = 'stops-bar';
    bar.width = 256;
    bar.height = 24;
    barWrap.appendChild(bar);
    const track = document.createElement('div');
    track.className = 'stops-flags-track';
    barWrap.appendChild(track);
    wrap.appendChild(barWrap);

    const selRow = document.createElement('div');
    selRow.className = 'stops-selected-row';
    const swatchBtn = document.createElement('button');
    swatchBtn.type = 'button';
    swatchBtn.className = 'color-swatch-btn';
    const swatchBox = document.createElement('span');
    swatchBox.className = 'color-swatch-box';
    const swatchLabel = document.createElement('span');
    swatchLabel.className = 'color-swatch-label';
    swatchBtn.append(swatchBox, swatchLabel);
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'stops-del-btn';
    delBtn.textContent = 'DEL STOP';
    selRow.append(swatchBtn, delBtn);
    wrap.appendChild(selRow);

    let selectedIndex = 0;
    const ctx = bar.getContext('2d');

    function paintBar() {
      const lut = gmDef.buildLut(getStops());
      const img = ctx.createImageData(bar.width, bar.height);
      for (let x = 0; x < bar.width; x++) {
        const r = lut[x * 3];
        const g = lut[x * 3 + 1];
        const b = lut[x * 3 + 2];
        for (let y = 0; y < bar.height; y++) {
          const o = (y * bar.width + x) * 4;
          img.data[o] = r;
          img.data[o + 1] = g;
          img.data[o + 2] = b;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    // Cheap in-place visual update (no DOM rebuild) — selection changes during
    // a drag must never rebuild `track`, or the flag under active pointer
    // capture would be disconnected and the drag would silently die.
    function updateSelectedClasses() {
      Array.from(track.children).forEach((el, i) => el.classList.toggle('selected', i === selectedIndex));
    }

    function refreshSelectedRow() {
      const stops = getStops();
      const s = stops[selectedIndex] || stops[0];
      swatchBox.style.background = s.color;
      swatchLabel.textContent = s.color;
      delBtn.disabled = stops.length <= 2;
    }

    function selectStop(i) {
      selectedIndex = i;
      updateSelectedClasses();
      refreshSelectedRow();
    }

    // Minimum 2 stops — no-op (button disabled / Delete key silently ignored)
    // when only 2 remain.
    function removeStop(i) {
      const stops = getStops();
      if (stops.length <= 2) return;
      stops.splice(i, 1);
      selectedIndex = Math.max(0, Math.min(selectedIndex, stops.length - 1));
      paintBar();
      paintFlags();
      refreshSelectedRow();
      requestRender();
    }

    // Horizontal pointer-capture drag along the bar (same pattern as the PRE
    // module's black/white-point handles, wireHandle() above) — stops MAY
    // cross each other; evaluation (buildLut) always sorts a COPY, so crossing
    // is never forbidden or resolved here, only clamped to 0..1.
    function wireFlag(flag, i) {
      let dragId = null;
      flag.addEventListener('pointerdown', (e) => {
        flag.setPointerCapture(e.pointerId);
        dragId = e.pointerId;
        selectStop(i);
        e.preventDefault();
        e.stopPropagation();
      });
      flag.addEventListener('pointermove', (e) => {
        if (dragId !== e.pointerId) return;
        const rect = bar.getBoundingClientRect();
        const t = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
        const pos = Math.round(t * 1000) / 1000;
        getStops()[i].pos = pos;
        flag.style.left = pos * 100 + '%'; // in-place — no track rebuild mid-drag
        paintBar();
        requestRender();
      });
      const release = (e) => {
        if (dragId === e.pointerId) dragId = null;
      };
      flag.addEventListener('pointerup', release);
      flag.addEventListener('pointercancel', release);
      // Delete/Backspace scoped to the flag element itself (focusable via
      // tabIndex) rather than a document-level listener — so there is nothing
      // to leak/unwire when the settings panel later rebuilds and this flag
      // is discarded.
      flag.tabIndex = 0;
      flag.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeStop(i);
        }
      });
      flag.addEventListener('dblclick', (e) => {
        // don't let a dblclick on an existing flag fall through to the bar's
        // "add a stop here" handler below.
        e.stopPropagation();
      });
    }

    // Full rebuild of the flag markers — only called for discrete add/remove/
    // init, never mid-drag (see wireFlag's pointermove, which mutates the
    // existing flag's style.left in place instead).
    function paintFlags() {
      track.innerHTML = '';
      getStops().forEach((s, i) => {
        const flag = document.createElement('div');
        flag.className = 'stop-flag' + (i === selectedIndex ? ' selected' : '');
        flag.style.left = s.pos * 100 + '%';
        wireFlag(flag, i);
        track.appendChild(flag);
      });
    }

    // Double-click an empty spot on the bar = add a stop there, seeded with
    // the color the gradient currently shows at that x (an exact LUT sample).
    bar.addEventListener('dblclick', (e) => {
      const rect = bar.getBoundingClientRect();
      const t = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
      const lut = gmDef.buildLut(getStops());
      const idx = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
      const hex =
        '#' +
        [lut[idx], lut[idx + 1], lut[idx + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      const stops = getStops();
      stops.push({ pos: Math.round(t * 1000) / 1000, color: hex });
      selectedIndex = stops.length - 1;
      paintFlags();
      refreshSelectedRow();
      requestRender();
    });

    swatchBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = selectedIndex;
      const stops = getStops();
      RSTR.ui.openColorPicker(swatchBtn, stops[idx].color, (hex) => {
        stops[idx].color = hex;
        refreshSelectedRow();
        paintBar();
        requestRender();
      });
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeStop(selectedIndex);
    });

    paintBar();
    paintFlags();
    refreshSelectedRow();

    return wrap;
  }

  // ---------- shared color picker (brutalist HSV popover) ----------
  // A singleton popover, built once and appended directly to #panel (NOT
  // inside #active-params), so a settings-panel rebuild never orphans it —
  // it lives outside the container that gets torn down. buildEditor() /
  // buildActiveParams() close it proactively before any such rebuild; the
  // picker's own live onChange never triggers a rebuild, so dragging keeps
  // working uninterrupted. Reused by any 'color' param row today; exposed as
  // RSTR.ui.openColorPicker(anchorEl, hex, onChange) so a future control
  // (e.g. gradient stops) can call the same picker.
  //
  // Pure hex <-> hsv helpers (no DOM/state) — reusable on their own.
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function normalizeHex(input) {
    let s = String(input == null ? '' : input).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return '#' + s.toLowerCase();
  }
  function hexToRgb(hex) {
    const n = normalizeHex(hex) || '#000000';
    const v = parseInt(n.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }
  function rgbToHex(r, g, b) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
  }
  function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
  }
  function hexToHsv(hex) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHsv(r, g, b);
  }
  function hsvToHex(h, s, v) {
    const { r, g, b } = hsvToRgb(h, s, v);
    return rgbToHex(r, g, b);
  }

  // singleton popover state — built lazily on first open()
  const cp = { built: false, hsv: { h: 0, s: 0, v: 1 }, onChange: null, anchor: null, svW: 148, svH: 148, hueW: 148, hueH: 14 };

  function buildColorPicker() {
    if (cp.built) return;
    const pop = document.createElement('div');
    pop.id = 'color-picker-popover';

    const svWrap = document.createElement('div');
    svWrap.className = 'cp-sv-wrap';
    const svCanvas = document.createElement('canvas');
    svCanvas.className = 'cp-sv-canvas';
    svCanvas.width = cp.svW;
    svCanvas.height = cp.svH;
    const svCursor = document.createElement('div');
    svCursor.className = 'cp-marker';
    svWrap.append(svCanvas, svCursor);

    const hueWrap = document.createElement('div');
    hueWrap.className = 'cp-hue-wrap';
    const hueCanvas = document.createElement('canvas');
    hueCanvas.className = 'cp-hue-canvas';
    hueCanvas.width = cp.hueW;
    hueCanvas.height = cp.hueH;
    const hueCursor = document.createElement('div');
    hueCursor.className = 'cp-marker';
    hueWrap.append(hueCanvas, hueCursor);

    const hexRow = document.createElement('div');
    hexRow.className = 'cp-hex-row';
    const hexPreview = document.createElement('span');
    hexPreview.className = 'cp-hex-preview';
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.className = 'cp-hex-input';
    hexInput.spellcheck = false;
    hexRow.append(hexPreview, hexInput);

    pop.append(svWrap, hueWrap, hexRow);
    els.panel.appendChild(pop);

    cp.pop = pop;
    cp.svCanvas = svCanvas;
    cp.svCtx = svCanvas.getContext('2d');
    cp.svCursor = svCursor;
    cp.hueCanvas = hueCanvas;
    cp.hueCtx = hueCanvas.getContext('2d');
    cp.hueCursor = hueCursor;
    cp.hexInput = hexInput;
    cp.hexPreview = hexPreview;
    cp.built = true;

    wireColorPickerDrag();
  }

  function paintSV() {
    const { h } = cp.hsv;
    const img = cp.svCtx.createImageData(cp.svW, cp.svH);
    for (let y = 0; y < cp.svH; y++) {
      const v = 1 - y / (cp.svH - 1);
      for (let x = 0; x < cp.svW; x++) {
        const s = x / (cp.svW - 1);
        const { r, g, b } = hsvToRgb(h, s, v);
        const i = (y * cp.svW + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    cp.svCtx.putImageData(img, 0, 0);
  }

  function paintHue() {
    const img = cp.hueCtx.createImageData(cp.hueW, cp.hueH);
    for (let x = 0; x < cp.hueW; x++) {
      const h = (x / (cp.hueW - 1)) * 360;
      const { r, g, b } = hsvToRgb(h, 1, 1);
      for (let y = 0; y < cp.hueH; y++) {
        const i = (y * cp.hueW + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    cp.hueCtx.putImageData(img, 0, 0);
  }

  function syncColorPickerUI() {
    const { h, s, v } = cp.hsv;
    cp.svCursor.style.left = s * cp.svW + 'px';
    cp.svCursor.style.top = (1 - v) * cp.svH + 'px';
    cp.hueCursor.style.left = (h / 360) * cp.hueW + 'px';
    cp.hueCursor.style.top = cp.hueH / 2 + 'px';
    const hex = hsvToHex(h, s, v);
    cp.hexInput.value = hex;
    cp.hexPreview.style.background = hex;
  }

  function emitColorChange() {
    const { h, s, v } = cp.hsv;
    if (cp.onChange) cp.onChange(hsvToHex(h, s, v));
  }

  function wireColorPickerDrag() {
    function svFromEvent(e) {
      const rect = cp.svCanvas.getBoundingClientRect();
      cp.hsv.s = clamp01((e.clientX - rect.left) / rect.width);
      cp.hsv.v = 1 - clamp01((e.clientY - rect.top) / rect.height);
    }
    let svDrag = null;
    cp.svCanvas.addEventListener('pointerdown', (e) => {
      cp.svCanvas.setPointerCapture(e.pointerId);
      svDrag = e.pointerId;
      svFromEvent(e);
      syncColorPickerUI();
      emitColorChange();
    });
    cp.svCanvas.addEventListener('pointermove', (e) => {
      if (svDrag !== e.pointerId) return;
      svFromEvent(e);
      syncColorPickerUI();
      emitColorChange();
    });
    const svRelease = (e) => { if (svDrag === e.pointerId) svDrag = null; };
    cp.svCanvas.addEventListener('pointerup', svRelease);
    cp.svCanvas.addEventListener('pointercancel', svRelease);

    function hueFromEvent(e) {
      const rect = cp.hueCanvas.getBoundingClientRect();
      cp.hsv.h = clamp01((e.clientX - rect.left) / rect.width) * 360;
    }
    let hueDrag = null;
    cp.hueCanvas.addEventListener('pointerdown', (e) => {
      cp.hueCanvas.setPointerCapture(e.pointerId);
      hueDrag = e.pointerId;
      hueFromEvent(e);
      paintSV();
      syncColorPickerUI();
      emitColorChange();
    });
    cp.hueCanvas.addEventListener('pointermove', (e) => {
      if (hueDrag !== e.pointerId) return;
      hueFromEvent(e);
      paintSV();
      syncColorPickerUI();
      emitColorChange();
    });
    const hueRelease = (e) => { if (hueDrag === e.pointerId) hueDrag = null; };
    cp.hueCanvas.addEventListener('pointerup', hueRelease);
    cp.hueCanvas.addEventListener('pointercancel', hueRelease);

    function commitHexInput() {
      const norm = normalizeHex(cp.hexInput.value);
      if (!norm) {
        cp.hexInput.value = hsvToHex(cp.hsv.h, cp.hsv.s, cp.hsv.v); // invalid — restore, no-op
        return;
      }
      cp.hsv = hexToHsv(norm);
      paintSV();
      syncColorPickerUI();
      emitColorChange();
    }
    cp.hexInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commitHexInput();
        cp.hexInput.blur();
      }
    });
    cp.hexInput.addEventListener('blur', commitHexInput);

    // outside pointerdown / Esc closes — ignore clicks inside the popover or on its own anchor
    document.addEventListener('pointerdown', (e) => {
      if (!cp.pop || cp.pop.style.display === 'none') return;
      if (cp.pop.contains(e.target) || e.target === cp.anchor) return;
      closeColorPicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cp.pop && cp.pop.style.display !== 'none') closeColorPicker();
    });
  }

  // Position relative to #panel (position:relative); opens upward if it
  // would clip the viewport bottom.
  function positionColorPicker(anchorEl) {
    cp.pop.style.visibility = 'hidden';
    cp.pop.style.display = 'block';
    const panelRect = els.panel.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popW = cp.pop.offsetWidth;
    const popH = cp.pop.offsetHeight;
    let left = anchorRect.left - panelRect.left;
    left = Math.max(4, Math.min(left, panelRect.width - popW - 4));
    let top;
    if (anchorRect.bottom + popH + 6 > window.innerHeight) {
      top = anchorRect.top - panelRect.top - popH - 4; // clips bottom -> open upward
    } else {
      top = anchorRect.bottom - panelRect.top + 4;
    }
    cp.pop.style.left = left + 'px';
    cp.pop.style.top = top + 'px';
    cp.pop.style.visibility = '';
  }

  function openColorPicker(anchorEl, hex, onChange) {
    buildColorPicker();
    cp.anchor = anchorEl;
    cp.onChange = onChange;
    cp.hsv = hexToHsv(hex);
    paintHue();
    paintSV();
    syncColorPickerUI();
    positionColorPicker(anchorEl);
  }

  function closeColorPicker() {
    if (cp.pop) cp.pop.style.display = 'none';
    cp.anchor = null;
    cp.onChange = null;
  }

  // ---------- per-effect param-presets — expandable modal ----------
  // Replaces the old cramped footer `#preset-row` (select + Save + Del) with
  // a PRESETS button that opens a brutalist overlay: registry presets + user
  // presets as clickable rows (apply on click), Save (via the shared
  // #inline-input widget) and per-row Del live in the modal. No native
  // alert/confirm/prompt anywhere.
  function buildPresetsModalList() {
    const def = RSTR.getEffect(currentEffectId());
    els.presetsModalTitle.textContent = 'Presets · ' + def.name;
    const list = els.presetsList;
    list.innerHTML = '';

    const makeRow = (label, onClick) => {
      const row = document.createElement('div');
      row.className = 'presets-row';
      const name = document.createElement('span');
      name.className = 'presets-row-name';
      name.textContent = label;
      row.appendChild(name);
      row.addEventListener('click', onClick);
      return row;
    };

    list.appendChild(makeRow('(default)', () => applyPresetByValue('__default__')));

    for (const p of builtinPresets(def)) {
      list.appendChild(makeRow(p.name, () => applyPresetByValue('b:' + p.name)));
    }

    const user = RSTR.preset.loadEffectPresets(def.id);
    for (const name of Object.keys(user)) {
      const row = makeRow(name + ' *', () => applyPresetByValue('u:' + name));
      const del = iconButton('✕', 'Delete preset', () => {
        RSTR.preset.deleteEffectPreset(def.id, name);
        showToast(`Deleted preset "${name}"`);
        buildPresetsModalList();
      });
      row.appendChild(del);
      list.appendChild(row);
    }
  }

  function applyPresetByValue(val) {
    const def = RSTR.getEffect(currentEffectId());
    let params;
    if (val === '__default__') {
      params = RSTR.defaultParams(def.id);
    } else if (val.slice(0, 2) === 'b:') {
      const found = builtinPresets(def).find((p) => p.name === val.slice(2));
      params = found ? cloneParamsBag(found.params) : RSTR.defaultParams(def.id);
    } else {
      const user = RSTR.preset.loadEffectPresets(def.id);
      params = cloneParamsBag(user[val.slice(2)]);
    }
    setCurrentParams(params);
    buildActiveParams();
    requestRender();
    closePresetsModal();
  }

  function openPresetsModal() {
    if (state.editTarget.kind === 'output') return;
    buildPresetsModalList();
    els.presetsBackdrop.style.display = 'block';
    els.presetsModal.style.display = 'flex';
  }

  function closePresetsModal() {
    if (!els.presetsBackdrop) return; // not booted yet
    els.presetsBackdrop.style.display = 'none';
    els.presetsModal.style.display = 'none';
  }

  function saveCurrentPresetFlow() {
    const def = RSTR.getEffect(currentEffectId());
    openInline(`Save "${def.name}" preset as…`, '', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      RSTR.preset.saveEffectPreset(def.id, name, currentParams());
      showToast(`Saved preset "${name}"`);
      buildPresetsModalList();
      return null;
    });
  }

  // Shallow-spreading a params bag ({ ...params }) only copies the top-level
  // keys — an array/object VALUE (e.g. gradientmap's `stops`) stays the same
  // reference. `found.params` below (a builtin preset) is a literal living in
  // the EFFECTS registry, shared forever across the whole session: without a
  // deep clone here, dragging/adding/removing a stop on a layer that applied
  // "Duotone" would mutate the registry's OWN "Duotone" preset, corrupting it
  // for every other layer that ever applies it again.
  function cloneParamsBag(o) {
    const out = {};
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      out[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
    return out;
  }

  // ---------- ADD (NEW mode only) ----------
  function addToMix() {
    if (state.editTarget.kind !== 'new') return;
    const effectId = state.editTarget.effect;
    // Bake the pending PRE into the mix as its own layer, glued right under
    // the effect it was dialed in for, then reset the PRE working buffer —
    // the settings "leave" with the committed layer.
    for (const l of preLayer()) state.mix.push({ ...l, params: { ...l.params } });
    state.pre = RSTR.preset.defaultPre();
    state.mix.push({ effect: effectId, enabled: true, params: { ...state.editTarget.params } });
    // Jump straight to EDIT on the committed layer — staying in NEW mode would
    // keep the picked effect previewed ON TOP of the layer just added, i.e.
    // the effect applied twice until the user clicks elsewhere.
    selectLayer(state.mix.length - 1);
    syncPreUI();
    showToast(`Added ${RSTR.getEffect(effectId).name} to mix`);
  }

  // ---------- mix stack (pinned OUTPUT + effect layers) ----------
  function iconButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // Layer-level opacity lives on the mix row itself (not the edit panel) —
  // read/write straight through to the layer object. `opacity` is only
  // present on a layer once dialed below 100%, see preset.js.
  function mixLayerOpacity(index) {
    const v = state.mix[index].opacity;
    return v != null ? v : 1;
  }
  function setMixLayerOpacity(index, v) {
    state.mix[index].opacity = v;
  }

  // Layer-level blend mode — same reasoning as opacity above: it's a
  // property of the LAYER (how it composites into the stack), not of the
  // effect, so it lives on the mix row, not the edit panel. `blend` is only
  // present on a layer once it's not 'normal', see preset.js.
  function mixLayerBlend(index) {
    return state.mix[index].blend || 'normal';
  }
  function setMixLayerBlend(index, v) {
    state.mix[index].blend = v;
  }

  // Layer-level MASK flag — presence of `mask` on the layer object IS the
  // flag (no nested `enabled`), same convention src/preset.js's
  // normalizeMask uses for serialization. A mask layer is never composited;
  // see src/pipeline.js render() and this file's computeMaskInfo() below for
  // which OTHER row it feeds.
  function mixLayerMaskOn(index) {
    const m = state.mix[index].mask;
    return !!(m && typeof m === 'object');
  }
  function mixLayerMaskInvert(index) {
    const m = state.mix[index].mask;
    return !!(m && m.invert === true);
  }
  function setMixLayerMask(index, on) {
    if (on) state.mix[index].mask = { invert: mixLayerMaskInvert(index) }; // preserve a prior invert choice if re-toggled
    else delete state.mix[index].mask;
  }
  function setMixLayerMaskInvert(index, invert) {
    if (!state.mix[index].mask) state.mix[index].mask = {};
    state.mix[index].mask.invert = !!invert;
  }

  // Mirrors src/pipeline.js render()'s mask-consumption rule exactly, over
  // state.mix, so the LAYERS panel can show which row is being masked (and
  // which mask rows are dead weight) without re-deriving the logic. Walking
  // only the ENABLED layers (matching the pipeline's own `enabled` filter):
  // a mask layer's flag applies to the next enabled, non-mask layer
  // (`targets`); two masks in a row -> the earlier one is superseded, and a
  // trailing mask with nothing after it is never consumed -- both land in
  // `noop` (the UI's "no target" marker, see buildMixList).
  function computeMaskInfo() {
    const targets = new Set();
    const noop = new Set();
    let pendingIndex = -1;
    state.mix.forEach((step, index) => {
      if (step.enabled === false) return;
      if (mixLayerMaskOn(index)) {
        if (pendingIndex >= 0) noop.add(pendingIndex); // superseded by this later mask
        pendingIndex = index;
      } else if (pendingIndex >= 0) {
        targets.add(index);
        pendingIndex = -1;
      }
    });
    if (pendingIndex >= 0) noop.add(pendingIndex); // trailing mask, nothing after it
    return { targets, noop };
  }

  // Source (pinned "◇ ORIGINAL" row) opacity — same read/write-straight-
  // through shape as mixLayerOpacity above, just on state.source instead of
  // a mix layer (there's only ever one).
  function sourceOpacity() {
    const v = state.source.opacity;
    return v != null ? v : 1;
  }
  function setSourceOpacity(v) {
    state.source.opacity = v;
  }

  // ---------- blend-mode dropdown (custom popover — live preview on hover) ----------
  // A native <select> can't do this: the browser owns the option popup and
  // fires no hover events on <option>s. Brutalist replacement — 1px-bordered
  // rows, same grouping the old <optgroup>s gave — that previews a blend
  // mode on the canvas the instant you hover a row, and reverts the instant
  // you leave without clicking. Singleton popover (same idiom as the HSV
  // color picker above: built once, re-targeted per open, appended to
  // #panel so a buildMixList() rebuild of the row underneath never orphans
  // it while it's open).
  const bd = {
    built: false,
    open: false,
    pop: null,
    rows: [], // [{ id, el }] flat, in RSTR.preset.BLEND_MODES order
    anchor: null,
    committed: 'normal', // the value to revert to on Esc/outside-click/mouse-away
    highlighted: 'normal',
    previewed: false, // true once a hover/key actually mutated live state — guards
    // against a stray commit-string ('normal') write when the user opens and
    // closes the dropdown without ever touching a row.
    onPreview: null, // (id) => void — mutate live state + requestRender(), never persists
    onCommit: null, // (id) => void — mutate live state + requestRender() + refresh label
  };

  function blendLabel(id) {
    const m = RSTR.preset.BLEND_MODES.find((x) => x.id === id);
    return m ? m.label : id;
  }

  function setBlendHighlight(id) {
    bd.highlighted = id;
    for (const r of bd.rows) r.el.classList.toggle('highlighted', r.id === id);
  }

  function previewBlendRow(id) {
    setBlendHighlight(id);
    bd.previewed = true;
    if (bd.onPreview) bd.onPreview(id);
  }

  function commitBlendRow(id) {
    bd.committed = id;
    if (bd.onCommit) bd.onCommit(id);
    closeBlendDropdown(false);
  }

  function moveBlendHighlight(delta) {
    const ids = bd.rows.map((r) => r.id);
    let idx = ids.indexOf(bd.highlighted);
    if (idx < 0) idx = ids.indexOf(bd.committed);
    idx = Math.max(0, Math.min(ids.length - 1, idx + delta));
    previewBlendRow(ids[idx]);
    bd.rows[idx].el.scrollIntoView({ block: 'nearest' });
  }

  function buildBlendDropdown() {
    if (bd.built) return;
    const pop = document.createElement('div');
    pop.id = 'blend-dd-popover';
    els.panel.appendChild(pop);
    bd.pop = pop;
    bd.built = true;

    let currentGroup; // undefined sentinel; BLEND_MODES' first entry has group ''
    for (const m of RSTR.preset.BLEND_MODES) {
      if (m.group !== currentGroup) {
        currentGroup = m.group;
        if (m.group) {
          const label = document.createElement('div');
          label.className = 'blend-dd-group';
          label.textContent = m.group;
          pop.appendChild(label);
        }
      }
      const row = document.createElement('div');
      row.className = 'blend-dd-row';
      row.textContent = m.label;
      row.addEventListener('pointerenter', () => previewBlendRow(m.id));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        commitBlendRow(m.id);
      });
      pop.appendChild(row);
      bd.rows.push({ id: m.id, el: row });
    }

    // Leaving the whole menu (pointerleave doesn't fire when moving between
    // child rows, only when the pointer actually exits the popover) with
    // nothing clicked = revert the live preview to the committed mode; the
    // menu itself stays open — only Esc/outside-click closes it.
    pop.addEventListener('pointerleave', () => {
      if (!bd.open) return;
      setBlendHighlight(bd.committed);
      if (bd.previewed) bd.onPreview(bd.committed);
    });

    // Singleton document listeners, wired once — gated on bd.open so they're
    // no-ops the rest of the time (same pattern as the color picker's).
    document.addEventListener('pointerdown', (e) => {
      if (!bd.open) return;
      if (bd.pop.contains(e.target) || e.target === bd.anchor) return;
      closeBlendDropdown(true);
    });
    document.addEventListener('keydown', (e) => {
      if (!bd.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeBlendDropdown(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveBlendHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveBlendHighlight(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commitBlendRow(bd.highlighted);
      }
    });
  }

  // Position relative to #panel — same anchoring convention as
  // positionColorPicker: opens below the trigger, flips upward if it would
  // clip the viewport bottom.
  function positionBlendDropdown(anchorEl) {
    bd.pop.style.visibility = 'hidden';
    bd.pop.style.display = 'block';
    const panelRect = els.panel.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popW = bd.pop.offsetWidth;
    const popH = bd.pop.offsetHeight;
    let left = anchorRect.left - panelRect.left;
    left = Math.max(4, Math.min(left, panelRect.width - popW - 4));
    let top;
    if (anchorRect.bottom + popH + 6 > window.innerHeight) {
      top = anchorRect.top - panelRect.top - popH - 4; // clips bottom -> open upward
    } else {
      top = anchorRect.bottom - panelRect.top + 4;
    }
    bd.pop.style.left = left + 'px';
    bd.pop.style.top = top + 'px';
    bd.pop.style.visibility = '';
  }

  function openBlendDropdown(anchorEl, currentId, onPreview, onCommit) {
    buildBlendDropdown();
    bd.anchor = anchorEl;
    bd.committed = currentId;
    bd.previewed = false;
    bd.onPreview = onPreview;
    bd.onCommit = onCommit;
    bd.open = true;
    anchorEl.classList.add('open');
    setBlendHighlight(currentId);
    positionBlendDropdown(anchorEl);
  }

  function closeBlendDropdown(revert) {
    if (!bd.open) return;
    bd.open = false;
    // Only touch live state if a preview actually ran — opening and closing
    // without ever hovering a row must leave state byte-for-byte untouched.
    if (revert && bd.previewed && bd.onPreview) bd.onPreview(bd.committed);
    bd.pop.style.display = 'none';
    if (bd.anchor) bd.anchor.classList.remove('open');
    bd.anchor = null;
    bd.onPreview = null;
    bd.onCommit = null;
    bd.previewed = false;
  }

  // Per-row trigger button — replaces the old native <select>. get/set
  // follow the same closure idiom as the opacity scrub below.
  function makeBlendControl(getValue, setValue) {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mix-blend blend-dd-trigger';
    trigger.title = 'Blend mode';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'blend-dd-label';
    const caret = document.createElement('span');
    caret.className = 'blend-dd-caret';
    caret.textContent = '▾';
    trigger.append(labelSpan, caret);

    function refresh() {
      labelSpan.textContent = blendLabel(getValue());
    }
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (bd.open && bd.anchor === trigger) {
        closeBlendDropdown(true);
        return;
      }
      openBlendDropdown(
        trigger,
        getValue(),
        (id) => {
          setValue(id);
          requestRender();
        },
        (id) => {
          setValue(id);
          requestRender();
          refresh();
        }
      );
    });
    refresh();
    trigger.refresh = refresh;
    return trigger;
  }

  // ---------- LAYERS drag-to-reorder (native HTML5 DnD, same idiom as the
  // /Effects list above: a 1px insertion line via .drop-before/.drop-after,
  // no library) ----------
  // 2026-07-13 (user feedback): the whole row is the drag SOURCE now, not a
  // dedicated grip — a mix row still carries several of its own interactive
  // children (eye toggle, ✕, MASK/INV, the blend trigger, the opacity scrub
  // — itself a click-drag control) that need ordinary mousedown/click
  // behavior, not a hijacked native drag. Solved generically, not with
  // per-control hacks: wireMixRowDragToggle() below flips `row.draggable`
  // off while the pointer is down over one of them (closest() against one
  // selector list) and restores it on release — see its own comment for why
  // capture phase matters. dragover/drop stay on the row (and the two
  // pinned rows) so hovering anywhere over it still tracks the insertion
  // point.
  let mixDragIndex = null;

  function clearMixDropIndicators() {
    const scope = els.mixList;
    if (!scope) return;
    scope.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  // Interactive children of a mix row that must keep their own
  // mousedown/click/drag gestures instead of starting a row reorder-drag:
  // the opacity scrub (`.scrub` — covers its click-to-type `<input>` too,
  // since closest() walks up from it to the ancestor), any icon button
  // (eye/✕/MASK/INV all share `.icon-btn`), and the blend-mode trigger
  // (`.mix-blend`).
  const MIX_ROW_INTERACTIVE_SELECTOR = '.scrub, .icon-btn, .mix-blend';

  // Recomputes `row.draggable` on every pointerdown/mousedown: false when
  // the pointer landed on an interactive child, true otherwise — so a plain
  // press on the row body still starts a native drag, and a press on a
  // control never does. Restored to true unconditionally on release too, as
  // a self-healing fallback. Listened in the CAPTURE phase: the opacity
  // scrub's own click-to-type readout calls stopPropagation() on ITS
  // pointerdown (see makeScrub above), so a bubble-phase listener on the row
  // would never see that event and would leave the row draggable while the
  // user is dragging the scrub's value.
  function wireMixRowDragToggle(row) {
    const recompute = (e) => {
      row.draggable = !e.target.closest(MIX_ROW_INTERACTIVE_SELECTOR);
    };
    const restore = () => {
      row.draggable = true;
    };
    row.addEventListener('pointerdown', recompute, true);
    row.addEventListener('mousedown', recompute, true);
    row.addEventListener('pointerup', restore, true);
    row.addEventListener('mouseup', restore, true);
    row.addEventListener('dragend', restore);
  }

  // Reorders state.mix. `to` is an insertion index in ORIGINAL (pre-removal)
  // coordinates: `to === i` lands right before the current index-i layer,
  // `to === state.mix.length` lands at the very end. Tracks the currently
  // EDITed layer by object identity (not index) so a reorder never silently
  // jumps EDIT onto a different layer.
  function moveLayerTo(from, to) {
    if (to === from || to === from + 1) return; // dropped back where it started
    const selectedStep = state.editTarget.kind === 'layer' ? state.mix[state.editTarget.index] : null;
    const [moved] = state.mix.splice(from, 1);
    const insertAt = from < to ? to - 1 : to;
    state.mix.splice(insertAt, 0, moved);
    if (selectedStep) {
      const newIndex = state.mix.indexOf(selectedStep);
      if (newIndex >= 0 && newIndex !== state.editTarget.index) {
        state.editTarget.index = newIndex;
        buildEditor(); // refresh the [n] index in the header
      }
    }
    buildMixList();
    requestRender();
  }

  // ---------- eye affordance (replaces the old enable/disable checkbox) ----------
  // Same underlying boolean (layer.enabled / state.outputEnabled /
  // state.source.enabled) — just rendered as show/hide instead of a native
  // checkbox, so it matches every other brutalist control (no browser
  // checkbox chrome, no accent color). Open eye = visible; eye+slash = hidden.
  function eyeIconSVG(hidden) {
    return (
      '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
      '<path d="M1 6C1 6 4 2.4 6 2.4C8 2.4 11 6 11 6C11 6 8 9.6 6 9.6C4 9.6 1 6 1 6Z" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<circle cx="6" cy="6" r="1.2" fill="currentColor" stroke="none"/>' +
      (hidden ? '<line x1="1.2" y1="1.2" x2="10.8" y2="10.8" stroke="currentColor" stroke-width="1"/>' : '') +
      '</svg>'
    );
  }

  function makeEyeToggle(title, getVisible, toggle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn eye-btn';
    btn.title = title;
    const sync = () => {
      btn.innerHTML = eyeIconSVG(!getVisible());
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
      sync();
    });
    sync();
    return btn;
  }

  function buildMixList() {
    const container = els.mixList;
    container.innerHTML = '';

    // pinned OUTPUT layer (runs first: crop/scale before effects) — never
    // gets an opacity scrub, it's not a blendable effect layer. Not
    // draggable and not displaceable (see the LAYERS drag-to-reorder block
    // above) — it only ever accepts a dragged layer landing right under it.
    const outItem = document.createElement('div');
    outItem.className =
      'mix-item output-layer' +
      (state.editTarget.kind === 'output' ? ' selected' : '') +
      (state.outputEnabled ? '' : ' disabled');
    const outTop = document.createElement('div');
    outTop.className = 'mix-row-top';
    const outEye = makeEyeToggle('Enable/disable crop + scale', () => state.outputEnabled, () => {
      state.outputEnabled = !state.outputEnabled;
      outItem.classList.toggle('disabled', !state.outputEnabled);
      requestOutput();
    });
    const outTitle = document.createElement('span');
    outTitle.className = 'mix-title';
    outTitle.textContent = '◇ OUTPUT';
    outTop.append(outEye, outTitle);
    outItem.append(outTop);
    outItem.addEventListener('click', selectOutput);
    // Drop target only — OUTPUT is pinned, so a dragged layer can only ever
    // land right after it (becomes the new first layer, index 0).
    outItem.addEventListener('dragover', (e) => {
      if (mixDragIndex === null) return;
      e.preventDefault();
      clearMixDropIndicators();
      outItem.classList.add('drop-after');
    });
    outItem.addEventListener('drop', (e) => {
      if (mixDragIndex === null) return;
      e.preventDefault();
      const from = mixDragIndex;
      clearMixDropIndicators();
      mixDragIndex = null;
      moveLayerTo(from, 0);
    });
    container.appendChild(outItem);

    // effect layers
    const maskInfo = computeMaskInfo();
    state.mix.forEach((step, index) => {
      const def = RSTR.getEffect(step.effect);
      const isMask = mixLayerMaskOn(index);
      const isMaskTarget = maskInfo.targets.has(index);
      const isMaskNoop = maskInfo.noop.has(index);
      const item = document.createElement('div');
      item.className =
        'mix-item' +
        (step.enabled === false ? ' disabled' : '') +
        (isMask ? ' mask-layer' : '') +
        (isMaskTarget ? ' mask-target' : '') +
        (state.editTarget.kind === 'layer' && state.editTarget.index === index ? ' selected' : '');

      const top = document.createElement('div');
      top.className = 'mix-row-top';

      const eyeBtn = makeEyeToggle('Show/hide layer', () => step.enabled !== false, () => {
        const wasVisible = step.enabled !== false;
        step.enabled = !wasVisible;
        item.classList.toggle('disabled', step.enabled === false);
        requestRender();
      });

      const title = document.createElement('span');
      title.className = 'mix-title';
      title.textContent = `${index + 1}. ${def.name}`;

      const controls = document.createElement('div');
      controls.className = 'mix-controls';
      controls.append(iconButton('✕', 'Remove', () => removeLayer(index)));

      top.append(eyeBtn, title);
      // Subtle marker on the row being masked (the next enabled, non-mask
      // layer after a MASK row) — see computeMaskInfo(). Never shown on a
      // mask row itself (isMask rows read as "not drawn" via .mask-layer's
      // dashed border + italic title instead, below).
      if (isMaskTarget) {
        const maskedBadge = document.createElement('span');
        maskedBadge.className = 'mix-badge';
        maskedBadge.textContent = 'MASKED';
        maskedBadge.title = 'Blend opacity is multiplied by the MASK layer above, per pixel';
        top.append(maskedBadge);
      }
      top.append(controls);
      item.append(top);

      // Row 2: MASK + INVERT toggles (left), then either blend+opacity (a
      // normal layer's compositing controls) or a subtle "stencil, not
      // drawn" note (a mask layer's own blend/opacity are unused — see
      // src/pipeline.js render()'s isMaskLayer branch). Own hit area on
      // every control — stops propagation so using them doesn't also jump
      // EDIT to this layer.
      const controlsRow = document.createElement('div');
      controlsRow.className = 'mix-controls-row';

      const maskBtn = document.createElement('button');
      maskBtn.type = 'button';
      maskBtn.className = 'icon-btn mix-mask-btn' + (isMask ? ' active' : '');
      maskBtn.textContent = 'MASK';
      maskBtn.title = 'Use as a MASK — not drawn itself; its luminance stencils the NEXT layer';
      maskBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setMixLayerMask(index, !isMask);
        buildMixList(); // a mask flag can change the MASKED badge on ANOTHER row too
        requestRender();
      });
      controlsRow.append(maskBtn);

      if (isMask) {
        const invertBtn = document.createElement('button');
        invertBtn.type = 'button';
        invertBtn.className = 'icon-btn mix-mask-btn' + (mixLayerMaskInvert(index) ? ' active' : '');
        invertBtn.textContent = 'INV';
        invertBtn.title = 'Invert the mask (stipple/dither marks are black — invert to reveal through them)';
        invertBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setMixLayerMaskInvert(index, !mixLayerMaskInvert(index));
          buildMixList();
          requestRender();
        });
        controlsRow.append(invertBtn);

        const note = document.createElement('span');
        note.className = 'mix-mask-note';
        note.textContent = isMaskNoop ? 'stencil — no target, no-op' : 'stencil — feeds next layer';
        controlsRow.append(note);
      } else {
        // makeBlendControl's own trigger click handler already stops
        // propagation (so opening the dropdown doesn't also jump EDIT to
        // this row via the item's click listener below).
        const blendControl = makeBlendControl(
          () => mixLayerBlend(index),
          (v) => setMixLayerBlend(index, v)
        );

        const opacityScrub = makeScrub({
          label: 'Opacity',
          min: 0,
          max: 100,
          step: 1,
          get: () => Math.round(mixLayerOpacity(index) * 100),
          set: (v) => {
            setMixLayerOpacity(index, v / 100);
            requestRender();
          },
          format: (v) => v + '%',
          reset: 100,
        });
        opacityScrub.classList.add('mix-opacity');
        opacityScrub.addEventListener('click', (e) => e.stopPropagation());

        controlsRow.append(blendControl, opacityScrub);
      }
      item.append(controlsRow);

      // Whole row is the drag SOURCE (see wireMixRowDragToggle above for how
      // its own interactive children opt out) as well as the drop target —
      // dragover/drop live on the row so hovering anywhere over it shows the
      // insertion line.
      item.draggable = true;
      wireMixRowDragToggle(item);
      item.addEventListener('dragstart', (e) => {
        mixDragIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', 'layer:' + index);
        } catch {
          /* non-fatal — some embedders restrict dataTransfer */
        }
      });
      item.addEventListener('dragend', () => {
        mixDragIndex = null;
        clearMixDropIndicators();
      });
      item.addEventListener('dragover', (e) => {
        if (mixDragIndex === null || mixDragIndex === index) return;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        clearMixDropIndicators();
        item.classList.add(before ? 'drop-before' : 'drop-after');
      });
      item.addEventListener('drop', (e) => {
        if (mixDragIndex === null || mixDragIndex === index) return;
        e.preventDefault();
        const rect = item.getBoundingClientRect();
        const before = e.clientY - rect.top < rect.height / 2;
        const from = mixDragIndex;
        clearMixDropIndicators();
        mixDragIndex = null;
        moveLayerTo(from, before ? index : index + 1);
      });

      // A genuine drag (dragstart fired) never produces a trailing 'click' —
      // native HTML5 DnD suppresses it — so this plain click listener only
      // ever fires for an actual press-and-release: safe to always select.
      item.addEventListener('click', () => selectLayer(index));
      container.appendChild(item);
    });

    // pinned SOURCE layer (a BASE PLATE composited UNDER the finished stack
    // as a final pass) — the mirror of ◇ OUTPUT above, but pinned at the
    // BOTTOM since ORIGINAL is the stack's backdrop rather than its final
    // crop/scale. Not part of state.mix, not draggable/deletable, no blend
    // control (it's a fixed source-over composite, not a blendable effect
    // layer) and no edit panel — its only controls are inline, right here,
    // same as a mix layer's own opacity scrub. Starts UNCHECKED by design
    // (see state.source's own comment above and src/preset.js
    // normalizeSource): checking it makes the original photo show through
    // any transparent holes the stack punches (e.g. an alpha/alpha-invert
    // blend layer) instead of exporting them as transparency. See
    // src/pipeline.js render()'s final composite pass and src/preset.js's
    // `source` block.
    const srcItem = document.createElement('div');
    srcItem.className = 'mix-item source-layer' + (state.source.enabled === true ? '' : ' disabled');

    const srcTop = document.createElement('div');
    srcTop.className = 'mix-row-top';
    const srcEye = makeEyeToggle(
      'Show original underneath (fills transparent holes punched by the stack, e.g. alpha/alpha-invert blend)',
      () => state.source.enabled === true,
      () => {
        state.source.enabled = !(state.source.enabled === true);
        srcItem.classList.toggle('disabled', state.source.enabled !== true);
        requestRender();
      }
    );
    const srcTitle = document.createElement('span');
    srcTitle.className = 'mix-title';
    srcTitle.textContent = '◇ ORIGINAL';
    srcTop.append(srcEye, srcTitle);
    srcItem.append(srcTop);

    // Drop target only — ORIGINAL is pinned at the bottom, so a dragged
    // layer can only ever land right above it (appended at the end).
    srcItem.addEventListener('dragover', (e) => {
      if (mixDragIndex === null) return;
      e.preventDefault();
      clearMixDropIndicators();
      srcItem.classList.add('drop-before');
    });
    srcItem.addEventListener('drop', (e) => {
      if (mixDragIndex === null) return;
      e.preventDefault();
      const from = mixDragIndex;
      clearMixDropIndicators();
      mixDragIndex = null;
      moveLayerTo(from, state.mix.length);
    });

    const srcControlsRow = document.createElement('div');
    srcControlsRow.className = 'mix-controls-row';
    const srcOpacityScrub = makeScrub({
      label: 'Opacity',
      min: 0,
      max: 100,
      step: 1,
      get: () => Math.round(sourceOpacity() * 100),
      set: (v) => {
        setSourceOpacity(v / 100);
        requestRender();
      },
      format: (v) => v + '%',
      reset: 100,
    });
    srcOpacityScrub.classList.add('mix-opacity');
    srcControlsRow.append(srcOpacityScrub);
    srcItem.append(srcControlsRow);

    container.appendChild(srcItem);
  }

  function removeLayer(index) {
    const removed = state.mix[index];
    state.mix.splice(index, 1);
    if (state.editTarget.kind === 'layer') {
      if (state.editTarget.index === index) {
        // was editing the removed layer — fall back to NEW mode on that effect
        selectEffect(removed.effect);
        return;
      }
      if (state.editTarget.index > index) state.editTarget.index -= 1;
      buildEditor(); // refresh the [n] index in the header
    }
    buildMixList();
    requestRender();
  }

  // ---------- PRE module (pinned, global preprocessing block) ----------
  // Permanently-attached compact section, sandwiched between the effect list
  // and the settings/edit panel (mirrors tooooools' "Image Preprocessing").
  // Always expanded — no collapse toggle. Built ONCE (boot); every change
  // afterwards mutates state.pre + calls syncPreUI() to refresh
  // transforms/labels/positions in place — never a DOM rebuild, so an
  // in-flight pointer-capture drag survives its own event handler re-running.
  const preEls = {}; // populated once by buildPreSection()
  const PRE_SCRUB_KEYS = ['blur', 'grain', 'gamma'];

  function formatPreValue(key, v) {
    if (key === 'blur' || key === 'blackPoint' || key === 'whitePoint') return String(Math.round(v));
    return Number(v).toFixed(1); // grain, gamma
  }

  // PRE "Canvas" writes straight through to OUTPUT's scale block (single
  // source of truth — geometry stays crop→scale→effects, WYSIWYG, style-code
  // compatible): explicit WORKING-BUFFER WIDTH in px (mode 'width'). Every
  // ported effect param (stipple min/maxWidth, dots spacing, crt pitch, …) is
  // tuned in absolute px against this buffer size — see CLAUDE.md "WHY".
  function preCanvasSize() {
    const s = state.output.scale;
    if (s.mode === 'width' && s.size) return s.size;
    // Any other mode (none/fit/exact, e.g. from a loaded style code): show the
    // CURRENT effective width so the scrub isn't blank; dragging it takes over
    // as 'width' mode (same takeover behavior the old Scale % scrub had).
    if (pipeline && pipeline.hasImage()) {
      const geo = RSTR.computeGeometry(pipeline.rawW, pipeline.rawH, effectiveOutput());
      return geo.tw;
    }
    return 1000;
  }
  // CANVAS's travel is source-dependent: max = 2x the loaded image's raw
  // width (rounded to the nearest 100), so the native-size default sits at
  // the midpoint and the user can still push to ~200%. min stays fixed at
  // 100. No image loaded yet (boot) -> fall back to the old static 2000.
  function preCanvasMax() {
    if (pipeline && pipeline.hasImage() && pipeline.rawW) {
      return Math.max(200, Math.round((2 * pipeline.rawW) / 100) * 100);
    }
    return 2000;
  }
  function setPreCanvasSize(px) {
    if (!pipeline || !pipeline.hasImage()) return;
    const size = Math.max(100, Math.min(preCanvasMax(), Math.round(px)));
    state.output.scale = { mode: 'width', size, width: null, height: null };
    if (state.editTarget.kind === 'output') buildOutputEditor(); // keep the open OUTPUT tab in sync
    requestOutput();
  }
  // Single source of truth for CANVAS's reset target: the loaded source's
  // native width (same value a fresh image load sets) — used both as the
  // scrub's own dblclick-reset value and by PRE's RESET button.
  function preCanvasResetValue() {
    return pipeline && pipeline.hasImage() && pipeline.rawW ? pipeline.rawW : 1000;
  }
  function formatCanvasSize(px) {
    return Math.round(px) + 'px';
  }

  function onPreChange() {
    requestRender();
    syncPreUI();
  }

  // Refresh every PRE visual (dot, knob ticks/labels, handle positions,
  // readout, collapsed state) from current state — no DOM (re)creation.
  function syncPreUI() {
    if (!preEls.section) return; // not built yet
    const pre = state.pre;
    preEls.dot.classList.toggle('active', !RSTR.preset.preIsIdentity(pre));

    for (const s of preEls.scrubs) s.sync();

    const bp = pre.blackPoint != null ? pre.blackPoint : 0;
    const wp = pre.whitePoint != null ? pre.whitePoint : 255;
    preEls.handleBP.style.left = (bp / 255) * 100 + '%';
    preEls.handleWP.style.left = (wp / 255) * 100 + '%';
    preEls.levelsReadout.textContent = `BP ${Math.round(bp)} · WP ${Math.round(wp)}`;
  }

  // Horizontal pointer-capture drag along the track (0..255, unclamped
  // against the other handle — bp may cross wp, matching tooooools) +
  // dblclick (reset to 0 or 255).
  function wireHandle(handle, track, key, resetValue) {
    let dragId = null;
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      dragId = e.pointerId;
      e.stopPropagation();
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragId !== e.pointerId) return;
      const rect = track.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      state.pre[key] = Math.round(t * 255);
      onPreChange();
    });
    const release = (e) => {
      if (dragId === e.pointerId) dragId = null;
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
    handle.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      state.pre[key] = resetValue;
      onPreChange();
    });
  }

  // Built at boot, and rebuilt on every fresh image load (CANVAS's range is
  // source-width-dependent — see preCanvasMax). `#pre-section` is an empty
  // container in index.html — everything inside it is generated here, same
  // convention as #effect-list / #mix-list / #align-picker.
  function buildPreSection() {
    const section = els.preSection;
    section.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'pre-header';
    const title = document.createElement('span');
    title.className = 'pre-title';
    title.textContent = 'Pre';
    const dot = document.createElement('span');
    dot.className = 'pre-dot';
    dot.textContent = '●';
    const spacer = document.createElement('span');
    spacer.className = 'pre-spacer';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pre-mini-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.pre = RSTR.preset.defaultPre();
      setPreCanvasSize(preCanvasResetValue()); // CANVAS isn't part of state.pre — reset it via its own path
      onPreChange();
    });
    header.append(title, dot, spacer, resetBtn);

    const body = document.createElement('div');
    body.className = 'pre-body';

    const scrubCol = document.createElement('div');
    scrubCol.className = 'pre-scrubs';
    const scrubs = [];
    // Canvas first — the working-buffer WIDTH in px (see preCanvasSize / CLAUDE.md "WHY").
    // min/max/reset are source-dependent (preCanvasMax / the loaded image's raw
    // width) — that's why buildPreSection() is re-run on every fresh image load,
    // not just once at boot.
    scrubs.push(
      scrubCol.appendChild(
        makeScrub({
          label: 'Canvas',
          min: 100,
          max: preCanvasMax(),
          step: 1, // per-pixel granularity — every value is reachable; `snap` below only magnetizes
          snap: 100, // drag is smooth (1px) but sticks near hundreds — see SCRUB_MAGNET_TOLERANCE
          get: preCanvasSize,
          set: setPreCanvasSize,
          format: formatCanvasSize,
          reset: preCanvasResetValue(),
        })
      )
    );
    const scrubDefs = RSTR.getEffect('preprocess').params.filter((p) => PRE_SCRUB_KEYS.indexOf(p.key) >= 0);
    for (const param of scrubDefs) {
      scrubs.push(
        scrubCol.appendChild(
          makeScrub({
            label: param.label,
            min: param.min,
            max: param.max,
            step: param.step,
            get: () => (state.pre[param.key] != null ? state.pre[param.key] : param.default),
            set: (v) => {
              state.pre[param.key] = v;
              onPreChange();
            },
            format: (v) => formatPreValue(param.key, v),
            reset: param.default,
          })
        )
      );
    }

    const levelsRow = document.createElement('div');
    levelsRow.className = 'pre-levels-row';
    const track = document.createElement('div');
    track.className = 'pre-track';
    for (let i = 0; i < 16; i++) {
      const block = document.createElement('div');
      block.className = 'pre-track-block';
      const v = Math.round((i * 255) / 15);
      block.style.background = `rgb(${v},${v},${v})`;
      track.appendChild(block);
    }
    const handleBP = document.createElement('div');
    handleBP.className = 'pre-handle pre-handle-bp';
    handleBP.title = 'Black point';
    const handleWP = document.createElement('div');
    handleWP.className = 'pre-handle pre-handle-wp';
    handleWP.title = 'White point';
    track.append(handleBP, handleWP);
    wireHandle(handleBP, track, 'blackPoint', 0);
    wireHandle(handleWP, track, 'whitePoint', 255);

    const readout = document.createElement('div');
    readout.className = 'pre-levels-readout';

    levelsRow.append(track, readout);
    body.append(scrubCol, levelsRow);
    section.append(header, body);

    preEls.section = section;
    preEls.dot = dot;
    preEls.body = body;
    preEls.scrubs = scrubs;
    preEls.track = track;
    preEls.handleBP = handleBP;
    preEls.handleWP = handleWP;
    preEls.levelsReadout = readout;

    syncPreUI();
  }

  // ---------- OUTPUT editor ----------
  // OUTPUT lists 'width' too: PRE's CANVAS scrub writes that mode, and OUTPUT
  // reads the same state.output.scale — hiding the mode here made the tab show
  // "None (source)" while the image was actually being resized, and touching
  // the select would have silently wiped the canvas size.
  const OUTPUT_SCALE_MODES = ['none', 'fit', 'width', 'exact'];
  const SCALE_MODE_LABELS = {
    none: 'None (source)',
    fit: 'Longest side',
    width: 'Canvas width',
    exact: 'Exact W×H',
  };

  function fillSelect(select, values, current, labels) {
    select.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = labels ? labels[v] || v : v;
      if (v === current) o.selected = true;
      select.appendChild(o);
    }
  }

  function ratioIsCustom() {
    const r = state.output.crop.ratio;
    return r !== 'original' && RSTR.preset.RATIOS.indexOf(r) < 0;
  }

  function buildOutputEditor() {
    const custom = ratioIsCustom();
    fillSelect(els.ratioSelect, RSTR.preset.RATIOS.concat(['custom']), custom ? 'custom' : state.output.crop.ratio);
    if (custom) {
      const parts = state.output.crop.ratio.split(':');
      els.cropW.value = parts[0];
      els.cropH.value = parts[1];
    }
    fillSelect(els.scaleModeSelect, OUTPUT_SCALE_MODES, state.output.scale.mode, SCALE_MODE_LABELS);
    els.scaleSize.value = state.output.scale.size == null ? '' : String(state.output.scale.size);
    els.scaleW.value = state.output.scale.width == null ? '' : String(state.output.scale.width);
    els.scaleH.value = state.output.scale.height == null ? '' : String(state.output.scale.height);
    fillSelect(els.formatSelect, RSTR.preset.FORMATS, state.output.format);
    els.qualityInput.value = String(state.output.quality);
    els.qualityValue.textContent = state.output.quality.toFixed(2);
    buildAlignPicker();
    syncOutputUI();
  }

  function buildAlignPicker() {
    els.alignPicker.innerHTML = '';
    for (const code of RSTR.preset.ALIGN_CODES) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'align-cell' + (code === state.output.crop.align ? ' active' : '');
      cell.dataset.align = code;
      cell.title = code;
      cell.addEventListener('click', () => {
        state.output.crop.align = code;
        buildAlignPicker();
        requestOutput();
      });
      els.alignPicker.appendChild(cell);
    }
  }

  function syncOutputUI() {
    els.cropCustomRow.style.display = ratioIsCustom() ? '' : 'none';
    const m = state.output.scale.mode;
    els.scaleSizeRow.style.display = m === 'fit' || m === 'width' ? '' : 'none';
    els.scaleExactRow.style.display = state.output.scale.mode === 'exact' ? '' : 'none';
    els.qualityRow.style.display = state.output.format !== 'png' ? '' : 'none';
    refreshOutputVisuals();
  }

  // Canvas crop guide + anchor marker + dims readout — reflect the EFFECTIVE
  // output (passthrough when the OUTPUT layer is disabled).
  function refreshOutputVisuals() {
    const eff = RSTR.preset.normalizeOutput(effectiveOutput());
    const cropping = eff.crop.ratio !== 'original';
    els.cropGuide.classList.toggle('show', cropping);
    const a = eff.crop.align;
    const left = a.indexOf('L') >= 0 ? 16.667 : a.indexOf('R') >= 0 ? 83.333 : 50;
    const top = a.indexOf('T') >= 0 ? 16.667 : a.indexOf('B') >= 0 ? 83.333 : 50;
    els.cropGuideAnchor.style.left = left + '%';
    els.cropGuideAnchor.style.top = top + '%';
    updateDimsReadout(eff);
    syncPreUI(); // PRE's Scale scrub mirrors output.scale — repaint on any output change
  }

  function updateDimsReadout(eff) {
    if (!pipeline || !pipeline.hasImage()) {
      els.dimsReadout.textContent = 'SRC — × — → OUT — × —';
      return;
    }
    const sw = pipeline.rawW;
    const sh = pipeline.rawH;
    const geo = RSTR.computeGeometry(sw, sh, eff || effectiveOutput());
    els.dimsReadout.textContent = `SRC ${sw}×${sh} → OUT ${geo.tw}×${geo.th}`;
  }

  function customRatioFromInputs() {
    const w = Number(els.cropW.value);
    const h = Number(els.cropH.value);
    return w > 0 && h > 0 ? `${w}:${h}` : null;
  }

  function wireOutputTab() {
    els.ratioSelect.addEventListener('change', () => {
      if (els.ratioSelect.value === 'custom') {
        state.output.crop.ratio = customRatioFromInputs() || '1:1';
        if (!customRatioFromInputs()) {
          els.cropW.value = '1';
          els.cropH.value = '1';
        }
      } else {
        state.output.crop.ratio = els.ratioSelect.value;
      }
      syncOutputUI();
      requestOutput();
    });
    const onCustom = () => {
      const r = customRatioFromInputs();
      if (r) {
        state.output.crop.ratio = r;
        requestOutput();
      }
    };
    els.cropW.addEventListener('input', onCustom);
    els.cropH.addEventListener('input', onCustom);

    els.scaleModeSelect.addEventListener('change', () => {
      state.output.scale.mode = els.scaleModeSelect.value;
      syncOutputUI();
      requestOutput();
    });
    const num = (v) => (v.trim() === '' ? null : Math.max(1, Math.round(Number(v) || 0)) || null);
    els.scaleSize.addEventListener('input', () => {
      state.output.scale.size = num(els.scaleSize.value);
      requestOutput();
    });
    els.scaleW.addEventListener('input', () => {
      state.output.scale.width = num(els.scaleW.value);
      requestOutput();
    });
    els.scaleH.addEventListener('input', () => {
      state.output.scale.height = num(els.scaleH.value);
      requestOutput();
    });

    els.formatSelect.addEventListener('change', () => {
      state.output.format = els.formatSelect.value;
      syncOutputUI();
      requestRender(); // format only affects encode, not the buffer
    });
    els.qualityInput.addEventListener('input', () => {
      state.output.quality = Number(els.qualityInput.value);
      els.qualityValue.textContent = state.output.quality.toFixed(2);
    });
  }

  // ---------- global style actions (committed mix + effective output) ----------
  function exportImage() {
    if (!pipeline.hasImage()) return showToast('Load an image first');
    pipeline.applyOutput(effectiveOutput());
    pipeline.render(state.mix.concat(preLayer()), state.source); // committed look + pending PRE, not the NEW-mode preview
    pipeline.toBlob((blob) => {
      const ext = RSTR.preset.extForFormat(effectiveOutput().format);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.imageName}-rstr.${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
      requestRender();
    }, effectiveOutput());
  }

  function copyStyleCode() {
    // Pending PRE goes out as an explicit trailing `preprocess` stack layer.
    const preset = RSTR.preset.finalizePreset(state.imageName, state.mix.concat(preLayer()), effectiveOutput(), null, state.source);
    const text = JSON.stringify(preset, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast(`Copied ${preset.id}`),
        () => {
          showToast('Clipboard blocked — see console');
          console.log(text);
        }
      );
    } else {
      showToast('Clipboard unavailable — see console');
      console.log(text);
    }
  }

  // Replace the current mix + output with a (validated) style and re-render.
  function applyStyle(style) {
    const stack = RSTR.preset.stackToEditable(style.stack);
    // Legacy style codes carry a separate `pre` block that rendered FIRST —
    // convert it to an explicit head `preprocess` layer (same look), since
    // state.pre is now a live working buffer that always starts clean.
    if (style.pre && !RSTR.preset.preIsIdentity(style.pre)) {
      stack.unshift({ effect: 'preprocess', enabled: true, params: RSTR.preset.normalizePre(style.pre) });
    }
    state.mix = stack;
    state.output = RSTR.preset.normalizeOutput(style.output);
    state.outputEnabled = true;
    state.pre = RSTR.preset.defaultPre();
    state.source = RSTR.preset.normalizeSource(style.source);
    goNewMode();
    buildMixList();
    syncPreUI();
    requestOutput();
  }

  // ---------- named Style Library ----------
  function buildStyleSelect() {
    const lib = RSTR.preset.loadStyleLibrary();
    const prev = els.styleSelect.value;
    els.styleSelect.innerHTML = '';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— styles —';
    els.styleSelect.appendChild(ph);
    for (const name of Object.keys(lib)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      els.styleSelect.appendChild(o);
    }
    if (prev && lib[prev]) els.styleSelect.value = prev;
  }

  function loadSelectedStyle() {
    const name = els.styleSelect.value;
    if (!name) return;
    const style = RSTR.preset.loadStyleLibrary()[name];
    if (!style) return;
    applyStyle(RSTR.preset.validatePreset(style));
    showToast(`Loaded "${name}"`);
  }

  let pendingOverwrite = null;
  function saveStyleFlow() {
    openInline('Style name…', state.imageName || 'my-style', (text) => {
      const name = String(text).trim();
      if (!name) return 'Enter a name';
      const lib = RSTR.preset.loadStyleLibrary();
      if (name in lib && pendingOverwrite !== name) {
        pendingOverwrite = name;
        return `“${name}” exists — press OK again to overwrite`;
      }
      const style = RSTR.preset.finalizePreset(name, state.mix.concat(preLayer()), effectiveOutput(), null, state.source);
      RSTR.preset.saveStyleToLibrary(name, style);
      pendingOverwrite = null;
      buildStyleSelect();
      els.styleSelect.value = name;
      showToast(`Saved style "${name}"`);
      return null;
    });
  }

  function deleteSelectedStyle() {
    const name = els.styleSelect.value;
    if (!name) return showToast('Select a saved style first');
    RSTR.preset.deleteStyleFromLibrary(name);
    buildStyleSelect();
    showToast(`Deleted "${name}"`);
  }

  // PASTE CODE (dedicated button) was removed 2026-07-13 — the global Ctrl+V
  // handler below (handleGlobalPaste) already runs clipboard text through
  // this exact parseStyleCode/applyStyle path from anywhere on the page, so
  // a second, always-visible button for the same action was redundant.

  // ---------- bridge to the batch engine (presets/) + whole-library backup ----------
  // The Style Library lives ONLY in localStorage — invisible to engine/rstr.js,
  // which reads presets/*.json from disk, and gone forever on a cache clear.
  // Two independent problems, two independent fixes below:
  //   A) → PRESETS writes ONE selected library style out as an engine-ready
  //      preset JSON (same shape Copy Code produces — the library entry IS
  //      already a finalizePreset() result, so this never re-serializes).
  //   B) EXPORT ALL / IMPORT round-trip the WHOLE library as one JSON file,
  //      so it survives a cache clear / moves to another machine.
  //
  // File System Access (showDirectoryPicker) is the happy path for (A): pick
  // presets/ once, persist the directory handle in IndexedDB (localStorage
  // can't hold a FileSystemHandle), and every later export writes straight in
  // with no dialog. Falls back to a plain <a download> — same JSON either way
  // — when the picker API is missing, throws, or permission is denied.
  const IDB_NAME = 'rstr-fs';
  const IDB_STORE = 'handles';
  const IDB_PRESETS_KEY = 'presetsDir';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(key) {
    return idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        })
    );
  }

  function idbSet(key, value) {
    return idbOpen().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  // Reuse a persisted handle when its permission is still (or newly) granted;
  // only fall back to the full native picker when there is no usable handle.
  async function getPresetsDirHandle() {
    if (!window.showDirectoryPicker) return null;
    let handle = null;
    try {
      handle = await idbGet(IDB_PRESETS_KEY);
    } catch {
      handle = null;
    }
    if (handle) {
      try {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') return handle;
        // permission revoked and re-request declined -> re-prompt below
      } catch {
        /* stale/broken handle (e.g. folder moved) -> re-prompt below */
      }
    }
    try {
      handle = await window.showDirectoryPicker({ id: 'rstr-presets', mode: 'readwrite' });
    } catch {
      return null; // user cancelled, or the picker isn't allowed here
    }
    try {
      await idbSet(IDB_PRESETS_KEY, handle);
    } catch {
      /* non-fatal -- export still works this call, just re-prompts next time */
    }
    return handle;
  }

  async function writeJsonToDir(dirHandle, filename, text) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function slugify(name) {
    const s = String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'style';
  }

  // A) → PRESETS — write the currently SELECTED library style to disk.
  async function exportStyleToPresets() {
    const name = els.styleSelect.value;
    if (!name) return showToast('Select a saved style first');
    const style = RSTR.preset.loadStyleLibrary()[name];
    if (!style) return showToast('Style not found');
    const filename = `${slugify(style.name || name)}.json`;
    const text = JSON.stringify(style, null, 2);

    const dirHandle = await getPresetsDirHandle();
    if (dirHandle) {
      try {
        await writeJsonToDir(dirHandle, filename, text);
        showToast(`Wrote presets/${filename}`);
        return;
      } catch (err) {
        console.warn('RSTR: presets/ write failed, falling back to download', err);
      }
    }
    downloadText(filename, text);
    showToast(`Downloaded ${filename} — drop it into presets/`);
  }

  // BACKUP disclosure (2026-07-13) — Export all/Import are needed once in a
  // blue moon, so they stay hidden behind one flat toggle button instead of
  // occupying two permanent rows in the 170px /Styles column. Same
  // ▸ collapsed / ▾ expanded glyph convention as the /Effects group headers.
  function toggleBackupRow() {
    const opening = els.backupRow.style.display === 'none';
    els.backupRow.style.display = opening ? 'flex' : 'none';
    els.backupToggleBtn.textContent = (opening ? '▾' : '▸') + ' Backup';
  }

  // B) EXPORT ALL / IMPORT — whole-library backup + restore.
  function exportAllStyles() {
    const lib = RSTR.preset.loadStyleLibrary();
    const count = Object.keys(lib).length;
    if (!count) return showToast('Library is empty');
    downloadText('rstr-style-library.json', JSON.stringify(lib, null, 2));
    showToast(`Exported ${count} style(s)`);
  }

  // Merge an imported library into the current one via the existing
  // save/validate path (never a second serializer). On a name collision:
  // identical style (same rstr_ id) -> left alone; different style under the
  // same name -> imported under a disambiguated "name (2)" instead of
  // silently overwriting.
  function importLibraryFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let incoming;
      try {
        incoming = JSON.parse(String(reader.result));
      } catch {
        showToast('Not valid JSON');
        return;
      }
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        showToast('Not a style library file');
        return;
      }
      let added = 0;
      let renamed = 0;
      let unchanged = 0;
      let invalid = 0;
      for (const name of Object.keys(incoming)) {
        let style;
        try {
          style = RSTR.preset.validatePreset(incoming[name]);
        } catch {
          invalid++;
          continue;
        }
        const lib = RSTR.preset.loadStyleLibrary();
        if (!(name in lib)) {
          RSTR.preset.saveStyleToLibrary(name, style);
          added++;
          continue;
        }
        if (lib[name] && lib[name].id === style.id) {
          unchanged++;
          continue;
        }
        let n = 2;
        let candidate = `${name} (${n})`;
        while (candidate in lib) {
          n++;
          candidate = `${name} (${n})`;
        }
        RSTR.preset.saveStyleToLibrary(candidate, style);
        renamed++;
      }
      buildStyleSelect();
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (renamed) parts.push(`${renamed} renamed (name clash)`);
      if (unchanged) parts.push(`${unchanged} unchanged`);
      if (invalid) parts.push(`${invalid} skipped`);
      showToast(parts.length ? `Import: ${parts.join(', ')}` : 'Nothing to import');
    };
    reader.onerror = () => showToast('Could not read file');
    reader.readAsText(file);
  }

  // ---------- global Ctrl+V: image -> load as source, style text -> apply, else -> toast ----------
  // Reads the `paste` ClipboardEvent's e.clipboardData, NOT navigator.clipboard.read() —
  // the async Clipboard API is commonly permission-blocked on file:// pages (see the
  // fallbackCopyText comment above), while the paste event is user-initiated and needs
  // no permission, so it works over file://.
  function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
  }

  function handleGlobalPaste(e) {
    // Inline-input widget, the scrub click-to-type input, the color picker's hex
    // field — all real <input>/<textarea> elements. Let the browser paste normally.
    if (isEditableTarget(e.target)) return;

    const dt = e.clipboardData;
    if (!dt) return;
    e.preventDefault();

    // 1) an image on the clipboard (screenshot, image copied from a browser) —
    // reuse the exact same load path as drag-drop / the file input.
    let imageFile = null;
    if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          imageFile = it.getAsFile();
          break;
        }
      }
    }
    if (!imageFile && dt.files && dt.files.length) {
      imageFile = Array.from(dt.files).find((f) => /^image\//.test(f.type)) || null;
    }
    if (imageFile) {
      loadImageFile(imageFile);
      showToast('Pasted image');
      return;
    }

    // 2) text — a style (rstr_ id or style JSON) via the SAME parse/apply path
    // PASTE CODE uses, or a toast if it isn't one. Never crash on junk text.
    const text = dt.getData ? dt.getData('text/plain') : '';
    if (!text || !text.trim()) return; // nothing on the clipboard we understand
    try {
      const style = RSTR.preset.parseStyleCode(text);
      applyStyle(style);
      showToast(`Loaded ${style.name ? '"' + style.name + '"' : 'style'}`);
    } catch (err) {
      showToast(err.message || 'Clipboard text is not a style');
    }
  }

  // ---------- inline input widget (paste / save-name — no browser dialogs) ----------
  let inlineHandler = null;
  function openInline(placeholder, initial, handler) {
    els.inlineField.placeholder = placeholder;
    els.inlineField.value = initial || '';
    els.inlineError.textContent = '';
    els.inlineInput.style.display = '';
    inlineHandler = handler;
    els.inlineField.focus();
    els.inlineField.select();
  }
  function closeInline() {
    els.inlineInput.style.display = 'none';
    els.inlineError.textContent = '';
    els.inlineField.value = '';
    inlineHandler = null;
    pendingOverwrite = null;
  }
  function applyInline() {
    if (!inlineHandler) return;
    const err = inlineHandler(els.inlineField.value);
    if (err) {
      els.inlineError.textContent = err;
      return;
    }
    closeInline();
  }

  function resetStyle() {
    state.mix = [];
    state.output = RSTR.preset.defaultOutput();
    state.outputEnabled = true;
    state.pre = RSTR.preset.defaultPre();
    state.source = RSTR.preset.defaultSource();
    goNewMode();
    buildMixList();
    syncPreUI();
    requestOutput();
  }

  // Return to NEW mode on the first visible effect (or the current one).
  function goNewMode() {
    const visible = visibleEffectList();
    const id = visible.length ? visible[0].id : RSTR.EFFECT_LIST[0].id;
    state.editTarget = { kind: 'new', effect: id, params: RSTR.defaultParams(id) };
    buildEditor();
    buildEffectList();
  }

  // ---------- image loading / reset ----------
  function loadImageFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const img = new Image();
    img.onload = () => {
      pipeline.setImage(img, img.naturalWidth, img.naturalHeight);
      els.canvas.classList.add('visible');
      els.dropzone.classList.add('hidden');
      els.newImageBtn.classList.add('show');
      els.viewportControls.classList.add('show');
      state.imageName = file.name.replace(/\.[^.]+$/, '') || 'rstr';
      // CANVAS defaults to the source's OWN width on every freshly-loaded
      // image — opens 1:1, no resampling (not a static default — applyStyle()
      // never touches this, so a pasted/loaded style code's own output.scale
      // is left alone). pipeline.rawW is set by pipeline.setImage() above.
      state.output.scale = { mode: 'width', size: pipeline.rawW, width: null, height: null };
      buildPreSection(); // CANVAS's min/max/reset are source-width-dependent — re-range for the new image
      if (state.editTarget.kind === 'output') buildOutputEditor(); // keep an open OUTPUT tab in sync
      view.lastW = 0; // force a re-fit once the new resolution is applied
      view.lastH = 0;
      view.freshImage = true; // new source — refit capped at 100%, not a CANVAS-drag zoom compensation
      requestOutput();
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  function clearImage() {
    pipeline.clearImage();
    els.canvas.classList.remove('visible');
    els.dropzone.classList.remove('hidden');
    els.newImageBtn.classList.remove('show');
    els.viewportControls.classList.remove('show');
    refreshOutputVisuals();
  }

  // ---------- boot ----------
  function boot() {
    els = {
      panel: document.getElementById('panel'),
      canvas: document.getElementById('gl-canvas'),
      canvasTransform: document.getElementById('canvas-transform'),
      dropzone: document.getElementById('dropzone'),
      canvasWrap: document.getElementById('canvas-wrap'),
      newImageBtn: document.getElementById('new-image-btn'),
      viewportControls: document.getElementById('viewport-controls'),
      zoomSlider: document.getElementById('zoom-slider'),
      zoomReadout: document.getElementById('zoom-readout'),
      zoomFit: document.getElementById('zoom-fit-btn'),
      zoom100: document.getElementById('zoom-100-btn'),
      cropGuide: document.getElementById('crop-guide'),
      cropGuideAnchor: document.getElementById('crop-guide-anchor'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsPanel: document.getElementById('settings-panel'),
      settingsList: document.getElementById('settings-list'),
      effectList: document.getElementById('effect-list'),
      preSection: document.getElementById('pre-section'),
      targetHeader: document.getElementById('target-header'),
      effectEditor: document.getElementById('effect-editor'),
      editorActions: document.getElementById('editor-actions'),
      outputEditor: document.getElementById('output-editor'),
      activeParams: document.getElementById('active-params'),
      presetsBtn: document.getElementById('presets-btn'),
      settingsResetBtn: document.getElementById('settings-reset-btn'),
      presetsBackdrop: document.getElementById('presets-backdrop'),
      presetsModal: document.getElementById('presets-modal'),
      presetsModalTitle: document.getElementById('presets-modal-title'),
      presetsList: document.getElementById('presets-list'),
      presetsCloseBtn: document.getElementById('presets-close-btn'),
      presetsSaveBtn: document.getElementById('presets-save-btn'),
      addGroupBtn: document.getElementById('add-group-btn'),
      addBtn: document.getElementById('add-btn'),
      mixList: document.getElementById('mix-list'),
      ratioSelect: document.getElementById('crop-ratio'),
      cropCustomRow: document.getElementById('crop-custom-row'),
      cropW: document.getElementById('crop-w'),
      cropH: document.getElementById('crop-h'),
      alignPicker: document.getElementById('align-picker'),
      scaleModeSelect: document.getElementById('scale-mode'),
      scaleSizeRow: document.getElementById('scale-size-row'),
      scaleSize: document.getElementById('scale-size'),
      scaleExactRow: document.getElementById('scale-exact-row'),
      scaleW: document.getElementById('scale-w'),
      scaleH: document.getElementById('scale-h'),
      formatSelect: document.getElementById('format-select'),
      qualityRow: document.getElementById('quality-row'),
      qualityInput: document.getElementById('quality-input'),
      qualityValue: document.getElementById('quality-value'),
      dimsReadout: document.getElementById('dims-readout'),
      styleSelect: document.getElementById('style-select'),
      styleSave: document.getElementById('style-save-btn'),
      styleDel: document.getElementById('style-del-btn'),
      exportPresetsBtn: document.getElementById('export-presets-btn'),
      backupToggleBtn: document.getElementById('backup-toggle-btn'),
      backupRow: document.getElementById('backup-row'),
      libraryExportBtn: document.getElementById('library-export-btn'),
      libraryImportBtn: document.getElementById('library-import-btn'),
      libraryImportInput: document.getElementById('library-import-input'),
      inlineInput: document.getElementById('inline-input'),
      inlineField: document.getElementById('inline-field'),
      inlineApply: document.getElementById('inline-apply'),
      inlineCancel: document.getElementById('inline-cancel'),
      inlineError: document.getElementById('inline-error'),
      fileInput: document.getElementById('file-input'),
      toast: document.getElementById('toast'),
    };

    pipeline = new RSTR.Pipeline(els.canvas);

    // restore hidden-effects setting; keep the NEW-mode effect visible
    state.disabled = new Set(RSTR.preset.loadDisabledEffects());
    if (state.disabled.has(state.editTarget.effect)) {
      const visible = visibleEffectList();
      if (visible.length) state.editTarget = { kind: 'new', effect: visible[0].id, params: RSTR.defaultParams(visible[0].id) };
    }

    // restore the user's /Effects catalog order + groups (robust to the
    // registry changing between versions — see loadOrderState())
    const orderState = loadOrderState();
    state.effectOrder = orderState.order;
    state.effectGroups = orderState.groups;

    buildEffectList();
    buildEditor();
    buildMixList();
    buildSettings();
    buildPreSection();
    buildStyleSelect();
    wireOutputTab();
    wireViewport();
    showSettings(false);
    refreshOutputVisuals();

    // gear (top-right of the canvas) toggles the settings checklist in
    // column 1's /Effects section (see showSettings)
    els.settingsBtn.addEventListener('click', () => showSettings(!state.settingsOpen));

    // per-effect settings: RESET, PRESETS modal, ADD, create-group
    els.settingsResetBtn.addEventListener('click', resetCurrentEffectParams);
    els.presetsBtn.addEventListener('click', openPresetsModal);
    els.presetsCloseBtn.addEventListener('click', closePresetsModal);
    els.presetsBackdrop.addEventListener('click', closePresetsModal);
    els.presetsSaveBtn.addEventListener('click', saveCurrentPresetFlow);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.presetsModal.style.display !== 'none') closePresetsModal();
    });
    els.addGroupBtn.addEventListener('click', createGroupFlow);
    els.addBtn.addEventListener('click', addToMix);

    // global actions
    document.getElementById('export-btn').addEventListener('click', exportImage);
    document.getElementById('reset-btn').addEventListener('click', resetStyle);

    // style library + code import/export
    els.styleSelect.addEventListener('change', loadSelectedStyle);
    els.styleSave.addEventListener('click', saveStyleFlow);
    els.styleDel.addEventListener('click', deleteSelectedStyle);
    document.getElementById('copy-btn').addEventListener('click', copyStyleCode);
    els.exportPresetsBtn.addEventListener('click', exportStyleToPresets);
    els.backupToggleBtn.addEventListener('click', toggleBackupRow);
    els.libraryExportBtn.addEventListener('click', exportAllStyles);
    els.libraryImportBtn.addEventListener('click', () => els.libraryImportInput.click());
    els.libraryImportInput.addEventListener('change', () => {
      const f = els.libraryImportInput.files[0];
      if (f) importLibraryFile(f);
      els.libraryImportInput.value = ''; // allow re-picking the same filename later
    });
    els.inlineApply.addEventListener('click', applyInline);
    els.inlineCancel.addEventListener('click', closeInline);

    // image file input
    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files[0]) loadImageFile(els.fileInput.files[0]);
    });

    // NEW IMAGE / ✕ — drop the current image, back to the drop zone
    els.newImageBtn.addEventListener('click', clearImage);
    els.dropzone.addEventListener('click', () => els.fileInput.click());

    // drag-drop over the whole canvas area, any time (replace current)
    els.canvasWrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.dropzone.classList.add('drag-over');
    });
    els.canvasWrap.addEventListener('dragleave', (e) => {
      if (e.target === els.canvasWrap || e.target === els.dropzone) els.dropzone.classList.remove('drag-over');
    });
    els.canvasWrap.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]);
    });

    // global Ctrl+V — image/style-aware paste anywhere except editable fields
    document.addEventListener('paste', handleGlobalPaste);

    // patterns reads ImageData decoded async by assets.js — re-render
    // once decode lands, in case it rendered as passthrough first.
    if (RSTR.assetsReady) RSTR.assetsReady.then(requestRender);

    requestAnimationFrame(frame);
  }

  // Public surface for the shared color picker — reusable by future controls
  // (e.g. gradient stops) via RSTR.ui.openColorPicker(anchorEl, hex, onChange).
  RSTR.ui = RSTR.ui || {};
  RSTR.ui.openColorPicker = openColorPicker;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})((window.RSTR = window.RSTR || {}));
