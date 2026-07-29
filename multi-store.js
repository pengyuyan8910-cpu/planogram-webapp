(() => {
  "use strict";

  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const STORE_PREFIX = "planogram-store-state-v1::";
  const ORIGINAL_STORE_ID = "hexian-xiaoshikou";
  const originalData = JSON.parse(JSON.stringify(window.PLANOGRAM_INITIAL_DATA || { categories: [], products: [], groups: [] }));
  const allocationRoot = window.PLANOGRAM_STORE_ALLOCATIONS || { stores: {} };
  const storeConfigs = allocationRoot.stores || {};
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;

  const clone = value => JSON.parse(JSON.stringify(value));
  const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
  const parseJson = value => {
    try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
  };
  const validData = value => value && Array.isArray(value.products) && Array.isArray(value.groups);
  const storeKey = storeId => STORE_PREFIX + storeId;
  const availableStoreIds = () => [ORIGINAL_STORE_ID, ...Object.keys(storeConfigs)];
  const storeName = storeId => storeId === ORIGINAL_STORE_ID
    ? "和县小市口生活馆"
    : (storeConfigs[storeId]?.name || storeId);

  function buildStoreInitial(storeId) {
    if (storeId === ORIGINAL_STORE_ID || !storeConfigs[storeId]) {
      const original = clone(originalData);
      original.storeId = ORIGINAL_STORE_ID;
      original.storeName = "和县小市口生活馆";
      return original;
    }
    const config = storeConfigs[storeId];
    const overrides = config.productOverrides || {};
    const products = originalData.products.map(product => ({
      ...clone(product),
      ...(overrides[String(product.barcode)] || {})
    }));
    const byBarcode = new Map(products.map(product => [String(product.barcode), product]));
    const groups = (config.groups || []).map(sourceGroup => {
      const group = clone(sourceGroup);
      ["A", "B", "C", "D"].forEach(layer => {
        const layerData = group.layers?.[layer] || { capacity: 1200, pits: [] };
        layerData.pits = (layerData.pits || []).flatMap(pit => {
          const product = byBarcode.get(String(pit.barcode || ""));
          return product ? [{ ...pit, productId: product.id }] : [];
        });
        group.layers[layer] = layerData;
      });
      return group;
    });
    const groupCategories = new Set(groups.map(group => group.category));
    const categories = [
      ...(originalData.categories || []).filter(category => groupCategories.has(category)),
      ...[...groupCategories].filter(category => !(originalData.categories || []).includes(category))
    ];
    return {
      ...clone(originalData),
      version: `multistore-${allocationRoot.version || "1"}`,
      source: `多门店陈列生成-${config.name}`,
      storeId,
      storeName: config.name,
      categories,
      products,
      groups,
      storeMeta: clone(config.meta || {}),
      generatedAt: allocationRoot.generatedAt || ""
    };
  }

  function writeRaw(key, value) {
    nativeSetItem.call(window.localStorage, key, value);
  }

  function saveMainToStore(storeId) {
    const current = window.localStorage.getItem(MAIN_KEY);
    if (validData(parseJson(current))) writeRaw(storeKey(storeId), current);
  }

  function loadStoreState(storeId) {
    const saved = parseJson(window.localStorage.getItem(storeKey(storeId)));
    return validData(saved) ? saved : buildStoreInitial(storeId);
  }

  function prepareSelectedStore() {
    const ids = availableStoreIds();
    let selected = window.localStorage.getItem(SELECTED_KEY) || ORIGINAL_STORE_ID;
    if (!ids.includes(selected)) selected = ORIGINAL_STORE_ID;
    let active = window.localStorage.getItem(ACTIVE_KEY);
    const currentMain = parseJson(window.localStorage.getItem(MAIN_KEY));

    if (!active || !ids.includes(active)) {
      active = ORIGINAL_STORE_ID;
      if (validData(currentMain) && !window.localStorage.getItem(storeKey(ORIGINAL_STORE_ID))) {
        writeRaw(storeKey(ORIGINAL_STORE_ID), JSON.stringify(currentMain));
      }
    }

    if (active !== selected) {
      if (validData(currentMain)) saveMainToStore(active);
      writeRaw(MAIN_KEY, JSON.stringify(loadStoreState(selected)));
    } else if (!validData(currentMain)) {
      writeRaw(MAIN_KEY, JSON.stringify(loadStoreState(selected)));
    }

    writeRaw(SELECTED_KEY, selected);
    writeRaw(ACTIVE_KEY, selected);
    window.PLANOGRAM_INITIAL_DATA = buildStoreInitial(selected);
    window.PLANOGRAM_STORE_CONTEXT = {
      storeId: selected,
      storeName: storeName(selected),
      isOriginalStore: selected === ORIGINAL_STORE_ID,
      config: selected === ORIGINAL_STORE_ID ? null : storeConfigs[selected]
    };
    return selected;
  }

  const selectedStoreId = prepareSelectedStore();

  Storage.prototype.setItem = function(key, value) {
    nativeSetItem.call(this, key, value);
    if (this === window.localStorage && key === MAIN_KEY) {
      const active = window.localStorage.getItem(ACTIVE_KEY) || selectedStoreId;
      nativeSetItem.call(this, storeKey(active), value);
    }
  };

  function switchStore(nextStoreId) {
    const currentStoreId = window.localStorage.getItem(ACTIVE_KEY) || selectedStoreId;
    saveMainToStore(currentStoreId);
    writeRaw(SELECTED_KEY, nextStoreId);
    writeRaw(ACTIVE_KEY, nextStoreId);
    writeRaw(MAIN_KEY, JSON.stringify(loadStoreState(nextStoreId)));
    window.location.reload();
  }

  function resetCurrentStore() {
    if (!window.confirm(`确认恢复“${storeName(selectedStoreId)}”的首版陈列数据吗？当前门店在本浏览器中的调整会被清除。`)) return;
    nativeRemoveItem.call(window.localStorage, storeKey(selectedStoreId));
    writeRaw(MAIN_KEY, JSON.stringify(buildStoreInitial(selectedStoreId)));
    window.location.reload();
  }

  function pointDialogHtml(config) {
    const meta = config?.meta || {};
    const stats = meta.stats || {};
    const points = meta.specialPoints || [];
    const cold = meta.coldEquipment || [];
    const anomalies = meta.anomalies || [];
    const pointRows = points.map(item => `
      <tr>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.pointId)}</td>
        <td>${escapeHtml(item.secondCategory)}</td>
        <td>${escapeHtml(item.productName || "待匹配")}</td>
        <td>${item.boxes || "—"}</td>
        <td>${escapeHtml(item.notes || "")}</td>
      </tr>`).join("");
    const coldRows = cold.map(item => `
      <tr>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.secondCategory)}</td>
        <td>${escapeHtml(item.fixture)}</td>
        <td>${item.candidateSkus?.length || 0}</td>
      </tr>`).join("");
    const anomalyRows = anomalies.slice(0, 30).map(item => `
      <li><b>${escapeHtml(item.type)}</b>：${escapeHtml(item.detail || item.name || "")}</li>`).join("");
    return `
      <div class="dialog-header">
        <div><p class="eyebrow">门店独立陈列数据</p><h2>${escapeHtml(config.name)}点位与复核</h2></div>
        <button id="closeStorePointDialog" class="icon-btn" type="button">×</button>
      </div>
      <div class="store-summary-grid">
        <article><span>标准货架</span><strong>${stats.ordinaryGroups || config.shelfCount || 0}节</strong></article>
        <article><span>已陈列SKU</span><strong>${stats.placedSkus || 0}</strong></article>
        <article><span>未放入SKU</span><strong>${stats.unplacedRecords || 0}</strong></article>
        <article><span>陈列坑位</span><strong>${stats.pitCount || 0}</strong></article>
      </div>
      <section class="store-point-section">
        <h3>端头、地堆、笼车、花车及附加常温层板</h3>
        <div class="store-table-wrap"><table><thead><tr><th>类型</th><th>点位</th><th>二级类目</th><th>匹配SKU</th><th>箱数</th><th>原表备注</th></tr></thead><tbody>${pointRows || '<tr><td colspan="6">无</td></tr>'}</tbody></table></div>
      </section>
      <section class="store-point-section">
        <h3>冷藏/冷冻设备明细</h3>
        <div class="store-table-wrap"><table><thead><tr><th>类型</th><th>二级类目</th><th>柜号/长度</th><th>产品池候选SKU</th></tr></thead><tbody>${coldRows || '<tr><td colspan="4">原表未提供冷柜点位</td></tr>'}</tbody></table></div>
      </section>
      <section class="store-point-section"><h3>异常复核（前30项）</h3><ul class="store-anomaly-list">${anomalyRows || '<li>无专用点位异常。</li>'}</ul></section>`;
  }

  function injectUi() {
    const context = window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot = document.querySelector(".topbar > div:first-child");
    const eyebrow = titleRoot?.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = context.storeName;
    document.title = `${context.storeName}｜全品类可视化陈列系统`;

    const holder = document.createElement("div");
    holder.className = "store-switcher";
    holder.innerHTML = `
      <label for="storeSelect">门店</label>
      <select id="storeSelect" aria-label="选择门店">
        ${availableStoreIds().map(id => `<option value="${escapeHtml(id)}" ${id === selectedStoreId ? "selected" : ""}>${escapeHtml(storeName(id))}</option>`).join("")}
      </select>
      ${context.isOriginalStore ? "" : '<button id="storePointBtn" class="btn" type="button">门店点位</button><button id="resetCurrentStoreBtn" class="btn btn-danger-ghost" type="button">恢复当前门店首版</button>'}
    `;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change", event => switchStore(event.target.value));
    holder.querySelector("#resetCurrentStoreBtn")?.addEventListener("click", resetCurrentStore);

    if (!context.isOriginalStore) {
      ["cloudBtn", "exportCloudExcelBtn", "resetBtn"].forEach(id => {
        const node = document.getElementById(id);
        if (node) node.hidden = true;
      });
      const status = document.getElementById("statusBar");
      if (status) status.textContent = `${context.storeName}使用独立门店数据；产品池共用，门店坑位与本地调整互不覆盖。`;
      const dialog = document.createElement("dialog");
      dialog.id = "storePointDialog";
      dialog.className = "editor-dialog admin-dialog store-point-dialog";
      dialog.innerHTML = pointDialogHtml(context.config);
      document.body.appendChild(dialog);
      holder.querySelector("#storePointBtn")?.addEventListener("click", () => dialog.showModal());
      dialog.querySelector("#closeStorePointDialog")?.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectUi);
  else injectUi();
})();
