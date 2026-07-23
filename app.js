(() => {
  "use strict";

  const STORAGE_KEY = "planogram-webapp-state-v1";
  const layers = ["D", "C", "B", "A"];
  const clone = value => JSON.parse(JSON.stringify(value));
  const initialData = clone(window.PLANOGRAM_INITIAL_DATA || { categories: [], products: [], groups: [] });

  const state = {
    data: loadState(),
    currentCategory: initialData.categories[0] || "",
    secondaryFilter: "全部",
    selectedTarget: null,
    selectedProductId: null,
    activePanel: "total",
    dragPayload: null,
    dragHoverEl: null,
    lastMovedProductId: null,
    lastMoveLabel: "",
    lastMoveTimer: null
  };

  const el = id => document.getElementById(id);
  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const number = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const integer = (value, fallback = 0) => Math.round(number(value, fallback));
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
  const makeId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(initialData);
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.groups)) {
        return clone(initialData);
      }
      return parsed;
    } catch (error) {
      console.warn("读取本地数据失败，使用底表数据。", error);
      return clone(initialData);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    } catch (error) {
      console.warn("保存本地数据失败。", error);
    }
  }

  function setStatus(message, isError = false) {
    const bar = el("statusBar");
    bar.textContent = message;
    bar.classList.toggle("error", isError);
  }

  function categories() {
    return state.data.categories || [];
  }

  function currentProducts(includeEliminated = true) {
    return state.data.products.filter(product =>
      product.category === state.currentCategory &&
      (includeEliminated || product.status !== "eliminated")
    );
  }

  function currentGroups() {
    return state.data.groups.filter(group =>
      group.category === state.currentCategory &&
      (state.secondaryFilter === "全部" || group.secondCategory === state.secondaryFilter)
    );
  }

  function productById(productId) {
    return state.data.products.find(product => product.id === productId) || null;
  }

  function groupById(groupId) {
    return state.data.groups.find(group => group.id === groupId) || null;
  }

  function ensureGroupLayer(group, layer) {
    if (!group.layers[layer]) group.layers[layer] = { capacity: 0, pits: [] };
    if (!Array.isArray(group.layers[layer].pits)) group.layers[layer].pits = [];
    return group.layers[layer];
  }

  function allPitsForProduct(productId) {
    const output = [];
    state.data.groups.forEach(group => {
      layers.forEach(layer => {
        ensureGroupLayer(group, layer).pits.forEach((pit, index) => {
          if (pit.productId === productId) output.push({ groupId: group.id, layer, index, pit });
        });
      });
    });
    return output;
  }

  function actualPitCount(productId) {
    return allPitsForProduct(productId).length;
  }


  function productState(product) {
    if (product.status === "eliminated") return "eliminated";
    return actualPitCount(product.id) > 0 ? "onShelf" : "unplaced";
  }

  function hasDataChange(product) {
    if (product.dataChanged) return true;
    const base = initialData.products.find(item => item.id === product.id);
    if (!base) return product.sourceState === "new";
    const fields = ["name", "barcode", "category", "secondCategory", "thirdCategory", "fourthCategory", "grade", "newFlag", "faceWidth", "depth", "height", "shelfBoxes", "turnoverDays", "basePits", "plannedPits"];
    return fields.some(field => String(product[field] ?? "") !== String(base[field] ?? ""));
  }

  function activePool() {
    return currentProducts(false);
  }

  function shelfProducts() {
    return activePool().filter(product => actualPitCount(product.id) > 0);
  }

  function unplacedProducts() {
    return activePool().filter(product => actualPitCount(product.id) === 0);
  }

  function eliminatedProducts() {
    return currentProducts(true).filter(product => product.status === "eliminated");
  }

  function layerUsed(group, layer) {
    return ensureGroupLayer(group, layer).pits.reduce((sum, pit) => {
      const product = productById(pit.productId);
      return sum + (product ? integer(product.faceWidth) : 0);
    }, 0);
  }

  function layerRemaining(group, layer) {
    const layerData = ensureGroupLayer(group, layer);
    return integer(layerData.capacity) - layerUsed(group, layer);
  }

  function totalPitCount() {
    return currentGroups().reduce((groupSum, group) => (
      groupSum + layers.reduce((sum, layer) => sum + ensureGroupLayer(group, layer).pits.length, 0)
    ), 0);
  }

  function firstPlacement(productId) {
    return allPitsForProduct(productId)[0] || null;
  }

  function productPitSummary(group, layer, productId) {
    const pits = ensureGroupLayer(group, layer).pits.filter(pit => pit.productId === productId);
    return {
      total: pits.length,
      base: pits.filter(pit => pit.kind === "base").length,
      expansion: pits.filter(pit => pit.kind === "expansion").length
    };
  }

  function buildPits(product, count) {
    const safeCount = Math.max(1, integer(count, 1));
    const baseCount = Math.min(Math.max(1, integer(product.basePits, 1)), safeCount);
    return Array.from({ length: safeCount }, (_, index) => ({
      id: makeId("pit"),
      productId: product.id,
      kind: index < baseCount ? "base" : "expansion"
    }));
  }

  function removeProductPits(productId) {
    state.data.groups.forEach(group => {
      layers.forEach(layer => {
        const layerData = ensureGroupLayer(group, layer);
        layerData.pits = layerData.pits.filter(pit => pit.productId !== productId);
      });
    });
  }

  function validatePlacement(product, group, layer, count, releasedWidth = 0) {
    if (!group) return { ok: false, message: "未选择有效货架组。" };
    if (!layers.includes(layer)) return { ok: false, message: "未选择有效层级。" };
    const safeCount = Math.max(1, integer(count, 1));
    const basePits = Math.max(1, integer(product.basePits, 1));
    if (["B", "C", "D"].includes(layer) && product.grade === "D" && safeCount > basePits) {
      return { ok: false, message: "B/C/D层的D级SKU禁止增加扩陈坑位。" };
    }
    const need = integer(product.faceWidth) * safeCount;
    const available = layerRemaining(group, layer) + releasedWidth;
    if (need > available) {
      return { ok: false, message: `${group.id}-${layer}层余量不足：需要${need}mm，可用${available}mm。` };
    }
    return { ok: true };
  }

  function normalizeProductBlock(group, layer, productId) {
    const layerData = ensureGroupLayer(group, layer);
    const indexes = [];
    layerData.pits.forEach((pit, index) => {
      if (pit.productId === productId) indexes.push(index);
    });
    if (indexes.length <= 1) return;
    const firstIndex = indexes[0];
    const block = layerData.pits.filter(pit => pit.productId === productId);
    layerData.pits = layerData.pits.filter(pit => pit.productId !== productId);
    layerData.pits.splice(firstIndex, 0, ...block);
  }

  function applyPlannedPits(productId, requestedCount) {
    const product = productById(productId);
    if (!product) return;
    const count = Math.max(1, Math.min(20, integer(requestedCount, product.plannedPits || 1)));
    if (product.plannedPits !== count) product.dataChanged = true;
    product.plannedPits = count;
    const placements = allPitsForProduct(productId);

    if (!placements.length) {
      saveState();
      renderAll();
      setStatus(`${product.name}的计划坑位数已改为${count}，下次上架时使用。`);
      return;
    }

    const target = placements[0];
    const group = groupById(target.groupId);
    const oldWidth = placements
      .filter(item => item.groupId === target.groupId && item.layer === target.layer)
      .length * integer(product.faceWidth);

    const check = validatePlacement(product, group, target.layer, count, oldWidth);
    if (!check.ok) {
      renderAll();
      setStatus(check.message, true);
      return;
    }

    removeProductPits(productId);
    ensureGroupLayer(group, target.layer).pits.splice(target.index, 0, ...buildPits(product, count));
    normalizeProductBlock(group, target.layer, productId);
    saveState();
    renderAll();
    setStatus(`${product.name}已调整为${count}个坑位，货架长度和余量已同步。`);
  }

  function placeUnplacedProduct(productId, groupId = null, layer = null) {
    const product = productById(productId);
    if (!product || product.status === "eliminated") return;
    if (actualPitCount(productId) > 0) {
      setStatus("该SKU已经在货架上，请通过计划坑位数调整。", true);
      return;
    }

    const targetGroup = groupById(groupId || state.selectedTarget?.groupId);
    const targetLayer = layer || state.selectedTarget?.layer;
    if (!targetGroup || !targetLayer) {
      setStatus("请先点击陈列图中的目标货架层。", true);
      return;
    }

    const count = Math.max(1, integer(product.plannedPits, 1));
    const check = validatePlacement(product, targetGroup, targetLayer, count, 0);
    if (!check.ok) {
      setStatus(check.message, true);
      return;
    }

    ensureGroupLayer(targetGroup, targetLayer).pits.push(...buildPits(product, count));
    normalizeProductBlock(targetGroup, targetLayer, productId);
    saveState();
    renderAll();
    setStatus(`${product.name}已按计划${count}个坑位加入${targetGroup.id}-${targetLayer}层。`);
  }

  function downProduct(productId) {
    const product = productById(productId);
    if (!product) return;
    removeProductPits(productId);
    state.selectedProductId = null;
    saveState();
    renderAll();
    setStatus(`${product.name}已从陈列图下掉，自动进入未放入SKU池；商品数据和计划坑位仍保留。`);
  }

  function eliminateProduct(productId) {
    const product = productById(productId);
    if (!product) return;
    if (!window.confirm(`确认将“${product.name}”放入淘汰SKU池？商品数据会保留，可随时捞回。`)) return;
    removeProductPits(productId);
    product.status = "eliminated";
    state.selectedProductId = null;
    saveState();
    closeEditor();
    renderAll();
    setStatus(`${product.name}已进入淘汰SKU池，数据完整保留。`);
  }

  function restoreProduct(productId) {
    const product = productById(productId);
    if (!product) return;
    product.status = "active";
    saveState();
    renderAll();
    setStatus(`${product.name}已捞回，并进入未放入SKU池。`);
  }

  function removeSinglePit(productId, pitId) {
    const product = productById(productId);
    if (!product) return;
    let removed = false;
    state.data.groups.forEach(group => {
      layers.forEach(layer => {
        const layerData = ensureGroupLayer(group, layer);
        const before = layerData.pits.length;
        layerData.pits = layerData.pits.filter(pit => pit.id !== pitId);
        if (layerData.pits.length < before) removed = true;
      });
    });
    if (!removed) return;
    product.plannedPits = Math.max(1, actualPitCount(productId));
    saveState();
    renderAll();
    const remainingCount = actualPitCount(productId);
    setStatus(
      remainingCount
        ? `${product.name}已减少1个坑位，当前剩余${remainingCount}个坑位。`
        : `${product.name}已无货架坑位，自动进入未放入SKU池。`
    );
  }

  function moveProductBlock(productId, targetGroupId, targetLayer, beforePitId = null) {
    const product = productById(productId);
    const targetGroup = groupById(targetGroupId);
    if (!product || !targetGroup) return false;

    const placements = allPitsForProduct(productId);
    if (!placements.length) return false;

    const sourceBlock = placements.map(item => item.pit);
    const releasedWidth = placements
      .filter(item => item.groupId === targetGroupId && item.layer === targetLayer)
      .length * integer(product.faceWidth);

    const check = validatePlacement(product, targetGroup, targetLayer, sourceBlock.length, releasedWidth);
    if (!check.ok) {
      setStatus(check.message, true);
      return false;
    }

    removeProductPits(productId);
    const targetData = ensureGroupLayer(targetGroup, targetLayer);
    let insertionIndex = targetData.pits.length;
    if (beforePitId) {
      const found = targetData.pits.findIndex(pit => pit.id === beforePitId);
      if (found >= 0) insertionIndex = found;
    }
    targetData.pits.splice(insertionIndex, 0, ...sourceBlock);
    normalizeProductBlock(targetGroup, targetLayer, productId);
    state.selectedTarget = { groupId: targetGroupId, layer: targetLayer };
    state.selectedProductId = productId;
    state.lastMovedProductId = productId;
    state.lastMoveLabel = `${targetGroupId}-${targetLayer}层`;
    saveState();
    renderAll();
    requestAnimationFrame(() => {
      const moved = qs(`.pit[data-product-id="${CSS.escape(productId)}"]`);
      moved?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
    if (state.lastMoveTimer) window.clearTimeout(state.lastMoveTimer);
    state.lastMoveTimer = window.setTimeout(() => {
      if (state.lastMovedProductId !== productId) return;
      state.lastMovedProductId = null;
      state.lastMoveLabel = "";
      qsa(`.pit[data-product-id="${CSS.escape(productId)}"]`).forEach(node => {
        node.classList.remove("just-moved");
        node.querySelector(".move-badge")?.remove();
      });
      state.lastMoveTimer = null;
    }, 60_000);
    setStatus(`已移动：${product.name}的${sourceBlock.length}个坑位已整体移动到${targetGroupId}-${targetLayer}层，并以“刚移动”标记显示 1 分钟。`);
    return true;
  }

  function replaceSelectedProduct(newProductId) {
    const oldProduct = productById(state.selectedProductId);
    const newProduct = productById(newProductId);
    if (!oldProduct || !newProduct) {
      setStatus("请先在陈列图中选中需要替换的SKU。", true);
      return;
    }
    if (actualPitCount(newProduct.id) > 0) {
      setStatus("替换SKU必须来自未放入SKU池。", true);
      return;
    }

    const oldPlacements = allPitsForProduct(oldProduct.id);
    if (!oldPlacements.length) {
      setStatus("选中的SKU当前不在货架上。", true);
      return;
    }
    const first = oldPlacements[0];
    const group = groupById(first.groupId);
    const count = oldPlacements.length;
    const releasedWidth = count * integer(oldProduct.faceWidth);
    const check = validatePlacement(newProduct, group, first.layer, count, releasedWidth);
    if (!check.ok) {
      setStatus(check.message, true);
      return;
    }

    const insertionIndex = first.index;
    removeProductPits(oldProduct.id);
    newProduct.plannedPits = count;
    ensureGroupLayer(group, first.layer).pits.splice(insertionIndex, 0, ...buildPits(newProduct, count));
    normalizeProductBlock(group, first.layer, newProduct.id);
    state.selectedProductId = newProduct.id;
    saveState();
    renderAll();
    setStatus(`${newProduct.name}已替换${oldProduct.name}，沿用${count}个坑位；原SKU自动进入未放入池。`);
  }

  function locateProduct(productId) {
    const placement = firstPlacement(productId);
    if (!placement) {
      setStatus("该SKU当前未放入陈列图，无法定位。", true);
      return;
    }
    const group = groupById(placement.groupId);
    if (!group) return;
    state.currentCategory = group.category;
    state.secondaryFilter = "全部";
    state.selectedProductId = productId;
    state.selectedTarget = { groupId: placement.groupId, layer: placement.layer };
    renderAll();
    requestAnimationFrame(() => {
      const pits = qsa(`.pit[data-product-id="${CSS.escape(productId)}"]`);
      pits.forEach(pit => pit.classList.add("locating"));
      pits[0]?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      window.setTimeout(() => pits.forEach(pit => pit.classList.remove("locating")), 2_500);
    });
    setStatus("已定位到该SKU在陈列图中的位置。");
  }

  function openEditor(productId) {
    const product = productById(productId);
    if (!product) return;
    el("editId").value = product.id;
    el("editName").value = product.name || "";
    el("editBarcode").value = product.barcode || "";
    el("editCategory").value = product.category || state.currentCategory;
    el("editSecond").value = product.secondCategory || "";
    el("editThird").value = product.thirdCategory || "";
    el("editFourth").value = product.fourthCategory || "";
    el("editGrade").value = product.grade || "D";
    el("editNewFlag").value = product.newFlag === "新品" ? "新品" : "老品";
    el("editFaceWidth").value = integer(product.faceWidth, 1);
    el("editDepth").value = integer(product.depth, 1);
    el("editHeight").value = integer(product.height, 1);
    el("editShelfBoxes").value = integer(product.shelfBoxes, 0);
    el("editTurnover").value = number(product.turnoverDays, 0);
    el("editBasePits").value = Math.max(1, integer(product.basePits, 1));
    el("editPlannedPits").value = Math.max(1, integer(product.plannedPits, 1));
    el("editorDialog").showModal();
  }

  function closeEditor() {
    const dialog = el("editorDialog");
    if (dialog.open) dialog.close();
  }

  function saveEditor() {
    const product = productById(el("editId").value);
    if (!product) return;

    const previousCategory = product.category;
    const previousValues = JSON.stringify({ name: product.name, barcode: product.barcode, category: product.category, second: product.secondCategory, third: product.thirdCategory, fourth: product.fourthCategory, grade: product.grade, newFlag: product.newFlag, faceWidth: product.faceWidth, depth: product.depth, height: product.height, shelfBoxes: product.shelfBoxes, turnoverDays: product.turnoverDays, basePits: product.basePits, plannedPits: product.plannedPits });
    const nextCategory = el("editCategory").value;

    product.name = el("editName").value.trim() || product.name;
    product.barcode = el("editBarcode").value.trim() || product.barcode;
    product.category = nextCategory;
    product.secondCategory = el("editSecond").value.trim();
    product.thirdCategory = el("editThird").value.trim();
    product.fourthCategory = el("editFourth").value.trim();
    product.grade = el("editGrade").value;
    product.newFlag = el("editNewFlag").value;
    product.faceWidth = Math.max(1, integer(el("editFaceWidth").value, product.faceWidth));
    product.depth = Math.max(1, integer(el("editDepth").value, product.depth));
    product.height = Math.max(1, integer(el("editHeight").value, product.height));
    product.shelfBoxes = Math.max(0, integer(el("editShelfBoxes").value, 0));
    product.turnoverDays = Math.max(0, number(el("editTurnover").value, 0));
    product.basePits = Math.max(1, integer(el("editBasePits").value, 1));

    const planned = Math.max(1, integer(el("editPlannedPits").value, product.plannedPits));
    product.plannedPits = planned;
    const nextValues = JSON.stringify({ name: product.name, barcode: product.barcode, category: product.category, second: product.secondCategory, third: product.thirdCategory, fourth: product.fourthCategory, grade: product.grade, newFlag: product.newFlag, faceWidth: product.faceWidth, depth: product.depth, height: product.height, shelfBoxes: product.shelfBoxes, turnoverDays: product.turnoverDays, basePits: product.basePits, plannedPits: product.plannedPits });
    if (previousValues !== nextValues) product.dataChanged = true;

    if (previousCategory !== nextCategory) {
      removeProductPits(product.id);
      state.currentCategory = nextCategory;
      state.secondaryFilter = "全部";
      state.selectedProductId = null;
      state.selectedTarget = null;
      saveState();
      closeEditor();
      renderAll();
      setStatus(`${product.name}已改为${nextCategory}，原货架坑位已下掉，商品进入该品类的未放入SKU池。`);
      return;
    }

    saveState();
    closeEditor();
    applyPlannedPits(product.id, planned);

    const overflow = state.data.groups
      .filter(group => group.category === state.currentCategory)
      .flatMap(group => layers
        .filter(layer => layerRemaining(group, layer) < 0)
        .map(layer => `${group.id}-${layer}`));
    if (overflow.length) {
      setStatus(`数据已保存，但以下层级超容量：${overflow.join("、")}。请调整坑位。`, true);
    } else {
      setStatus("产品池数据已保存，陈列图内容、长度和余量已同步。");
    }
  }

  function addNewProduct() {
    const name = el("addName").value.trim();
    const barcode = el("addBarcode").value.trim();
    const second = el("addSecond").value.trim();
    const third = el("addThird").value.trim();
    if (!name || !barcode || !second || !third) {
      setStatus("请完整填写SKU品名、条码、二级类目和三级类目。", true);
      return;
    }
    if (state.data.products.some(product => product.barcode === barcode)) {
      setStatus("该条码已存在，请勿重复新增。", true);
      return;
    }

    const basePits = Math.max(1, integer(el("addBasePits").value, 1));
    const plannedPits = Math.max(1, integer(el("addPlannedPits").value, 1));
    const product = {
      id: makeId("sku"),
      category: state.currentCategory,
      secondCategory: second,
      thirdCategory: third,
      fourthCategory: "",
      barcode,
      name,
      price: 0,
      shelfLife: "",
      salesStatus: "在售",
      environment: "常温",
      dailySales: 0,
      rank: 9999,
      grade: el("addGrade").value,
      faceWidth: Math.max(1, integer(el("addFaceWidth").value, 360)),
      depth: Math.max(1, integer(el("addDepth").value, 300)),
      height: Math.max(1, integer(el("addHeight").value, 260)),
      packSize: 1,
      newDate: "",
      newFlag: el("addNewFlag").value,
      specifiedLayer: "",
      endcapBoxes: 0,
      floorBoxes: 0,
      cageBoxes: 0,
      shelfBoxes: Math.max(0, integer(el("addShelfBoxes").value, 1)),
      turnoverDays: Math.max(0, number(el("addTurnover").value, 6)),
      basePits,
      plannedPits,
      status: "active",
      sourceState: "new",
      dataChanged: true,
      specialDisplay: "",
      singleFaceCapacity: 1,
      depthCount: 1,
      stackCount: 1
    };

    state.data.products.push(product);
    saveState();

    if (el("addDirectly").checked) {
      placeUnplacedProduct(product.id);
    } else {
      renderAll();
      setStatus(`${product.name}已新增至总产品池，并进入未放入SKU池。`);
    }

    ["addName", "addBarcode", "addSecond", "addThird"].forEach(id => { el(id).value = ""; });
  }

  function renderCategoryBar() {
    const root = qs(".category-bar");
    root.innerHTML = categories().map(category => (
      `<button class="category-btn ${category === state.currentCategory ? "active" : ""}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`
    )).join("");
  }

  function renderSecondaryFilter() {
    const seconds = [...new Set(
      state.data.groups
        .filter(group => group.category === state.currentCategory)
        .map(group => group.secondCategory)
    )];
    const select = el("secondaryFilter");
    select.innerHTML = ["全部", ...seconds].map(value => (
      `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
    )).join("");
    if (!["全部", ...seconds].includes(state.secondaryFilter)) state.secondaryFilter = "全部";
    select.value = state.secondaryFilter;
  }

  function renderMetrics() {
    el("metricCategory").textContent = state.currentCategory;
    el("metricTotal").textContent = activePool().length;
    el("metricShelf").textContent = shelfProducts().length;
    el("metricUnplaced").textContent = unplacedProducts().length;
    el("metricEliminated").textContent = eliminatedProducts().length;
    el("metricPits").textContent = totalPitCount();
    el("targetLabel").textContent = state.selectedTarget
      ? `${state.selectedTarget.groupId}-${state.selectedTarget.layer}层`
      : "未选择";
    el("selectedLabel").textContent = productById(state.selectedProductId)?.name || "无";
  }

  function renderPit(group, layer, pit, index) {
    const product = productById(pit.productId);
    if (!product) return "";
    const layerData = ensureGroupLayer(group, layer);
    const samePits = layerData.pits.filter(item => item.productId === product.id);
    const localIndex = layerData.pits
      .slice(0, index + 1)
      .filter(item => item.productId === product.id).length;
    const basePits = samePits.filter(item => item.kind === "base");
    const expansionPits = samePits.filter(item => item.kind === "expansion");
    const kindIndex = layerData.pits
      .slice(0, index + 1)
      .filter(item => item.productId === product.id && item.kind === pit.kind).length;
    const kindTotal = pit.kind === "base" ? basePits.length : expansionPits.length;
    const kindText = pit.kind === "base"
      ? `基础 ${kindIndex}/${kindTotal}`
      : `【扩陈】${kindIndex}/${kindTotal}`;

    return `
      <article class="pit ${pit.kind === "expansion" ? "expansion" : ""} ${state.selectedProductId === product.id ? "selected" : ""} ${state.lastMovedProductId === product.id ? "just-moved" : ""} ${hasDataChange(product) ? "data-changed" : ""}"
        style="--face-width:${Math.max(80, integer(product.faceWidth, 100))}"
        draggable="true"
        data-pit-id="${escapeHtml(pit.id)}"
        data-product-id="${escapeHtml(product.id)}"
        data-group-id="${escapeHtml(group.id)}"
        data-layer="${layer}">
        ${state.lastMovedProductId === product.id ? `<span class="move-badge">刚移动 · ${escapeHtml(state.lastMoveLabel)}</span>` : ""}
        ${hasDataChange(product) ? `<span class="data-badge">数据已调整</span>` : ""}
        <h4>${escapeHtml(product.name)}</h4>
        <div class="pit-index">坑位 ${localIndex}/${samePits.length}</div>
        <div class="pit-kind">${kindText}</div>
        <div class="meta">${escapeHtml(product.grade)}级｜${escapeHtml(product.thirdCategory || "未分类")}</div>
        <div class="meta">${integer(product.faceWidth)}×${integer(product.depth)}×${integer(product.height)}mm</div>
        <div class="meta">货架${integer(product.shelfBoxes)}箱｜周转${number(product.turnoverDays).toFixed(1)}天</div>
        <div class="mini-actions">
          <button class="mini-btn edit-product" type="button" data-product-id="${escapeHtml(product.id)}">编辑</button>
          <button class="mini-btn down-product" type="button" data-product-id="${escapeHtml(product.id)}">下掉SKU</button>
        </div>
      </article>`;
  }

  function renderGroup(group) {
    const layerRows = layers.map(layer => {
      const layerData = ensureGroupLayer(group, layer);
      const used = layerUsed(group, layer);
      const remaining = layerRemaining(group, layer);
      const ratio = layerData.capacity ? Math.min(100, Math.max(0, used / layerData.capacity * 100)) : 0;
      const pitsHtml = layerData.pits.map((pit, index) => renderPit(group, layer, pit, index)).join("");
      const target = state.selectedTarget?.groupId === group.id && state.selectedTarget?.layer === layer;
      return `
        <div class="layer-row ${target ? "target" : ""}">
          <button class="layer-meta ${remaining < 0 ? "overflow" : ""}" type="button" data-target-group="${escapeHtml(group.id)}" data-target-layer="${layer}">
            <strong>${layer}层</strong>
            <span>容量 ${integer(layerData.capacity)}mm</span>
            <span>已用 ${used}mm｜余量 ${remaining}mm</span>
            <span>坑位 ${layerData.pits.length}</span>
            <div class="progress"><i style="width:${ratio}%"></i></div>
          </button>
          <div class="pit-track" data-drop-group="${escapeHtml(group.id)}" data-drop-layer="${layer}">
            ${pitsHtml || `<div class="empty">可拖入SKU模块</div>`}
          </div>
        </div>`;
    }).join("");

    return `
      <section class="group-card" data-group-card="${escapeHtml(group.id)}">
        <header class="group-header">
          <div><strong>${escapeHtml(group.secondCategory)}</strong>｜${escapeHtml(group.id)}</div>
          <small>${escapeHtml(group.type || "")}</small>
        </header>
        ${layerRows}
      </section>`;
  }

  function renderGroups() {
    const root = el("groupsContainer");
    root.style.transform = `scale(${number(el("zoomSelect").value, 1)})`;
    root.style.width = `${100 / number(el("zoomSelect").value, 1)}%`;
    const groups = currentGroups();
    root.innerHTML = groups.length
      ? groups.map(renderGroup).join("")
      : `<div class="empty">当前筛选下没有货架组。</div>`;
  }

  function poolCard(product) {
    const actual = actualPitCount(product.id);
    const stateName = productState(product);
    const stateLabel = stateName === "onShelf" ? "货架中" : "未放入";
    const stateClass = stateName === "onShelf" ? "state-on" : "state-unplaced";
    return `
      <article class="product-card">
        <div class="product-title-row">
          <div>
            <h3>${escapeHtml(product.name)}</h3>
            <div class="sub">${escapeHtml(product.barcode)}｜${escapeHtml(product.grade)}级｜${escapeHtml(product.secondCategory)} / ${escapeHtml(product.thirdCategory)}</div>
          </div>
          <span class="badge ${stateClass}">${stateLabel}</span>
        </div>
        <div class="numbers">当前坑位 <b>${actual}</b>｜正面宽${integer(product.faceWidth)}mm｜周转${number(product.turnoverDays).toFixed(1)}天</div>
        <div class="plan-control">
          <label class="field">计划坑位数
            <input class="planned-input" type="number" min="1" max="20" value="${Math.max(1, integer(product.plannedPits, 1))}" data-product-id="${escapeHtml(product.id)}">
          </label>
          <button class="btn apply-planned" type="button" data-product-id="${escapeHtml(product.id)}">应用</button>
        </div>
        <div class="product-actions">
          <button class="btn edit-product" type="button" data-product-id="${escapeHtml(product.id)}">编辑数据</button>
          ${actual ? `<button class="btn locate-product" type="button" data-product-id="${escapeHtml(product.id)}">定位陈列图</button>` : ""}
          ${actual
            ? `<button class="btn down-product" type="button" data-product-id="${escapeHtml(product.id)}">下掉SKU</button>`
            : `<button class="btn place-product" type="button" data-product-id="${escapeHtml(product.id)}">加入目标层</button>`}
          <button class="btn btn-danger-ghost eliminate-product" type="button" data-product-id="${escapeHtml(product.id)}">淘汰SKU</button>
        </div>
      </article>`;
  }

  function renderSelectedSkuDetail() {
    const root = el("selectedSkuDetail");
    const product = productById(state.selectedProductId);
    if (!product) {
      root.innerHTML = '<div class="selected-sku-empty">点击陈列图中的 SKU，可在此查看详细信息。</div>';
      return;
    }
    const currentPits = actualPitCount(product.id);
    root.innerHTML = `
      <article class="selected-sku-card">
        <div class="selected-sku-title"><span>当前选中 SKU</span><b>陈列图已选中</b></div>
        <h3>${escapeHtml(product.name)}</h3>
        <p>${escapeHtml(product.barcode)}｜${escapeHtml(product.grade)}级｜${escapeHtml(product.newFlag || "老品")}</p>
        <div class="selected-sku-grid">
          <span>品类：${escapeHtml(product.category)} / ${escapeHtml(product.secondCategory)} / ${escapeHtml(product.thirdCategory)}</span>
          <span>尺寸：${integer(product.faceWidth)} × ${integer(product.depth)} × ${integer(product.height)} mm</span>
          <span>坑位：当前 ${currentPits}｜计划 ${Math.max(1, integer(product.plannedPits, 1))}</span>
          <span>货架：${integer(product.shelfBoxes)} 箱｜周转 ${number(product.turnoverDays).toFixed(1)} 天</span>
        </div>
        <div class="product-actions">
          <button class="btn locate-product" type="button" data-product-id="${escapeHtml(product.id)}">定位陈列图</button>
          <button class="btn edit-product" type="button" data-product-id="${escapeHtml(product.id)}">编辑数据</button>
        </div>
      </article>`;
  }

  function renderTotalPool() {
    const query = el("totalSearch").value.trim().toLowerCase();
    const list = activePool().filter(product => (
      [product.name, product.barcode, product.secondCategory, product.thirdCategory]
        .some(value => String(value || "").toLowerCase().includes(query))
    ));
    el("totalPoolList").innerHTML = list.length
      ? list.map(poolCard).join("")
      : `<div class="empty">没有匹配的SKU。</div>`;
  }

  function renderUnplacedPool() {
    const list = unplacedProducts();
    el("unplacedList").innerHTML = list.length
      ? list.map(product => `
        <article class="product-card">
          <div class="product-title-row">
            <div><h3>${escapeHtml(product.name)}</h3><div class="sub">${escapeHtml(product.barcode)}｜${escapeHtml(product.grade)}级｜${escapeHtml(product.secondCategory)} / ${escapeHtml(product.thirdCategory)}</div></div>
            <span class="badge state-unplaced">计划${Math.max(1, integer(product.plannedPits, 1))}坑</span>
          </div>
          <div class="numbers">正面宽${integer(product.faceWidth)}mm｜货架${integer(product.shelfBoxes)}箱｜周转${number(product.turnoverDays).toFixed(1)}天</div>
          <div class="product-actions">
            <button class="btn place-product" type="button" data-product-id="${escapeHtml(product.id)}">加入目标层</button>
            <button class="btn replace-selected" type="button" data-product-id="${escapeHtml(product.id)}">替换选中SKU</button>
            <button class="btn edit-product" type="button" data-product-id="${escapeHtml(product.id)}">编辑数据</button>
            <button class="btn btn-danger-ghost eliminate-product" type="button" data-product-id="${escapeHtml(product.id)}">淘汰SKU</button>
          </div>
        </article>`).join("")
      : `<div class="empty">当前没有未放入SKU。</div>`;
  }

  function renderEliminatedPool() {
    const list = eliminatedProducts();
    el("eliminatedList").innerHTML = list.length
      ? list.map(product => `
        <article class="product-card">
          <div class="product-title-row">
            <div><h3>${escapeHtml(product.name)}</h3><div class="sub">${escapeHtml(product.barcode)}｜${escapeHtml(product.grade)}级｜${escapeHtml(product.secondCategory)} / ${escapeHtml(product.thirdCategory)}</div></div>
            <span class="badge state-eliminated">淘汰</span>
          </div>
          <div class="numbers">历史计划${Math.max(1, integer(product.plannedPits, 1))}坑｜正面宽${integer(product.faceWidth)}mm｜周转${number(product.turnoverDays).toFixed(1)}天</div>
          <div class="product-actions">
            <button class="btn restore-product" type="button" data-product-id="${escapeHtml(product.id)}">捞回至未放入池</button>
            <button class="btn edit-product" type="button" data-product-id="${escapeHtml(product.id)}">查看/编辑数据</button>
          </div>
        </article>`).join("")
      : `<div class="empty">当前没有淘汰SKU。</div>`;
  }

  function renderTabs() {
    qsa(".pool-tab").forEach(button => {
      button.classList.toggle("active", button.dataset.panel === state.activePanel);
    });
    qsa(".pool-section").forEach(panel => {
      panel.classList.toggle("active", panel.id === `panel-${state.activePanel}`);
    });
  }

  function renderAll() {
    const targetGroup = groupById(state.selectedTarget?.groupId);
    if (!targetGroup || targetGroup.category !== state.currentCategory) {
      const fallback = state.data.groups.find(group => group.category === state.currentCategory);
      state.selectedTarget = fallback ? { groupId: fallback.id, layer: "B" } : null;
    }
    renderCategoryBar();
    renderSecondaryFilter();
    renderMetrics();
    renderGroups();
    renderSelectedSkuDetail();
    renderTabs();
    renderTotalPool();
    renderUnplacedPool();
    renderEliminatedPool();
  }

  function buildPdfPage(group) {
    const layerHtml = layers.map(layer => {
      const layerData = ensureGroupLayer(group, layer);
      const used = layerUsed(group, layer);
      const remain = layerRemaining(group, layer);
      const pitHtml = layerData.pits.map((pit, index) => {
        const product = productById(pit.productId);
        if (!product) return "";
        const summary = productPitSummary(group, layer, product.id);
        const local = layerData.pits.slice(0, index + 1).filter(item => item.productId === product.id).length;
        return `
          <div class="pdf-pit ${pit.kind === "expansion" ? "expansion" : ""}">
            <strong>${escapeHtml(product.name)}</strong><br>
            坑位${local}/${summary.total}｜${pit.kind === "base" ? "基础" : "扩陈"}<br>
            ${escapeHtml(product.grade)}级｜${escapeHtml(product.thirdCategory || "未分类")}<br>
            ${integer(product.faceWidth)}×${integer(product.depth)}×${integer(product.height)}mm<br>
            货架${integer(product.shelfBoxes)}箱｜周转${number(product.turnoverDays).toFixed(1)}天
          </div>`;
      }).join("");
      return `
        <div class="pdf-layer">
          <div class="pdf-layer-meta"><strong>${layer}层</strong><br>容量${integer(layerData.capacity)}mm<br>已用${used}mm｜余${remain}mm<br>坑位${layerData.pits.length}</div>
          <div class="pdf-pits">${pitHtml || "空层"}</div>
        </div>`;
    }).join("");

    return `
      <section class="pdf-page">
        <h2>${escapeHtml(state.currentCategory)}｜${escapeHtml(group.secondCategory)}｜${escapeHtml(group.id)}</h2>
        <div class="pdf-sub">导出时间：${new Date().toLocaleString("zh-CN")}｜白色=基础坑位｜浅蓝灰=扩陈坑位</div>
        ${layerHtml}
      </section>`;
  }

  async function exportCurrentCategoryPdf() {
    if (!window.html2canvas || !window.jspdf?.jsPDF) {
      setStatus("PDF组件未加载，请检查网络后重试。", true);
      return;
    }
    const groups = state.data.groups.filter(group => group.category === state.currentCategory);
    if (!groups.length) {
      setStatus("当前品类没有可导出的货架组。", true);
      return;
    }

    const button = el("exportPdfBtn");
    button.disabled = true;
    button.textContent = "正在生成PDF…";
    const staging = el("pdfStaging");
    staging.innerHTML = groups.map(buildPdfPage).join("");

    try {
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3", compress: true });
      const pageWidth = 420;
      const pageHeight = 297;
      const margin = 8;
      const pages = qsa(".pdf-page", staging);

      for (let index = 0; index < pages.length; index += 1) {
        const canvas = await window.html2canvas(pages[index], {
          scale: 1.6,
          backgroundColor: "#ffffff",
          useCORS: true,
          logging: false
        });
        const image = canvas.toDataURL("image/jpeg", 0.92);
        const maxWidth = pageWidth - margin * 2;
        const maxHeight = pageHeight - margin * 2;
        const ratio = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
        const width = canvas.width * ratio;
        const height = canvas.height * ratio;
        if (index > 0) pdf.addPage("a3", "landscape");
        pdf.addImage(image, "JPEG", (pageWidth - width) / 2, margin, width, height);
      }

      pdf.save(`${state.currentCategory}_陈列图_${new Date().toISOString().slice(0, 10)}.pdf`);
      setStatus(`${state.currentCategory}陈列图PDF已生成，共${groups.length}页。`);
    } catch (error) {
      console.error(error);
      setStatus("PDF生成失败，请刷新页面或检查浏览器下载权限。", true);
    } finally {
      staging.innerHTML = "";
      button.disabled = false;
      button.textContent = "导出当前品类PDF";
    }
  }

  function backupJson() {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `陈列系统数据备份_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus("数据备份JSON已导出。");
  }

  async function importJson(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.groups)) {
        throw new Error("文件结构不正确");
      }
      state.data = parsed;
      state.currentCategory = parsed.categories?.[0] || state.currentCategory;
      state.secondaryFilter = "全部";
      state.selectedProductId = null;
      state.selectedTarget = null;
      saveState();
      renderAll();
      setStatus("数据JSON已导入。");
    } catch (error) {
      setStatus(`导入失败：${error.message}`, true);
    } finally {
      el("restoreInput").value = "";
    }
  }

  function resetToBottomTable() {
    if (!window.confirm("确认恢复底表初始数据？浏览器中的人工调整将被清除。")) return;
    state.data = clone(initialData);
    state.currentCategory = initialData.categories[0] || "";
    state.secondaryFilter = "全部";
    state.selectedProductId = null;
    state.selectedTarget = null;
    saveState();
    renderAll();
    setStatus("已恢复最后确认版底表数据。");
  }

  function handleClick(event) {
    const categoryButton = event.target.closest(".category-btn");
    if (categoryButton) {
      state.currentCategory = categoryButton.dataset.category;
      state.secondaryFilter = "全部";
      state.selectedProductId = null;
      state.selectedTarget = null;
      renderAll();
      setStatus(`已切换至${state.currentCategory}。`);
      return;
    }

    const tab = event.target.closest(".pool-tab");
    if (tab) {
      state.activePanel = tab.dataset.panel;
      renderTabs();
      return;
    }

    const target = event.target.closest("[data-target-group]");
    if (target) {
      state.selectedTarget = {
        groupId: target.dataset.targetGroup,
        layer: target.dataset.targetLayer
      };
      renderAll();
      setStatus(`目标位置已设为${state.selectedTarget.groupId}-${state.selectedTarget.layer}层。`);
      return;
    }

    const pit = event.target.closest(".pit");
    if (pit && !event.target.closest("button")) {
      state.selectedProductId = pit.dataset.productId;
      state.selectedTarget = { groupId: pit.dataset.groupId, layer: pit.dataset.layer };
      renderAll();
      setStatus("已选中SKU，可从未放入池执行替换。");
      return;
    }

    const buttonMap = [
      [".apply-planned", button => {
        const input = qsa(".planned-input").find(item => item.dataset.productId === button.dataset.productId);
        applyPlannedPits(button.dataset.productId, input?.value);
      }],
      [".place-product", button => placeUnplacedProduct(button.dataset.productId)],
      [".down-product", button => downProduct(button.dataset.productId)],
      [".eliminate-product", button => eliminateProduct(button.dataset.productId)],
      [".restore-product", button => restoreProduct(button.dataset.productId)],
      [".replace-selected", button => replaceSelectedProduct(button.dataset.productId)],
      [".locate-product", button => locateProduct(button.dataset.productId)],
      [".edit-product", button => openEditor(button.dataset.productId)]
    ];
    for (const [selector, handler] of buttonMap) {
      const button = event.target.closest(selector);
      if (button) {
        event.stopPropagation();
        handler(button);
        return;
      }
    }
  }

  function handleDragStart(event) {
    const pit = event.target.closest(".pit");
    if (!pit) return;
    state.dragPayload = {
      productId: pit.dataset.productId,
      pitId: pit.dataset.pitId,
      groupId: pit.dataset.groupId,
      layer: pit.dataset.layer
    };
    if (state.lastMoveTimer) window.clearTimeout(state.lastMoveTimer);
    state.lastMoveTimer = null;
    state.lastMovedProductId = null;
    state.lastMoveLabel = "";
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/json", JSON.stringify(state.dragPayload));
    qsa(`.pit[data-product-id="${CSS.escape(pit.dataset.productId)}"]`).forEach(node => node.classList.add("dragging-block"));
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = `移动：${pit.querySelector("h4")?.textContent || "SKU"}`;
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 18, 18);
    requestAnimationFrame(() => ghost.remove());
  }

  function handleDragEnd(event) {
    event.target.closest(".pit")?.classList.remove("dragging");
    qsa(".dragging-block, .drag-over, .drop-before").forEach(node => node.classList.remove("dragging-block", "drag-over", "drop-before"));
    state.dragHoverEl = null;
  }

  function handleDragOver(event) {
    const targetPit = event.target.closest(".pit");
    const target = event.target.closest(".pit-track, #singlePitRemoveZone");
    if (!target && !targetPit) return;
    event.preventDefault();
    const activeTarget = target || targetPit.parentElement;
    if (state.dragHoverEl !== activeTarget) {
      state.dragHoverEl?.classList.remove("drag-over");
      qsa(".drop-before").forEach(node => node.classList.remove("drop-before"));
      state.dragHoverEl = activeTarget;
      activeTarget?.classList.add("drag-over");
      targetPit?.classList.add("drop-before");
    }
    event.dataTransfer.dropEffect = "move";
  }

  function handleDragLeave(event) {
    const leaving = event.target.closest(".pit-track, #singlePitRemoveZone");
    if (leaving && !leaving.contains(event.relatedTarget)) {
      leaving.classList.remove("drag-over");
      if (state.dragHoverEl === leaving) state.dragHoverEl = null;
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    qsa(".drag-over, .drop-before").forEach(node => node.classList.remove("drag-over", "drop-before"));
    state.dragHoverEl = null;
    let payload = state.dragPayload;
    try {
      payload = JSON.parse(event.dataTransfer.getData("application/json")) || payload;
    } catch (_) {}
    if (!payload) return;

    if (event.target.closest("#singlePitRemoveZone")) {
      removeSinglePit(payload.productId, payload.pitId);
      return;
    }

    const targetPit = event.target.closest(".pit");
    const track = event.target.closest(".pit-track");
    const targetGroupId = targetPit?.dataset.groupId || track?.dataset.dropGroup;
    const targetLayer = targetPit?.dataset.layer || track?.dataset.dropLayer;
    const beforePitId = targetPit?.dataset.pitId || null;
    if (targetGroupId && targetLayer) {
      moveProductBlock(payload.productId, targetGroupId, targetLayer, beforePitId);
    }
  }

  function initializeControls() {
    el("editCategory").innerHTML = categories()
      .map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");

    document.addEventListener("click", handleClick);
    document.addEventListener("dragstart", handleDragStart);
    document.addEventListener("dragend", handleDragEnd);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);

    el("secondaryFilter").addEventListener("change", event => {
      state.secondaryFilter = event.target.value;
      state.selectedTarget = null;
      renderAll();
    });
    el("zoomSelect").addEventListener("change", renderGroups);
    el("totalSearch").addEventListener("input", renderTotalPool);
    el("exportPdfBtn").addEventListener("click", exportCurrentCategoryPdf);
    el("backupBtn").addEventListener("click", backupJson);
    el("restoreInput").addEventListener("change", event => importJson(event.target.files?.[0]));
    el("resetBtn").addEventListener("click", resetToBottomTable);
    el("addSkuBtn").addEventListener("click", addNewProduct);

    el("closeEditorBtn").addEventListener("click", closeEditor);
    el("saveEditorBtn").addEventListener("click", saveEditor);
    el("downEditorBtn").addEventListener("click", () => {
      const id = el("editId").value;
      closeEditor();
      downProduct(id);
    });
    el("eliminateEditorBtn").addEventListener("click", () => eliminateProduct(el("editId").value));
    el("editorDialog").addEventListener("click", event => {
      if (event.target === el("editorDialog")) closeEditor();
    });
  }

  if (!state.currentCategory || !categories().includes(state.currentCategory)) {
    state.currentCategory = categories()[0] || "";
  }
  initializeControls();
  renderAll();
})();
