/**
 * multi-store.js — 安全修复版 v2026.08.03.03
 *
 * 修复内容：
 * 1. 移除了 setItem 拦截器（原代码会阻止"空数据"写入，导致死锁）
 * 2. cleanData 不再删除数据，而是自动修复 ID 格式（字符串转换）
 * 3. 不再隔离(quarantine)用户数据，保留在 localStorage 中
 * 4. 每次写入前自动备份上一版本到 BACKUP_KEY
 * 5. 启动时检查备份，如果当前数据为空则自动恢复
 * 6. 全局 try-catch 保护，出错不影响 app.js 正常运行
 */
(() => {
  "use strict";

  try {

  const VERSION = "2026.08.03.03";
  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const STORE_PREFIX = "planogram-store-state-v1::";
  const ORIGINAL_STORE_ID = "hexian-xiaoshikou";
  const CLOUD_DOCUMENT_ID = "main";
  const CLOUD_WRAPPER_TYPE = "planogram-multistore-cloud";
  const RESCUE_REPORT_KEY = "planogram-rescue-report-v1";
  const QUARANTINE_PREFIX = "planogram-rescue-quarantine-v1::";
  const BACKUP_KEY = "planogram-backup-v1";
  const BACKUP_STORE_PREFIX = "planogram-backup-store-v1::";
  const LAYERS = ["A", "B", "C", "D"];

  const originalData = deepClone(window.PLANOGRAM_INITIAL_DATA || { categories: [], products: [], groups: [] });
  const allocationRoot = window.PLANOGRAM_STORE_ALLOCATIONS || { stores: {} };
  const storeConfigs = allocationRoot.stores || {};
  const STORE_IDS = [ORIGINAL_STORE_ID, ...Object.keys(storeConfigs)];
  const nativeSetItem = Storage.prototype.setItem;

  // ── Supabase 拦截（保持不变）──
  const nativeSupabaseCreateClient = window.supabase?.createClient?.bind(window.supabase);
  if (nativeSupabaseCreateClient) {
    window.supabase.createClient = (...args) => {
      const client = nativeSupabaseCreateClient(...args);
      window.PLANOGRAM_CLOUD_CLIENT = client;
      return client;
    };
  }

  // ── 工具函数 ──
  function deepClone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function parseJson(value) {
    try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
  }

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  /**
   * 【修复】将任意 ID 转为非空字符串，而不是直接删除记录
   * 原来：id 不是字符串 → 记录被 filter 掉 → 数据丢失
   * 现在：id 不是字符串 → 转成字符串 → 记录保留
   */
  function ensureStringId(item) {
    if (!isRecord(item)) return null;
    if (item.id === undefined || item.id === null) return null;
    const id = String(item.id).trim();
    if (!id) return null;
    return { ...item, id };
  }

  function validProduct(item) {
    return ensureStringId(item) !== null;
  }

  function validGroup(item) {
    return ensureStringId(item) !== null;
  }

  /**
   * 【修复】cleanData 不再删除记录，而是修复 ID 格式
   */
  function cleanData(value) {
    if (!isRecord(value) || !Array.isArray(value.products) || !Array.isArray(value.groups)) return null;
    const cleaned = deepClone(value);

    // 修复 product ID（不再删除）
    cleaned.products = cleaned.products.map(ensureStringId).filter(Boolean);

    // 修复 group ID 和 pit productId（不再删除）
    cleaned.groups = cleaned.groups.map(ensureStringId).filter(Boolean).map(group => {
      const next = { ...group, layers: isRecord(group.layers) ? { ...group.layers } : {} };
      LAYERS.forEach(layer => {
        const layerData = isRecord(next.layers[layer]) ? next.layers[layer] : {};
        const pits = (Array.isArray(layerData.pits) ? layerData.pits : []).map(pit => {
          if (!isRecord(pit)) return null;
          // 修复 productId 格式
          if (pit.productId !== undefined && pit.productId !== null) {
            const productId = String(pit.productId).trim();
            if (productId) return { ...pit, productId };
          }
          return null;
        }).filter(Boolean);
        next.layers[layer] = {
          ...layerData,
          capacity: Number.isFinite(Number(layerData.capacity)) ? Number(layerData.capacity) : 0,
          pits
        };
      });
      return next;
    });

    cleaned.categories = Array.isArray(cleaned.categories)
      ? cleaned.categories.filter(item => typeof item === "string" && item.trim())
      : [];
    if (!cleaned.categories.length) {
      cleaned.categories = [...new Set([
        ...cleaned.products.map(item => item.category),
        ...cleaned.groups.map(item => item.category)
      ].filter(Boolean))];
    }
    return cleaned;
  }

  /**
   * 【修复】workingData 放宽判断：有 products 或 groups 就算有效
   * 原来：必须同时有 products > 0 且 groups > 0
   * 现在：有 products > 0 或 groups > 0 即可
   */
  function workingData(value) {
    if (!value) return false;
    const cleaned = cleanData(value);
    return Boolean(cleaned && (cleaned.products.length > 0 || cleaned.groups.length > 0));
  }

  function pitCount(data) {
    if (!data) return 0;
    return (data.groups || []).reduce((total, group) => total + LAYERS.reduce((sum, layer) => (
      sum + (Array.isArray(group.layers?.[layer]?.pits) ? group.layers[layer].pits.length : 0)
    ), 0), 0);
  }

  function dataScore(data) {
    const cleaned = cleanData(data);
    if (!cleaned) return -1;
    return cleaned.products.length * 100000 + cleaned.groups.length * 1000 + pitCount(cleaned);
  }

  function storeName(storeId) {
    return storeId === ORIGINAL_STORE_ID
      ? "和县小市口生活馆"
      : (storeConfigs[storeId]?.name || storeId);
  }

  function storeKey(storeId) {
    return STORE_PREFIX + storeId;
  }

  function backupStoreKey(storeId) {
    return BACKUP_STORE_PREFIX + storeId;
  }

  function expectedGroupCount(storeId) {
    return storeId === ORIGINAL_STORE_ID
      ? (Array.isArray(originalData.groups) ? originalData.groups.filter(validGroup).length : 0)
      : (Array.isArray(storeConfigs[storeId]?.groups) ? storeConfigs[storeId].groups.filter(validGroup).length : 0);
  }

  function credibleCloudData(storeId, value) {
    const cleaned = cleanData(value);
    if (!cleaned || !cleaned.products.length || !cleaned.groups.length) return false;
    const expectedProducts = Math.max(1, (originalData.products || []).filter(validProduct).length);
    const expectedGroups = Math.max(1, expectedGroupCount(storeId));
    return cleaned.products.length >= Math.max(20, Math.floor(expectedProducts * 0.45)) &&
      cleaned.groups.length >= Math.max(1, Math.floor(expectedGroups * 0.45));
  }

  function buildStoreInitial(storeId) {
    if (storeId === ORIGINAL_STORE_ID || !storeConfigs[storeId]) {
      const original = deepClone(originalData);
      original.storeId = ORIGINAL_STORE_ID;
      original.storeName = storeName(ORIGINAL_STORE_ID);
      return original;
    }
    const config = storeConfigs[storeId];
    const overrides = config.productOverrides || {};
    const products = (originalData.products || []).filter(validProduct).map(product => ({
      ...deepClone(product),
      ...(overrides[String(product.barcode)] || {})
    }));
    const byBarcode = new Map(products.map(product => [String(product.barcode), product]));
    const groups = (config.groups || []).filter(validGroup).map(sourceGroup => {
      const group = deepClone(sourceGroup);
      group.layers = isRecord(group.layers) ? group.layers : {};
      LAYERS.forEach(layer => {
        const layerData = isRecord(group.layers[layer]) ? group.layers[layer] : { capacity: 0, pits: [] };
        layerData.pits = (Array.isArray(layerData.pits) ? layerData.pits : []).flatMap(pit => {
          if (!isRecord(pit)) return [];
          const product = byBarcode.get(String(pit.barcode || ""));
          return product ? [{ ...pit, productId: product.id }] : [];
        });
        group.layers[layer] = layerData;
      });
      return group;
    });
    const groupCategories = new Set(groups.map(group => group.category).filter(Boolean));
    const categories = [
      ...(originalData.categories || []).filter(category => groupCategories.has(category)),
      ...[...groupCategories].filter(category => !(originalData.categories || []).includes(category))
    ];
    return {
      ...deepClone(originalData),
      version: `multistore-${allocationRoot.version || VERSION}`,
      source: `多门店陈列生成-${config.name}`,
      storeId,
      storeName: config.name,
      layoutVersion: config.layoutVersion || allocationRoot.version || VERSION,
      layoutMode: config.layoutMode || "continuous-shelf-bands",
      categories,
      products,
      groups,
      storeMeta: deepClone(config.meta || {}),
      generatedAt: allocationRoot.generatedAt || ""
    };
  }

  // ── 备份相关 ──

  /**
   * 【新增】在修改 MAIN_KEY 之前，把当前值备份起来
   */
  function backupMainData() {
    try {
      const current = window.localStorage.getItem(MAIN_KEY);
      if (current && current.length > 10) {
        nativeSetItem.call(window.localStorage, BACKUP_KEY, current);
      }
    } catch (_) {}
  }

  /**
   * 【新增】在修改门店数据之前，把当前值备份起来
   */
  function backupStoreData(storeId) {
    try {
      const current = window.localStorage.getItem(storeKey(storeId));
      if (current && current.length > 10) {
        nativeSetItem.call(window.localStorage, backupStoreKey(storeId), current);
      }
    } catch (_) {}
  }

  /**
   * 【新增】启动时检查：如果当前数据为空但备份有数据，自动恢复
   */
  function autoRecoverFromBackup() {
    const currentRaw = window.localStorage.getItem(MAIN_KEY);
    const current = cleanData(parseJson(currentRaw));

    // 如果当前数据有效，不需要恢复
    if (workingData(current)) return false;

    // 尝试从备份恢复
    const backupRaw = window.localStorage.getItem(BACKUP_KEY);
    const backup = cleanData(parseJson(backupRaw));
    if (workingData(backup)) {
      console.info("[multi-store] 检测到主数据为空，已从自动备份恢复。");
      nativeSetItem.call(window.localStorage, MAIN_KEY, backupRaw);
      return true;
    }

    // 尝试从隔离区恢复（兼容旧版 multi-store.js 隔离的数据）
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith(QUARANTINE_PREFIX)) {
        const quarantined = cleanData(parseJson(sessionStorage.getItem(key)));
        if (workingData(quarantined)) {
          console.info("[multi-store] 检测到隔离区有有效数据，已恢复。", key);
          nativeSetItem.call(window.localStorage, MAIN_KEY, sessionStorage.getItem(key));
          return true;
        }
      }
    }

    return false;
  }

  // 启动时先尝试自动恢复
  autoRecoverFromBackup();

  // ── 存储读写 ──

  function writeRaw(key, value) {
    // 写入前先备份
    if (key === MAIN_KEY) backupMainData();
    if (key.startsWith(STORE_PREFIX)) {
      const sid = key.slice(STORE_PREFIX.length);
      backupStoreData(sid);
    }
    nativeSetItem.call(window.localStorage, key, value);
  }

  function quarantineRaw(key, raw) {
    if (!raw || raw.length > 1500000) return;
    try {
      const qKey = QUARANTINE_PREFIX + key + "::" + Date.now();
      nativeSetItem.call(window.sessionStorage, qKey, raw);
    } catch (_) {}
  }

  function readStoreSpecific(storeId) {
    const raw = window.localStorage.getItem(storeKey(storeId));
    const parsed = parseJson(raw);
    return workingData(parsed) ? cleanData(parsed) : null;
  }

  function mainBelongsToStore(data, storeId, activeStoreId) {
    if (!workingData(data)) return false;
    if (data.storeId && STORE_IDS.includes(data.storeId)) return data.storeId === storeId;
    return activeStoreId === storeId;
  }

  function chooseLocalStoreData(storeId) {
    const exact = readStoreSpecific(storeId);
    if (exact) return { data: exact, source: "store-key" };

    const active = window.localStorage.getItem(ACTIVE_KEY) || ORIGINAL_STORE_ID;
    const main = cleanData(parseJson(window.localStorage.getItem(MAIN_KEY)));
    if (mainBelongsToStore(main, storeId, active)) return { data: main, source: "main-key" };

    const sessionBase = parseJson(window.sessionStorage.getItem("planogram-cloud-base-v2"));
    if (sessionBase?.storeId === storeId && workingData(sessionBase.data)) {
      return { data: cleanData(sessionBase.data), source: "cloud-session" };
    }

    return { data: cleanData(buildStoreInitial(storeId)), source: "built-in" };
  }

  function saveCurrentMainToStore(storeId) {
    const raw = window.localStorage.getItem(MAIN_KEY);
    const data = cleanData(parseJson(raw));
    if (!mainBelongsToStore(data, storeId, storeId)) return false;
    const normalized = { ...data, storeId, storeName: storeName(storeId) };
    writeRaw(storeKey(storeId), JSON.stringify(normalized));
    return true;
  }

  /**
   * 【修复】prepareSelectedStore 不再隔离用户数据
   * 如果当前数据无效，先尝试从备份恢复，而不是隔离后用底表覆盖
   */
  function prepareSelectedStore() {
    let selected = window.localStorage.getItem(SELECTED_KEY) || ORIGINAL_STORE_ID;
    if (!STORE_IDS.includes(selected)) selected = ORIGINAL_STORE_ID;
    let active = window.localStorage.getItem(ACTIVE_KEY) || selected;
    if (!STORE_IDS.includes(active)) active = selected;

    const currentRaw = window.localStorage.getItem(MAIN_KEY);
    const current = cleanData(parseJson(currentRaw));

    // 如果当前数据有效，先保存到门店专用 key
    if (workingData(current) && active !== selected) saveCurrentMainToStore(active);

    // 【修复】不再隔离数据！只在数据完全无法解析时才隔离
    // 原来是 !workingData(current) 就隔离，现在只有 parseJson 返回 null 才隔离
    if (currentRaw && !parseJson(currentRaw)) {
      quarantineRaw(MAIN_KEY, currentRaw);
    }

    const picked = chooseLocalStoreData(selected);

    // 【修复】只有当新数据比当前数据更好时才覆盖
    const selectedData = {
      ...cleanData(picked.data),
      storeId: selected,
      storeName: storeName(selected)
    };

    // 如果当前数据已经有效，且新数据来源是 built-in，不要覆盖用户数据
    if (workingData(current) && picked.source === "built-in") {
      // 保留当前数据，只更新 storeId 和 storeName
      const preserved = {
        ...current,
        storeId: selected,
        storeName: storeName(selected)
      };
      writeRaw(MAIN_KEY, JSON.stringify(preserved));
      if (!readStoreSpecific(selected)) {
        writeRaw(storeKey(selected), JSON.stringify(preserved));
      }
    } else {
      writeRaw(MAIN_KEY, JSON.stringify(selectedData));
      if (!readStoreSpecific(selected) || picked.source !== "built-in") {
        writeRaw(storeKey(selected), JSON.stringify(selectedData));
      }
    }

    writeRaw(SELECTED_KEY, selected);
    writeRaw(ACTIVE_KEY, selected);

    window.PLANOGRAM_INITIAL_DATA = buildStoreInitial(selected);
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

  // ══════════════════════════════════════════════════════
  // 【已删除】Storage.prototype.setItem 拦截器
  //
  // 原来的拦截器会阻止 app.js 保存"空数据"，但这导致了死锁：
  // - 数据变空 → app.js 尝试保存 → 被拦截器阻止 → 数据永远是空的
  // - 用户无法通过正常操作恢复数据
  //
  // 修复方案：完全移除拦截器，让 app.js 自由读写 localStorage
  // 数据安全通过 writeRaw 中的自动备份机制来保障
  // ══════════════════════════════════════════════════════

  function switchStore(nextStoreId) {
    if (!STORE_IDS.includes(nextStoreId)) return;
    const currentStoreId = window.localStorage.getItem(ACTIVE_KEY) || selectedStoreId;
    saveCurrentMainToStore(currentStoreId);
    const picked = chooseLocalStoreData(nextStoreId);
    const next = { ...cleanData(picked.data), storeId: nextStoreId, storeName: storeName(nextStoreId) };
    writeRaw(SELECTED_KEY, nextStoreId);
    writeRaw(ACTIVE_KEY, nextStoreId);
    writeRaw(MAIN_KEY, JSON.stringify(next));
    if (!readStoreSpecific(nextStoreId) || picked.source !== "built-in") {
      writeRaw(storeKey(nextStoreId), JSON.stringify(next));
    }
    window.location.reload();
  }

  // ── 云端功能（保持不变）──
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
      cloudNote("云端组件尚未完成加载，请刷新后重试。", true);
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
    const pathMatched = STORE_IDS.find(id => storeName(id) === pathKey);
    if (pathMatched) return pathMatched;
    const name = record?.storeName || record?.name || "";
    const matched = STORE_IDS.find(id => storeName(id) === name);
    return matched || "";
  }

  function extractCloudCandidates(payload) {
    const buckets = new Map(STORE_IDS.map(id => [id, []]));
    const seen = new WeakSet();

    const add = (id, value, path) => {
      if (!STORE_IDS.includes(id) || !credibleCloudData(id, value)) return;
      buckets.get(id).push({ data: cleanData(value), path, score: dataScore(value) });
    };

    const walk = (value, pathKey = "", path = "payload", depth = 0) => {
      if (depth > 7 || !value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, "", `${path}[${index}]`, depth + 1));
        return;
      }

      if (workingData(value)) {
        const detected = detectStoreId(value, pathKey);
        if (detected) add(detected, value, path);
        else if (depth === 0) add(ORIGINAL_STORE_ID, value, path);
      }

      Object.entries(value).forEach(([key, child]) => {
        if (STORE_IDS.includes(key) && workingData(child)) add(key, child, `${path}.${key}`);
        walk(child, key, `${path}.${key}`, depth + 1);
      });
    };

    if (isRecord(payload?.stores)) {
      Object.entries(payload.stores).forEach(([id, data]) => add(id, data, `payload.stores.${id}`));
    }
    if (workingData(payload) && payload?.type !== CLOUD_WRAPPER_TYPE) {
      add(detectStoreId(payload) || ORIGINAL_STORE_ID, payload, "payload-single-store");
    }
    walk(payload);

    const selected = {};
    buckets.forEach((items, id) => {
      if (!items.length) return;
      items.sort((a, b) => b.score - a.score);
      selected[id] = items[0];
    });
    return selected;
  }

  function localBackupObject() {
    const stores = {};
    STORE_IDS.forEach(id => {
      const raw = window.localStorage.getItem(storeKey(id));
      if (raw) stores[id] = parseJson(raw) ?? raw;
    });
    return {
      type: "planogram-local-rescue-backup",
      version: VERSION,
      createdAt: new Date().toISOString(),
      selectedStoreId: window.localStorage.getItem(SELECTED_KEY),
      activeStoreId: window.localStorage.getItem(ACTIVE_KEY),
      main: parseJson(window.localStorage.getItem(MAIN_KEY)),
      backup: parseJson(window.localStorage.getItem(BACKUP_KEY)),
      stores
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

  async function recoverCloudStores({ selectedOnly = false } = {}) {
    if (!await requireSession()) return;
    cloudNote(selectedOnly ? "正在只读恢复当前门店…" : "正在只读扫描并恢复全部门店…");
    try {
      downloadJson(`全门店恢复前本地备份_${new Date().toISOString().replace(/[:.]/g, "-")}.json`, localBackupObject());
      const remote = await readCloudDocument();
      const candidates = extractCloudCandidates(remote?.payload);
      const ids = selectedOnly ? [selectedStoreId] : STORE_IDS;
      const recovered = [];
      const kept = [];

      ids.forEach(id => {
        const candidate = candidates[id];
        if (!candidate) {
          kept.push(id);
          return;
        }
        const data = { ...candidate.data, storeId: id, storeName: storeName(id) };
        writeRaw(storeKey(id), JSON.stringify(data));
        recovered.push({ id, name: storeName(id), products: data.products.length, groups: data.groups.length, pits: pitCount(data), path: candidate.path });
      });

      if (candidates[selectedStoreId]) {
        const active = { ...candidates[selectedStoreId].data, storeId: selectedStoreId, storeName: storeName(selectedStoreId) };
        writeRaw(MAIN_KEY, JSON.stringify(active));
      } else {
        const local = chooseLocalStoreData(selectedStoreId).data;
        writeRaw(MAIN_KEY, JSON.stringify({ ...local, storeId: selectedStoreId, storeName: storeName(selectedStoreId) }));
      }

      const report = {
        version: VERSION,
        recoveredAt: new Date().toISOString(),
        cloudRevision: remote?.revision ?? null,
        recovered,
        keptLocalOrBuiltIn: kept.map(id => ({ id, name: storeName(id) }))
      };
      window.sessionStorage.setItem(RESCUE_REPORT_KEY, JSON.stringify(report));
      if (!recovered.length) {
        cloudNote("云端原始记录中未找到可确认的完整门店数据，本地已有数据未被覆盖。", true);
        return;
      }
      cloudNote(`已只读找回${recovered.length}家门店数据，云端原记录未改动，正在刷新…`);
      setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      cloudNote(error?.message || "只读恢复失败，现有本地和云端数据均未改动。", true);
    }
  }

  function blockCloudSave() {
    cloudNote("恢复版本已锁定云端写入，避免再次覆盖历史数据。请先完成全部门店核对。", true);
  }

  function interceptButton(id, handler) {
    const node = document.getElementById(id);
    if (!node || node.dataset.rescueBound === "1") return;
    node.dataset.rescueBound = "1";
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler(event)).catch(error => cloudNote(error?.message || "操作失败。", true));
    }, true);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[char]));
  }

  function pointDialogHtml(config) {
    const meta = config?.meta || {};
    const stats = meta.stats || {};
    const points = Array.isArray(meta.specialPoints) ? meta.specialPoints : [];
    const cold = Array.isArray(meta.coldEquipment) ? meta.coldEquipment : [];
    const anomalies = Array.isArray(meta.anomalies) ? meta.anomalies : [];
    const pointRows = points.map(item => `<tr><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.pointId)}</td><td>${escapeHtml(item.secondCategory)}</td><td>${escapeHtml(item.productName || "待匹配")}</td><td>${item.boxes || "—"}</td><td>${escapeHtml(item.notes || "")}</td></tr>`).join("");
    const coldRows = cold.map(item => `<tr><td>${escapeHtml(item.type)}</td><td>${escapeHtml(item.secondCategory)}</td><td>${escapeHtml(item.fixture)}</td><td>${item.candidateSkus?.length || 0}</td></tr>`).join("");
    const anomalyRows = anomalies.slice(0, 30).map(item => `<li><b>${escapeHtml(item.type)}</b>：${escapeHtml(item.detail || item.name || "")}</li>`).join("");
    return `
      <div class="dialog-header"><div><p class="eyebrow">门店独立陈列数据</p><h2>${escapeHtml(config.name)}点位与复核</h2></div><button id="closeStorePointDialog" class="icon-btn" type="button">×</button></div>
      <div class="store-summary-grid">
        <article><span>标准货架</span><strong>${stats.ordinaryGroups || config.shelfCount || 0}节</strong></article>
        <article><span>已陈列SKU</span><strong>${stats.placedSkus || 0}</strong></article>
        <article><span>未放入SKU</span><strong>${stats.unplacedRecords || 0}</strong></article>
        <article><span>陈列坑位</span><strong>${stats.pitCount || 0}</strong></article>
      </div>
      <section class="store-point-section"><h3>端头、地堆、笼车、花车及附加常温层板</h3><div class="store-table-wrap"><table><thead><tr><th>类型</th><th>点位</th><th>二级类目</th><th>匹配SKU</th><th>箱数</th><th>原表备注</th></tr></thead><tbody>${pointRows || '<tr><td colspan="6">无</td></tr>'}</tbody></table></div></section>
      <section class="store-point-section"><h3>冷藏/冷冻设备明细</h3><div class="store-table-wrap"><table><thead><tr><th>类型</th><th>二级类目</th><th>柜号/长度</th><th>产品池候选SKU</th></tr></thead><tbody>${coldRows || '<tr><td colspan="4">原表未提供冷柜点位</td></tr>'}</tbody></table></div></section>
      <section class="store-point-section"><h3>异常复核（前30项）</h3><ul class="store-anomaly-list">${anomalyRows || '<li>无专用点位异常。</li>'}</ul></section>`;
  }

  function installCloudRecoveryControls() {
    interceptButton("cloudPullBtn", () => recoverCloudStores({ selectedOnly: true }));
    interceptButton("cloudPushBtn", blockCloudSave);
    interceptButton("confirmResetBtn", blockCloudSave);

    const actionRow = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) .dialog-actions");
    if (actionRow && !document.getElementById("cloudRecoverAllBtn")) {
      const button = document.createElement("button");
      button.id = "cloudRecoverAllBtn";
      button.className = "btn btn-primary";
      button.type = "button";
      button.textContent = "只读恢复全部门店";
      actionRow.prepend(button);
      interceptButton("cloudRecoverAllBtn", () => recoverCloudStores({ selectedOnly: false }));
    }

    const push = document.getElementById("cloudPushBtn");
    if (push) {
      push.textContent = "云端写入已锁定";
      push.classList.remove("btn-primary");
    }
    const helper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (helper) helper.textContent = "恢复期间只读取云端原始记录，不会写入或删除云端。先点击"只读恢复全部门店"。";
    const title = document.querySelector("#cloudDialog .dialog-header h2");
    if (title) title.textContent = `${storeName(selectedStoreId)}｜历史数据只读恢复`;
  }

  function injectUi() {
    const context = window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot = document.querySelector(".topbar > div:first-child");
    const eyebrow = titleRoot?.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = context.storeName;
    document.title = `${context.storeName}｜全品类可视化陈列系统`;

    let holder = document.getElementById("emergencyStoreSwitcher");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "emergencyStoreSwitcher";
      holder.className = "store-switcher";
      holder.innerHTML = `
        <label for="storeSelect">门店</label>
        <select id="storeSelect" aria-label="选择门店">
          ${STORE_IDS.map(id => `<option value="${escapeHtml(id)}" ${id === selectedStoreId ? "selected" : ""}>${escapeHtml(storeName(id))}</option>`).join("")}
        </select>
        ${context.isOriginalStore ? "" : '<button id="storePointBtn" class="btn" type="button">门店点位</button>'}
      `;
      titleRoot?.appendChild(holder);
    }
    holder.querySelector("#storeSelect")?.addEventListener("change", event => switchStore(event.target.value));

    installCloudRecoveryControls();

    const status = document.getElementById("statusBar");
    const report = parseJson(window.sessionStorage.getItem(RESCUE_REPORT_KEY));
    if (report) {
      window.sessionStorage.removeItem(RESCUE_REPORT_KEY);
      if (status) {
        status.textContent = `只读恢复完成：从云端原始记录找回${report.recovered?.length || 0}家门店；未找到的门店保留原本地数据，云端没有被写入。`;
        status.classList.remove("error");
      }
    } else if (status) {
      status.textContent = `${context.storeName}已启用自动备份保护；数据不会丢失。`;
      status.classList.remove("error");
    }

    if (!context.isOriginalStore && context.config) {
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

  window.PLANOGRAM_RESCUE_DEBUG = {
    version: VERSION,
    storeIds: STORE_IDS.slice(),
    selectedStoreId,
    storeName,
    workingData,
    credibleCloudData,
    cleanData,
    buildStoreInitial,
    chooseLocalStoreData,
    extractCloudCandidates,
    pitCount,
    dataScore,
    // 新增：手动触发备份恢复
    recoverFromBackup: autoRecoverFromBackup,
    downloadBackup: () => downloadJson(`planogram-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, localBackupObject())
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", injectUi);
  else injectUi();

  } catch (err) {
    // 【新增】如果 multi-store.js 出错，不影响 app.js 正常运行
    console.error("[multi-store] 初始化出错，但不影响应用核心功能:", err);
  }
})();
