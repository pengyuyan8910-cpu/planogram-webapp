(() => {
  "use strict";

  const VERSION = "2026.08.03.04";
  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const STORE_PREFIX = "planogram-store-state-v1::";
  const ORIGINAL_STORE_ID = "hexian-xiaoshikou";
  const CLOUD_DOCUMENT_ID = "main";
  const LAYERS = ["A", "B", "C", "D"];

  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const originalData = clone(window.PLANOGRAM_INITIAL_DATA || { categories: [], products: [], groups: [] });
  const allocationRoot = window.PLANOGRAM_STORE_ALLOCATIONS || { stores: {} };
  const storeConfigs = allocationRoot.stores || {};
  const STORE_IDS = [ORIGINAL_STORE_ID, ...Object.keys(storeConfigs)];
  let virtualMainValue = null;

  const rawLocalSnapshot = {};
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.includes("planogram")) rawLocalSnapshot[key] = nativeGetItem.call(window.localStorage, key);
    }
  } catch (_) {}

  const nativeSupabaseCreateClient = window.supabase?.createClient?.bind(window.supabase);
  if (nativeSupabaseCreateClient) {
    window.supabase.createClient = (...args) => {
      const client = nativeSupabaseCreateClient(...args);
      window.PLANOGRAM_CLOUD_CLIENT = client;
      return client;
    };
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function parseJson(value) {
    try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
  }

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function validProduct(item) {
    return isRecord(item) && typeof item.id === "string" && item.id.trim();
  }

  function validGroup(item) {
    return isRecord(item) && typeof item.id === "string" && item.id.trim();
  }

  function cleanProduct(item) {
    return validProduct(item) ? clone(item) : null;
  }

  function cleanGroup(group) {
    if (!validGroup(group)) return null;
    const next = { ...clone(group), layers: isRecord(group.layers) ? clone(group.layers) : {} };
    LAYERS.forEach(layer => {
      const source = isRecord(next.layers[layer]) ? next.layers[layer] : {};
      next.layers[layer] = {
        ...source,
        capacity: Number.isFinite(Number(source.capacity)) ? Number(source.capacity) : 0,
        pits: (Array.isArray(source.pits) ? source.pits : []).filter(pit => isRecord(pit))
      };
    });
    return next;
  }

  function cleanData(value) {
    if (!isRecord(value)) return null;
    const products = (Array.isArray(value.products) ? value.products : []).map(cleanProduct).filter(Boolean);
    const groups = (Array.isArray(value.groups) ? value.groups : []).map(cleanGroup).filter(Boolean);
    const categories = (Array.isArray(value.categories) ? value.categories : []).filter(item => typeof item === "string" && item.trim());
    return { ...clone(value), products, groups, categories };
  }

  function storeName(storeId) {
    return storeId === ORIGINAL_STORE_ID
      ? "和县小市口生活馆"
      : (storeConfigs[storeId]?.name || storeId);
  }

  function storeKey(storeId) {
    return STORE_PREFIX + storeId;
  }

  function buildStoreInitial(storeId) {
    if (storeId === ORIGINAL_STORE_ID || !storeConfigs[storeId]) {
      return {
        ...clone(originalData),
        storeId: ORIGINAL_STORE_ID,
        storeName: storeName(ORIGINAL_STORE_ID)
      };
    }

    const config = storeConfigs[storeId];
    const overrides = config.productOverrides || {};
    const products = (originalData.products || []).map(product => ({
      ...clone(product),
      ...(overrides[String(product.barcode)] || {})
    })).filter(validProduct);
    const byBarcode = new Map(products.map(product => [String(product.barcode || ""), product]));
    const groups = (config.groups || []).map(cleanGroup).filter(Boolean).map(group => {
      LAYERS.forEach(layer => {
        group.layers[layer].pits = group.layers[layer].pits.flatMap(pit => {
          const product = byBarcode.get(String(pit.barcode || ""));
          if (!product) return [];
          return [{ ...pit, productId: product.id }];
        });
      });
      return group;
    });
    const groupCategories = new Set(groups.map(group => group.category).filter(Boolean));
    const categories = [
      ...(originalData.categories || []).filter(category => groupCategories.has(category)),
      ...[...groupCategories].filter(category => !(originalData.categories || []).includes(category))
    ];

    return {
      ...clone(originalData),
      version: `multistore-${allocationRoot.version || VERSION}`,
      source: `多门店陈列生成-${config.name}`,
      storeId,
      storeName: config.name,
      layoutVersion: config.layoutVersion || allocationRoot.version || VERSION,
      layoutMode: config.layoutMode || "continuous-shelf-bands",
      categories,
      products,
      groups,
      storeMeta: clone(config.meta || {}),
      generatedAt: allocationRoot.generatedAt || ""
    };
  }

  function mergeProducts(baseProducts, rawProducts) {
    const order = [];
    const map = new Map();
    const barcodeToId = new Map();
    const add = (item, overwrite) => {
      if (!validProduct(item)) return;
      const id = String(item.id);
      const barcode = String(item.barcode || "");
      const existingId = map.has(id) ? id : (barcode && barcodeToId.get(barcode));
      const key = existingId || id;
      if (!map.has(key)) order.push(key);
      map.set(key, overwrite && map.has(key) ? { ...map.get(key), ...clone(item) } : clone(item));
      if (barcode) barcodeToId.set(barcode, key);
    };
    (baseProducts || []).forEach(item => add(item, false));
    (rawProducts || []).forEach(item => add(item, true));
    return order.map(key => map.get(key)).filter(Boolean);
  }

  function mergeGroups(baseGroups, rawGroups) {
    const base = (baseGroups || []).map(cleanGroup).filter(Boolean);
    const raw = (rawGroups || []).map(cleanGroup).filter(Boolean);
    if (!raw.length) return base;
    const rawById = new Map(raw.map(group => [group.id, group]));
    const merged = base.map(group => rawById.get(group.id) || group);
    const baseIds = new Set(base.map(group => group.id));
    raw.forEach(group => { if (!baseIds.has(group.id)) merged.push(group); });
    return merged;
  }

  function salvageData(storeId, value) {
    const base = buildStoreInitial(storeId);
    const raw = cleanData(value) || { products: [], groups: [], categories: [] };
    const products = mergeProducts(base.products || [], raw.products || []);
    const groups = mergeGroups(base.groups || [], raw.groups || []);
    if (!products.length || (!groups.length && storeId !== ORIGINAL_STORE_ID)) return null;

    const productIds = new Set(products.map(item => item.id));
    const byBarcode = new Map(products.map(item => [String(item.barcode || ""), item.id]));
    groups.forEach(group => {
      LAYERS.forEach(layer => {
        group.layers[layer].pits = group.layers[layer].pits.flatMap(pit => {
          let productId = typeof pit.productId === "string" ? pit.productId.trim() : "";
          if (!productId && pit.barcode) productId = byBarcode.get(String(pit.barcode)) || "";
          return productId && productIds.has(productId) ? [{ ...pit, productId }] : [];
        });
      });
    });

    const categories = raw.categories?.length ? raw.categories : (base.categories || []);
    return {
      ...clone(base),
      ...clone(raw),
      storeId,
      storeName: storeName(storeId),
      categories,
      products,
      groups,
      storeMeta: {
        ...clone(base.storeMeta || {}),
        ...clone(raw.storeMeta || {}),
        rescuePreviewVersion: VERSION
      }
    };
  }

  function pitCount(data) {
    return (data?.groups || []).reduce((total, group) => total + LAYERS.reduce((sum, layer) => (
      sum + (Array.isArray(group.layers?.[layer]?.pits) ? group.layers[layer].pits.length : 0)
    ), 0), 0);
  }

  function dataScore(data) {
    const cleaned = cleanData(data);
    if (!cleaned) return -1;
    return cleaned.products.length * 100000 + cleaned.groups.length * 1000 + pitCount(cleaned);
  }

  function actualLocalGet(key) {
    try { return nativeGetItem.call(window.localStorage, key); } catch (_) { return null; }
  }

  function actualSessionGet(key) {
    try { return nativeGetItem.call(window.sessionStorage, key); } catch (_) { return null; }
  }

  function chooseLocalStoreData(storeId) {
    const candidates = [];
    const add = (value, source, bonus = 0) => {
      if (!isRecord(value)) return;
      const rescued = salvageData(storeId, value);
      if (!rescued) return;
      candidates.push({ data: rescued, source, score: dataScore(rescued) + bonus });
    };

    add(parseJson(actualLocalGet(storeKey(storeId))), "门店独立本地记录", 600000000);

    const active = actualLocalGet(ACTIVE_KEY) || ORIGINAL_STORE_ID;
    const mainRaw = parseJson(actualLocalGet(MAIN_KEY));
    const mainStoreId = STORE_IDS.includes(mainRaw?.storeId) ? mainRaw.storeId : active;
    if (mainStoreId === storeId) add(mainRaw, "当前页面本地记录", 500000000);

    const sessionBase = parseJson(actualSessionGet("planogram-cloud-base-v2"));
    if (sessionBase?.storeId === storeId) add(sessionBase.data, "浏览器云端基准快照", 400000000);

    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (!key || !key.includes("planogram") || key === MAIN_KEY || key === storeKey(storeId)) continue;
        const parsed = parseJson(actualLocalGet(key));
        if (!isRecord(parsed)) continue;
        const detected = STORE_IDS.includes(parsed.storeId) ? parsed.storeId : "";
        if (detected === storeId || key.includes(storeId) || parsed.storeName === storeName(storeId)) {
          add(parsed, `历史本地键：${key}`, 300000000);
        }
        if (isRecord(parsed.data) && (parsed.storeId === storeId || parsed.data.storeId === storeId)) {
          add(parsed.data, `历史本地键：${key}.data`, 300000000);
        }
      }
    } catch (_) {}

    const builtIn = salvageData(storeId, buildStoreInitial(storeId));
    if (builtIn) candidates.push({ data: builtIn, source: "内置门店底表", score: dataScore(builtIn) });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || { data: null, source: "无" };
  }

  function prepareSelectedStore() {
    let selected = actualLocalGet(SELECTED_KEY) || ORIGINAL_STORE_ID;
    if (!STORE_IDS.includes(selected)) selected = ORIGINAL_STORE_ID;
    const picked = chooseLocalStoreData(selected);
    if (!picked.data) throw new Error(`无法构建门店数据：${storeName(selected)}`);

    virtualMainValue = JSON.stringify(picked.data);
    nativeSetItem.call(window.localStorage, SELECTED_KEY, selected);
    nativeSetItem.call(window.localStorage, ACTIVE_KEY, selected);
    window.PLANOGRAM_INITIAL_DATA = clone(picked.data);
    window.PLANOGRAM_STORE_CONTEXT = {
      storeId: selected,
      storeName: storeName(selected),
      isOriginalStore: selected === ORIGINAL_STORE_ID,
      config: selected === ORIGINAL_STORE_ID ? null : storeConfigs[selected],
      rescueSource: picked.source
    };
    return selected;
  }

  const selectedStoreId = prepareSelectedStore();

  Storage.prototype.getItem = function(key) {
    if (this === window.localStorage && key === MAIN_KEY && virtualMainValue) return virtualMainValue;
    return nativeGetItem.call(this, key);
  };

  Storage.prototype.setItem = function(key, value) {
    if (this === window.localStorage && key === MAIN_KEY) {
      const parsed = parseJson(value);
      const rescued = salvageData(selectedStoreId, parsed);
      if (rescued) virtualMainValue = JSON.stringify(rescued);
      return;
    }
    nativeSetItem.call(this, key, value);
  };

  Storage.prototype.removeItem = function(key) {
    if (this === window.localStorage && key === MAIN_KEY) return;
    nativeRemoveItem.call(this, key);
  };

  function switchStore(nextStoreId) {
    if (!STORE_IDS.includes(nextStoreId)) return;
    nativeSetItem.call(window.localStorage, SELECTED_KEY, nextStoreId);
    nativeSetItem.call(window.localStorage, ACTIVE_KEY, nextStoreId);
    window.location.reload();
  }

  function buildAllStoreRecovery() {
    const stores = {};
    const summary = [];
    STORE_IDS.forEach(id => {
      const picked = chooseLocalStoreData(id);
      if (!picked.data) return;
      stores[id] = picked.data;
      summary.push({
        id,
        name: storeName(id),
        source: picked.source,
        products: picked.data.products.length,
        groups: picked.data.groups.length,
        pits: pitCount(picked.data)
      });
    });
    return {
      type: "planogram-all-store-rescue",
      version: VERSION,
      createdAt: new Date().toISOString(),
      mode: "read-only-preview",
      note: "本文件包含系统在当前浏览器中识别出的全部门店恢复数据，以及加载修复版本前的原始本地键值。未写入云端。",
      summary,
      stores,
      rawLocalStorage: rawLocalSnapshot
    };
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadRawSnapshot() {
    downloadJson(`门店原始本地数据备份_${new Date().toISOString().replace(/[:.]/g, "-")}.json`, {
      version: VERSION,
      createdAt: new Date().toISOString(),
      localStorage: rawLocalSnapshot
    });
  }

  function downloadAllRecovered() {
    downloadJson(`全部门店恢复数据_${new Date().toISOString().replace(/[:.]/g, "-")}.json`, buildAllStoreRecovery());
  }

  function cloudClient() {
    return window.PLANOGRAM_CLOUD_CLIENT || null;
  }

  function cloudNote(message, isError = false) {
    const node = document.getElementById("cloudSyncStatus");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", isError);
  }

  async function requireSession() {
    const client = cloudClient();
    if (!client) {
      cloudNote("云端组件尚未加载完成。", true);
      return null;
    }
    const result = await client.auth.getSession();
    const session = result?.data?.session;
    if (result?.error || !session?.user) {
      cloudNote(result?.error?.message || "请先登录云端协作账号。", true);
      return null;
    }
    return session;
  }

  async function readCloudDocument() {
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_documents")
      .select("payload,revision,updated_at")
      .eq("id", CLOUD_DOCUMENT_ID)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  function detectStoreId(record, pathKey = "") {
    if (STORE_IDS.includes(record?.storeId)) return record.storeId;
    if (STORE_IDS.includes(pathKey)) return pathKey;
    const byName = STORE_IDS.find(id => storeName(id) === (record?.storeName || record?.name || pathKey));
    return byName || "";
  }

  function credibleCloudData(storeId, value) {
    const cleaned = cleanData(value);
    if (!cleaned || !cleaned.products.length || !cleaned.groups.length) return false;
    const base = buildStoreInitial(storeId);
    return cleaned.products.length >= Math.max(20, Math.floor((base.products?.length || 1) * 0.35)) &&
      cleaned.groups.length >= Math.max(1, Math.floor((base.groups?.length || 1) * 0.35));
  }

  function extractCloudCandidates(payload) {
    const found = {};
    const seen = new WeakSet();
    const add = (id, value, path) => {
      if (!STORE_IDS.includes(id) || !credibleCloudData(id, value)) return;
      const data = salvageData(id, value);
      const score = dataScore(data);
      if (!found[id] || score > found[id].score) found[id] = { data, path, score };
    };
    const walk = (value, pathKey = "", path = "payload", depth = 0) => {
      if (!value || typeof value !== "object" || depth > 8) return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, "", `${path}[${index}]`, depth + 1));
        return;
      }
      const detected = detectStoreId(value, pathKey);
      if (detected) add(detected, value, path);
      Object.entries(value).forEach(([key, child]) => walk(child, key, `${path}.${key}`, depth + 1));
    };
    walk(payload);
    return found;
  }

  async function downloadCloudRescue() {
    if (!await requireSession()) return;
    cloudNote("正在只读读取云端历史数据，不会写入云端…");
    try {
      const remote = await readCloudDocument();
      const candidates = extractCloudCandidates(remote?.payload);
      const local = buildAllStoreRecovery();
      const cloudStores = {};
      const cloudSummary = [];
      Object.entries(candidates).forEach(([id, item]) => {
        cloudStores[id] = item.data;
        cloudSummary.push({ id, name: storeName(id), path: item.path, products: item.data.products.length, groups: item.data.groups.length, pits: pitCount(item.data) });
      });
      downloadJson(`本地与云端全部门店抢救包_${new Date().toISOString().replace(/[:.]/g, "-")}.json`, {
        type: "planogram-local-cloud-rescue",
        version: VERSION,
        createdAt: new Date().toISOString(),
        cloudRevision: remote?.revision ?? null,
        local,
        cloudSummary,
        cloudStores,
        rawCloudPayload: remote?.payload ?? null
      });
      cloudNote(`只读读取完成：找到${cloudSummary.length}家可识别的云端门店记录，已下载抢救包；云端未被修改。`);
    } catch (error) {
      cloudNote(error?.message || "云端只读读取失败；本地和云端均未被修改。", true);
    }
  }

  function blockCloudWrite() {
    cloudNote("当前为只读抢救版本，已阻止云端写入。", true);
  }

  function interceptButton(id, handler) {
    const node = document.getElementById(id);
    if (!node || node.dataset.rescueBound === "1") return;
    node.dataset.rescueBound = "1";
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler()).catch(error => cloudNote(error?.message || "操作失败。", true));
    }, true);
  }

  function installCloudControls() {
    interceptButton("cloudPullBtn", downloadCloudRescue);
    interceptButton("cloudPushBtn", blockCloudWrite);
    interceptButton("confirmResetBtn", blockCloudWrite);
    const pull = document.getElementById("cloudPullBtn");
    if (pull) pull.textContent = "只读下载云端抢救包";
    const push = document.getElementById("cloudPushBtn");
    if (push) {
      push.textContent = "云端写入已锁定";
      push.classList.remove("btn-primary");
    }
    const helper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (helper) helper.textContent = "当前版本只读取并下载云端原始数据，不会覆盖本地，也不会写入或删除云端。";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
  }

  function injectUi() {
    const context = window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot = document.querySelector(".topbar > div:first-child");
    const eyebrow = titleRoot?.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = context.storeName;
    document.title = `${context.storeName}｜全品类可视化陈列系统`;

    const holder = document.createElement("div");
    holder.id = "safeRescueStoreSwitcher";
    holder.className = "store-switcher";
    holder.innerHTML = `
      <label for="storeSelect">门店</label>
      <select id="storeSelect" aria-label="选择门店">
        ${STORE_IDS.map(id => `<option value="${escapeHtml(id)}" ${id === selectedStoreId ? "selected" : ""}>${escapeHtml(storeName(id))}</option>`).join("")}
      </select>
      <button id="downloadAllRecoveredBtn" class="btn btn-primary" type="button">下载全部门店恢复数据JSON</button>
      <button id="downloadRawSnapshotBtn" class="btn" type="button">下载原始本地备份</button>
    `;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change", event => switchStore(event.target.value));
    holder.querySelector("#downloadAllRecoveredBtn")?.addEventListener("click", downloadAllRecovered);
    holder.querySelector("#downloadRawSnapshotBtn")?.addEventListener("click", downloadRawSnapshot);
    installCloudControls();

    const status = document.getElementById("statusBar");
    const current = JSON.parse(virtualMainValue);
    if (status) {
      status.textContent = `只读抢救模式：已识别8家门店；当前“${context.storeName}”来源为${context.rescueSource}，${current.products.length}个产品、${current.groups.length}组货架、${pitCount(current)}个坑位。原始本地和云端均未被覆盖。`;
      status.classList.remove("error");
    }
  }

  window.PLANOGRAM_RESCUE_DEBUG = {
    version: VERSION,
    storeIds: STORE_IDS.slice(),
    selectedStoreId,
    buildStoreInitial,
    chooseLocalStoreData,
    buildAllStoreRecovery,
    pitCount,
    dataScore,
    rawLocalSnapshot
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectUi);
  else injectUi();
})();
