(() => {
  "use strict";

  const VERSION = "2026.08.04.10";
  const DB_NAME = "planogram-eight-store-recovery-v1";
  const DB_VERSION = 1;
  const DB_STORE = "stores";
  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const CLOUD_DOCUMENT_ID = "main";
  const CLOUD_WRAPPER_TYPE = "planogram-multistore-cloud";
  const CLOUD_BASE_PREFIX = "__cloud_base__::";
  const CLOUD_META_ID = "__cloud_meta__";
  const STORE_IDS = [
    "hexian-xiaoshikou",
    "tongling-yurun",
    "jiujiang-zhonghui",
    "fanchang-zhongchen",
    "luan-zizhulin",
    "wuhu-fenghuangcheng",
    "sanshan-xingyue",
    "jiujiang-wantai"
  ];
  const STORE_NAMES = {
    "hexian-xiaoshikou": "和县小市口生活馆",
    "tongling-yurun": "铜陵雨润广场生活馆",
    "jiujiang-zhonghui": "九江中辉世纪城生活馆",
    "fanchang-zhongchen": "繁昌中辰一品生活馆",
    "luan-zizhulin": "六安紫竹林生活馆",
    "wuhu-fenghuangcheng": "芜湖凤凰城生活馆",
    "sanshan-xingyue": "三山星悦广场生活馆",
    "jiujiang-wantai": "九江万泰城生活馆"
  };

  const nativeSetItem = Storage.prototype.setItem;
  const nativeGetItem = Storage.prototype.getItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const clone = value => JSON.parse(JSON.stringify(value));
  const parse = value => { try { return value ? JSON.parse(value) : null; } catch (_) { return null; } };
  const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const valid = value => Boolean(value && Array.isArray(value.products) && value.products.length && Array.isArray(value.groups) && value.groups.length);

  const nativeSupabaseCreateClient = window.supabase?.createClient?.bind(window.supabase);
  if (nativeSupabaseCreateClient) {
    window.supabase.createClient = (...args) => {
      const client = nativeSupabaseCreateClient(...args);
      window.PLANOGRAM_CLOUD_CLIENT = client;
      return client;
    };
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (isRecord(value)) {
      const output = {};
      Object.keys(value).sort().forEach(key => { output[key] = stableValue(value[key]); });
      return output;
    }
    return value;
  }
  function sameData(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
  }
  function countPits(data) {
    return (data.groups || []).reduce((sum, group) => sum + ["A", "B", "C", "D"].reduce((layerSum, layer) => (
      layerSum + ((((group || {}).layers || {})[layer] || {}).pits || []).length
    ), 0), 0);
  }

  function layerUsedWidth(data, group, layer) {
    const productsById = new Map((data.products || []).map(product => [product.id, product]));
    const pits = group?.layers?.[layer]?.pits || [];
    return pits.reduce((sum, pit) => {
      const width = Number(productsById.get(pit.productId)?.faceWidth);
      return sum + (Number.isFinite(width) && width > 0 ? width : 0);
    }, 0);
  }

  function repairStoreCapacity(data, storeId) {
    validateStoreData(data, `容量校验“${STORE_NAMES[storeId] || storeId}”`);
    const next = clone(data);
    const productsById = new Map(next.products.map(product => [product.id, product]));
    const repairs = [];
    const touchedProductIds = new Set();

    next.groups.forEach(group => {
      ["A", "B", "C", "D"].forEach(layer => {
        const layerData = group.layers?.[layer];
        if (!layerData || !Array.isArray(layerData.pits)) return;
        const capacityValue = Number(layerData.capacity);
        const capacity = Number.isFinite(capacityValue) && capacityValue >= 0 ? capacityValue : 0;
        let used = layerData.pits.reduce((sum, pit) => {
          const width = Number(productsById.get(pit.productId)?.faceWidth);
          return sum + (Number.isFinite(width) && width > 0 ? width : 0);
        }, 0);
        if (used <= capacity) return;

        const beforeUsed = used;
        const removed = [];
        while (layerData.pits.length && used > capacity) {
          const pit = layerData.pits.pop();
          const product = productsById.get(pit.productId);
          const widthValue = Number(product?.faceWidth);
          const width = Number.isFinite(widthValue) && widthValue > 0 ? widthValue : 0;
          used -= width;
          touchedProductIds.add(pit.productId);
          removed.unshift({
            pitId: pit.id || "",
            productId: pit.productId,
            productName: product?.name || pit.productId,
            width
          });
        }
        repairs.push({
          storeId,
          storeName: STORE_NAMES[storeId] || storeId,
          groupId: group.id,
          layer,
          capacity,
          beforeUsed,
          afterUsed: used,
          remaining: capacity - used,
          removed
        });
      });
    });

    if (repairs.length) {
      const actualCount = productId => next.groups.reduce((groupSum, group) => (
        groupSum + ["A", "B", "C", "D"].reduce((layerSum, layer) => (
          layerSum + (group.layers?.[layer]?.pits || []).filter(pit => pit.productId === productId).length
        ), 0)
      ), 0);
      touchedProductIds.forEach(productId => {
        const product = productsById.get(productId);
        if (!product) return;
        const remainingPits = actualCount(productId);
        product.plannedPits = Math.max(1, remainingPits || 1);
        product.dataChanged = true;
        product.capacityRepairVersion = VERSION;
        if (remainingPits === 0 && product.status !== "eliminated") product.sourceState = "unplaced";
      });
      next.capacityRepairHistory = [
        ...(Array.isArray(next.capacityRepairHistory) ? next.capacityRepairHistory : []),
        { version: VERSION, repairedAt: new Date().toISOString(), repairs }
      ].slice(-20);
    }

    return { data: next, repairs };
  }
  function validateStoreData(data, label = "门店") {
    if (!valid(data)) throw new Error(`${label}缺少有效商品池或货架组。`);
    const productIds = new Set();
    data.products.forEach((product, index) => {
      if (!isRecord(product) || typeof product.id !== "string" || !product.id.trim()) throw new Error(`${label}第${index + 1}条商品缺少有效ID。`);
      if (productIds.has(product.id)) throw new Error(`${label}存在重复商品ID：${product.id}`);
      productIds.add(product.id);
    });
    const groupIds = new Set();
    data.groups.forEach((group, groupIndex) => {
      if (!isRecord(group) || typeof group.id !== "string" || !group.id.trim()) throw new Error(`${label}第${groupIndex + 1}个货架组缺少有效ID。`);
      if (groupIds.has(group.id)) throw new Error(`${label}存在重复货架组ID：${group.id}`);
      groupIds.add(group.id);
      ["A", "B", "C", "D"].forEach(layer => {
        const pits = group.layers?.[layer]?.pits;
        if (!Array.isArray(pits)) throw new Error(`${label} ${group.id}-${layer}层坑位不是数组。`);
        pits.forEach((pit, pitIndex) => {
          if (!isRecord(pit) || typeof pit.productId !== "string" || !productIds.has(pit.productId)) {
            throw new Error(`${label} ${group.id}-${layer}层第${pitIndex + 1}个坑位引用了不存在的商品。`);
          }
        });
      });
    });
    return data;
  }
  function validateCloudPayload(payload) {
    if (!isRecord(payload) || payload.type !== CLOUD_WRAPPER_TYPE || !isRecord(payload.stores)) {
      throw new Error("云端不是有效的8家门店数据结构，已停止操作。\n");
    }
    STORE_IDS.forEach(id => validateStoreData(payload.stores[id], `云端“${STORE_NAMES[id]}”`));
    return payload;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB打开失败"));
    });
  }
  function dbGet(db, id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(id);
      request.onsuccess = () => resolve(request.result?.data || null);
      request.onerror = () => reject(request.error || new Error("读取数据失败"));
    });
  }
  function dbPut(db, id, data, name = STORE_NAMES[id] || id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ id, name, data: clone(data), updatedAt: new Date().toISOString() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("保存数据失败"));
      tx.onabort = () => reject(tx.error || new Error("保存数据中止"));
    });
  }
  async function setCloudBase(db, id, data, revision) {
    validateStoreData(data, `基准“${STORE_NAMES[id]}”`);
    await dbPut(db, CLOUD_BASE_PREFIX + id, data, `云端基准-${STORE_NAMES[id]}`);
    const meta = (await dbGet(db, CLOUD_META_ID)) || {};
    meta.revision = Number(revision) || 0;
    meta.updatedAt = new Date().toISOString();
    meta.stores = { ...(meta.stores || {}), [id]: { revision: Number(revision) || 0, updatedAt: meta.updatedAt } };
    await dbPut(db, CLOUD_META_ID, meta, "云端同步元数据");
  }
  async function getCloudBase(db, id) {
    return dbGet(db, CLOUD_BASE_PREFIX + id);
  }

  function purgePlanogramLocal() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith("planogram-")) keys.push(key);
    }
    keys.forEach(key => nativeRemoveItem.call(localStorage, key));
  }
  function writeCurrent(id, data) {
    const payload = JSON.stringify(data);
    try {
      nativeSetItem.call(localStorage, SELECTED_KEY, id);
      nativeSetItem.call(localStorage, ACTIVE_KEY, id);
      nativeSetItem.call(localStorage, MAIN_KEY, payload);
    } catch (error) {
      purgePlanogramLocal();
      nativeSetItem.call(localStorage, SELECTED_KEY, id);
      nativeSetItem.call(localStorage, ACTIVE_KEY, id);
      nativeSetItem.call(localStorage, MAIN_KEY, payload);
    }
  }
  function downloadJson(filename, value) {
    if (window.PLANOGRAM_TEST_MODE) return;
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  let dbRef = null;
  let selectedStoreId = STORE_IDS[0];
  let saveTimer = null;
  let capacityRepairReport = [];
  let firstDeviceInitializationNeeded = false;
  let missingLocalStoreIds = [];

  async function scanLocalStores() {
    const validIds = [];
    const missingIds = [];
    for (const id of STORE_IDS) {
      const data = await dbGet(dbRef, id);
      (valid(data) ? validIds : missingIds).push(id);
    }
    return { validIds, missingIds };
  }

  async function prepare() {
    dbRef = await openDb();
    let selected = nativeGetItem.call(localStorage, SELECTED_KEY);
    let active = nativeGetItem.call(localStorage, ACTIVE_KEY);
    const current = parse(nativeGetItem.call(localStorage, MAIN_KEY));
    if (!STORE_IDS.includes(selected)) selected = STORE_IDS.includes(active) ? active : STORE_IDS[0];
    if (STORE_IDS.includes(active) && valid(current)) await dbPut(dbRef, active, validateStoreData(current, `本地“${STORE_NAMES[active]}”`));

    capacityRepairReport = [];
    for (const id of STORE_IDS) {
      const stored = await dbGet(dbRef, id);
      if (!valid(stored)) continue;
      const repaired = repairStoreCapacity(stored, id);
      if (repaired.repairs.length) {
        capacityRepairReport.push(...repaired.repairs);
        await dbPut(dbRef, id, repaired.data);
      }
    }

    let localScan = await scanLocalStores();
    missingLocalStoreIds = localScan.missingIds.slice();
    firstDeviceInitializationNeeded = missingLocalStoreIds.length > 0;

    let data = await dbGet(dbRef, selected);
    if (!valid(data) && active === selected && valid(current)) data = current;
    if (!valid(data) && localScan.validIds.length) {
      selected = localScan.validIds[0];
      data = await dbGet(dbRef, selected);
    }
    if (!valid(data)) {
      const builtIn = clone(window.PLANOGRAM_INITIAL_DATA || {});
      validateStoreData(builtIn, "内置和县底表");
      selected = STORE_IDS[0];
      data = builtIn;
      await dbPut(dbRef, selected, data);
      localScan = await scanLocalStores();
      missingLocalStoreIds = localScan.missingIds.slice();
      firstDeviceInitializationNeeded = true;
    }

    validateStoreData(data, `本地“${STORE_NAMES[selected]}”`);
    selectedStoreId = selected;
    purgePlanogramLocal();
    writeCurrent(selected, data);
    window.PLANOGRAM_INITIAL_DATA = clone(data);
    window.PLANOGRAM_STORE_CONTEXT = {
      storeId: selected,
      storeName: STORE_NAMES[selected],
      isOriginalStore: selected === STORE_IDS[0],
      firstDeviceInitializationNeeded,
      missingLocalStoreIds: missingLocalStoreIds.slice(),
      config: { name: STORE_NAMES[selected], meta: data.storeMeta || {} }
    };

    Storage.prototype.setItem = function(key, value) {
      try {
        nativeSetItem.call(this, key, value);
      } catch (error) {
        if (this === localStorage && key === MAIN_KEY) {
          const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selected;
          purgePlanogramLocal();
          nativeSetItem.call(localStorage, SELECTED_KEY, id);
          nativeSetItem.call(localStorage, ACTIVE_KEY, id);
          nativeSetItem.call(localStorage, MAIN_KEY, value);
        } else {
          throw error;
        }
      }
      if (this === localStorage && key === MAIN_KEY) {
        const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selected;
        const parsed = parse(value);
        if (STORE_IDS.includes(id) && valid(parsed)) {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => dbPut(dbRef, id, parsed).catch(console.error), 120);
        }
      }
    };
    return { db: dbRef, selected, data, firstDeviceInitializationNeeded, missingLocalStoreIds: missingLocalStoreIds.slice() };
  }
  window.PLANOGRAM_STORE_READY = prepare();

  async function currentData() {
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    const local = parse(nativeGetItem.call(localStorage, MAIN_KEY));
    if (valid(local)) {
      validateStoreData(local, `本地“${STORE_NAMES[id]}”`);
      await dbPut(dbRef, id, local);
      return local;
    }
    const data = await dbGet(dbRef, id);
    return validateStoreData(data, `IndexedDB“${STORE_NAMES[id]}”`);
  }
  async function switchStore(nextId) {
    if (!STORE_IDS.includes(nextId)) return;
    const currentId = nativeGetItem.call(localStorage, ACTIVE_KEY) || STORE_IDS[0];
    const current = parse(nativeGetItem.call(localStorage, MAIN_KEY));
    if (valid(current)) await dbPut(dbRef, currentId, validateStoreData(current, `本地“${STORE_NAMES[currentId]}”`));
    const next = await dbGet(dbRef, nextId);
    if (!valid(next)) {
      const dialog = document.getElementById("cloudDialog");
      if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
      cloudNote("这台设备尚未初始化全部门店。登录后点击一次“拉取云端数据”，系统会自动下载最新8家门店。", true);
      throw new Error(`本机尚无“${STORE_NAMES[nextId]}”数据，请先登录并拉取云端数据。`);
    }
    validateStoreData(next, `IndexedDB“${STORE_NAMES[nextId]}”`);
    purgePlanogramLocal();
    writeCurrent(nextId, next);
    location.reload();
  }
  async function collectAllStores() {
    const stores = {};
    for (const id of STORE_IDS) stores[id] = validateStoreData(await dbGet(dbRef, id), `IndexedDB“${STORE_NAMES[id]}”`);
    return stores;
  }
  async function downloadAll() {
    const stores = await collectAllStores();
    downloadJson(`八家门店IndexedDB完整备份_${timestamp()}.json`, {
      type: "planogram-idb-all-store-backup",
      version: VERSION,
      createdAt: new Date().toISOString(),
      stores
    });
  }
  async function downloadCurrentBackup(reason) {
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    const data = await currentData();
    downloadJson(`${STORE_NAMES[id]}_${reason}_${timestamp()}.json`, {
      type: "planogram-single-store-safety-backup",
      version: VERSION,
      createdAt: new Date().toISOString(),
      storeId: id,
      storeName: STORE_NAMES[id],
      data
    });
  }

  const exportInteger = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  };
  const exportNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  function exportLayer(group, layer) {
    const source = group?.layers?.[layer] || {};
    return {
      capacity: Math.max(0, exportInteger(source.capacity, 0)),
      pits: Array.isArray(source.pits) ? source.pits : []
    };
  }
  function buildPlacedOnlyExportRows(data) {
    const productsById = new Map((data.products || []).map(product => [product.id, product]));
    const placedProductIds = new Set();
    (data.groups || []).forEach(group => {
      ["D", "C", "B", "A"].forEach(layer => {
        exportLayer(group, layer).pits.forEach(pit => {
          const product = productsById.get(pit.productId);
          if (product && product.status !== "eliminated") placedProductIds.add(product.id);
        });
      });
    });
    const products = (data.products || [])
      .filter(product => placedProductIds.has(product.id) && product.status !== "eliminated")
      .map(product => ({
        "一级品类": product.category || "",
        "二级品类": product.secondCategory || "",
        "三级品类": product.thirdCategory || "",
        "四级品类": product.fourthCategory || "",
        "SKU编码": product.barcode || "",
        "SKU名称": product.name || "",
        "等级": product.grade || "",
        "新品状态": product.newFlag || "",
        "长(mm)": exportInteger(product.faceWidth, 0),
        "宽(mm)": exportInteger(product.depth, 0),
        "高(mm)": exportInteger(product.height, 0),
        "箱规(件/箱)": exportInteger(product.packSize, 0),
        "满陈箱数": exportInteger(product.shelfBoxes, 0),
        "周转天数": exportNumber(product.turnoverDays, 0),
        "基础坑位": exportInteger(product.basePits, 0),
        "计划坑位": exportInteger(product.plannedPits, 0),
        "状态": "陈列中"
      }));
    const layerRows = (data.groups || []).flatMap(group => ["D", "C", "B", "A"].map(layer => {
      const layerData = exportLayer(group, layer);
      const visiblePits = layerData.pits.filter(pit => placedProductIds.has(pit.productId));
      const used = visiblePits.reduce((sum, pit) => {
        const product = productsById.get(pit.productId);
        return sum + Math.max(0, exportInteger(product?.faceWidth, 0));
      }, 0);
      return {
        "一级品类": group.category || "",
        "二级品类": group.secondCategory || "",
        "货架组": group.id || "",
        "货架类型": group.type || "",
        "层级": layer,
        "容量(mm)": layerData.capacity,
        "已用(mm)": used,
        "余量(mm)": Math.max(0, layerData.capacity - used),
        "坑位数": visiblePits.length
      };
    }));
    const placements = (data.groups || []).flatMap(group => ["D", "C", "B", "A"].flatMap(layer => {
      const layerData = exportLayer(group, layer);
      let visibleOrder = 0;
      return layerData.pits.flatMap(pit => {
        if (!placedProductIds.has(pit.productId)) return [];
        const product = productsById.get(pit.productId);
        if (!product || product.status === "eliminated") return [];
        visibleOrder += 1;
        return [{
          "货架组": group.id || "",
          "层级": layer,
          "顺序": visibleOrder,
          "坑位ID": pit.id || "",
          "SKU编码": product.barcode || pit.barcode || "",
          "SKU名称": product.name || "",
          "坑位类型": pit.kind === "expansion" ? "扩陈" : "基础"
        }];
      });
    }));
    return { products, layerRows, placements };
  }
  function safeExportFileName(value) {
    return String(value || "当前云端陈列底表").replace(/[\/:*?"<>|]/g, "_");
  }
  function exportPlacedOnlyCloudExcel(data, id) {
    if (!window.XLSX) throw new Error("Excel导出组件未加载，请联网刷新页面后重试。");
    validateStoreData(data, `云端“${STORE_NAMES[id]}”`);
    const rows = buildPlacedOnlyExportRows(data);
    if (!rows.products.length || !rows.placements.length) throw new Error("当前门店云端数据中没有陈列图上的SKU可导出。");
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.products), "SKU底表");
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.layerRows), "货架层");
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.placements), "陈列坑位");
    const date = new Date().toISOString().slice(0, 10);
    window.XLSX.writeFile(workbook, safeExportFileName(`${STORE_NAMES[id]}_当前云端陈列中SKU底表_${date}.xlsx`));
    return rows;
  }
  async function exportCurrentCloudExcel() {
    await requireSession();
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    cloudNote(`正在读取“${STORE_NAMES[id]}”云端数据并导出Excel…`);
    const remote = await readCloudDocument();
    const remoteData = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
    const rows = exportPlacedOnlyCloudExcel(remoteData, id);
    cloudNote(`已导出“${STORE_NAMES[id]}”云端第${remote.revision}版Excel：${rows.products.length}个陈列中SKU、${rows.placements.length}个坑位。`);
    return { revision: remote.revision, products: rows.products.length, placements: rows.placements.length };
  }

  function cloudClient() {
    return window.PLANOGRAM_CLOUD_CLIENT || null;
  }
  function cloudNote(message, isError = false) {
    const node = document.getElementById("cloudSyncStatus");
    if (node) {
      node.textContent = message;
      node.classList.toggle("error", isError);
    }
    const status = document.getElementById("statusBar");
    if (status) {
      status.textContent = message;
      status.classList.toggle("error", isError);
    }
  }
  async function requireSession() {
    const client = cloudClient();
    if (!client) throw new Error("云端组件尚未初始化，请刷新页面后重试。\n");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data?.session?.user) throw new Error("请先登录云端协作账号。\n");
    return data.session;
  }
  async function readCloudDocument() {
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_documents")
      .select("payload,revision,updated_at")
      .eq("id", CLOUD_DOCUMENT_ID)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("未找到云端主数据记录。\n");
    validateCloudPayload(data.payload);
    return data;
  }
  async function saveCloudPayload(payload, expectedRevision) {
    validateCloudPayload(payload);
    const client = cloudClient();
    payload.updatedAt = new Date().toISOString();
    payload.version = VERSION;
    const { data, error } = await client.rpc("save_planogram_document", {
      p_payload: payload,
      p_expected_revision: expectedRevision
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return Number(row?.revision) || Number(expectedRevision) + 1;
  }

  async function initializeAllStoresFromCloud(remote, preferredStoreId = null) {
    validateCloudPayload(remote.payload);
    const initialized = [];
    const repairs = [];
    for (const id of STORE_IDS) {
      const remoteData = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
      const repaired = repairStoreCapacity(remoteData, id);
      await dbPut(dbRef, id, repaired.data);
      await setCloudBase(dbRef, id, repaired.data, remote.revision);
      initialized.push(id);
      if (repaired.repairs.length) repairs.push(...repaired.repairs);
    }
    const selected = STORE_IDS.includes(preferredStoreId) ? preferredStoreId : STORE_IDS[0];
    const selectedData = validateStoreData(await dbGet(dbRef, selected), `初始化“${STORE_NAMES[selected]}”`);
    purgePlanogramLocal();
    writeCurrent(selected, selectedData);
    selectedStoreId = selected;
    firstDeviceInitializationNeeded = false;
    missingLocalStoreIds = [];
    return { selected, initialized, repairs, revision: remote.revision };
  }

  async function checkAllCloud() {
    await requireSession();
    cloudNote("正在只读核对云端8家门店…");
    const remote = await readCloudDocument();
    const mismatches = [];
    for (const id of STORE_IDS) {
      const local = validateStoreData(await dbGet(dbRef, id), `本地“${STORE_NAMES[id]}”`);
      const cloud = remote.payload.stores[id];
      if (sameData(local, cloud)) {
        await setCloudBase(dbRef, id, cloud, remote.revision);
      } else {
        mismatches.push(STORE_NAMES[id]);
      }
    }
    if (mismatches.length) {
      cloudNote(`云端第${remote.revision}版已核对：${8 - mismatches.length}家一致；以下门店本地与云端不同，未覆盖：${mismatches.join("、")}。请切换到对应门店后使用“拉取云端数据”核对。`, true);
      return { revision: remote.revision, mismatches };
    }
    cloudNote(`核对完成：本地8家门店与云端第${remote.revision}版完全一致。现在可以编辑，修改后使用“保存至云端”。`);
    return { revision: remote.revision, mismatches: [] };
  }

  async function safePullCurrentStore(options = {}) {
    await requireSession();
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    cloudNote(`正在拉取“${STORE_NAMES[id]}”云端数据…`);
    const remote = await readCloudDocument();
    const localScan = await scanLocalStores();

    if (localScan.missingIds.length) {
      cloudNote(`检测到本机首次使用，正在从云端第${remote.revision}版自动初始化全部8家门店…`);
      const result = await initializeAllStoresFromCloud(remote, id);
      const repairText = result.repairs.length ? `，并修复${result.repairs.length}处历史容量异常` : "";
      cloudNote(`初始化完成：已从云端第${remote.revision}版下载最新8家门店${repairText}，正在刷新。`);
      if (!options.noReload) location.reload();
      return { changed: true, initializedAll: true, revision: remote.revision, repairs: result.repairs.length };
    }

    const remoteData = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
    const localData = await currentData();
    if (sameData(localData, remoteData)) {
      await setCloudBase(dbRef, id, remoteData, remote.revision);
      cloudNote(`“${STORE_NAMES[id]}”本地与云端第${remote.revision}版完全一致，已建立安全保存基准。`);
      return { changed: false, revision: remote.revision };
    }

    await downloadCurrentBackup("拉取云端前备份");
    const localSummary = `${localData.products.length}个商品、${localData.groups.length}组、${countPits(localData)}个坑位`;
    const remoteSummary = `${remoteData.products.length}个商品、${remoteData.groups.length}组、${countPits(remoteData)}个坑位`;
    const confirmed = options.force === true || window.confirm(
      `检测到“${STORE_NAMES[id]}”本地与云端第${remote.revision}版不同。\n\n本地：${localSummary}\n云端：${remoteSummary}\n\n已先下载本地备份。确定仅用云端覆盖当前门店吗？其他7家不会改动。`
    );
    if (!confirmed) {
      cloudNote(`已取消拉取，“${STORE_NAMES[id]}”本地数据保持不变。`, true);
      return { changed: false, cancelled: true, revision: remote.revision };
    }
    await dbPut(dbRef, id, remoteData);
    await setCloudBase(dbRef, id, remoteData, remote.revision);
    purgePlanogramLocal();
    writeCurrent(id, remoteData);
    cloudNote(`“${STORE_NAMES[id]}”已拉取云端第${remote.revision}版，正在刷新。`);
    if (!options.noReload) location.reload();
    return { changed: true, revision: remote.revision };
  }
  async function safePushCurrentStore() {
    const session = await requireSession();
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    cloudNote(`正在保存“${STORE_NAMES[id]}”至云端…`);
    const localData = await currentData();
    let baseData = await getCloudBase(dbRef, id);
    const remote = await readCloudDocument();
    const remoteCurrent = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
    if (!valid(baseData)) {
      await setCloudBase(dbRef, id, remoteCurrent, remote.revision);
      baseData = remoteCurrent;
    }
    if (!sameData(remoteCurrent, baseData)) {
      throw new Error(`“${STORE_NAMES[id]}”云端已被其他成员更新。已阻止保存，避免覆盖。请先拉取云端数据核对。`);
    }
    if (sameData(localData, remoteCurrent)) {
      await setCloudBase(dbRef, id, remoteCurrent, remote.revision);
      cloudNote(`“${STORE_NAMES[id]}”没有新修改，无需保存；当前云端为第${remote.revision}版。`);
      return { changed: false, revision: remote.revision };
    }

    await downloadCurrentBackup("保存云端前备份");
    const nextPayload = clone(remote.payload);
    nextPayload.stores[id] = clone(localData);
    nextPayload.storeMeta = isRecord(nextPayload.storeMeta) ? nextPayload.storeMeta : {};
    nextPayload.storeMeta[id] = {
      ...(nextPayload.storeMeta[id] || {}),
      name: STORE_NAMES[id],
      updatedAt: new Date().toISOString(),
      updatedBy: session.user.email || session.user.id,
      safetyMode: "indexeddb-current-store-only"
    };
    const revision = await saveCloudPayload(nextPayload, remote.revision);
    await dbPut(dbRef, id, localData);
    await setCloudBase(dbRef, id, localData, revision);
    cloudNote(`“${STORE_NAMES[id]}”已保存至云端第${revision}版；其他7家门店原样保留。`);
    return { changed: true, revision };
  }

  function interceptButton(id, handler) {
    const node = document.getElementById(id);
    if (!node || node.dataset.safeCloudBound === "1") return;
    node.dataset.safeCloudBound = "1";
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      node.disabled = true;
      Promise.resolve(handler(event))
        .catch(error => cloudNote(error?.message || "云端操作失败。", true))
        .finally(() => { node.disabled = false; });
    }, true);
  }

  function installCloudControls() {
    const pull = document.getElementById("cloudPullBtn");
    const push = document.getElementById("cloudPushBtn");
    if (pull) { pull.disabled = false; pull.textContent = "拉取云端数据"; pull.title = "新设备首次拉取会自动初始化最新8家门店；之后只覆盖当前门店"; }
    if (push) { push.disabled = false; push.textContent = "保存至云端"; push.title = "保存当前门店全部品类；其他7家门店保持不变"; }

    document.getElementById("cloudCheckAllBtn")?.remove();
    const helper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (helper) helper.textContent = "新设备首次拉取会自动初始化最新8家门店；之后拉取和保存仅作用于当前门店。保存包含该店全部品类，其他7家不会被覆盖。";
    const title = document.querySelector("#cloudDialog .dialog-header h2");
    if (title) title.textContent = `${STORE_NAMES[selectedStoreId]}｜云端数据协作`;

    const reset = document.getElementById("confirmResetBtn");
    if (reset) { reset.disabled = true; reset.title = "多门店模式禁止一键恢复底表，避免误覆盖"; }
    const exportCloud = document.getElementById("exportCloudExcelBtn");
    if (exportCloud) {
      exportCloud.disabled = false;
      exportCloud.textContent = "导出当前云端 Excel";
      exportCloud.title = "直接读取当前门店云端数据并导出，不覆盖本地";
    }

    interceptButton("cloudPullBtn", safePullCurrentStore);
    interceptButton("cloudPushBtn", safePushCurrentStore);
    interceptButton("exportCloudExcelBtn", exportCurrentCloudExcel);
  }

  async function injectUi() {
    await window.PLANOGRAM_STORE_READY;
    const context = window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot = document.querySelector(".topbar > div:first-child");
    const eyebrow = titleRoot?.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = context.storeName;

    const holder = document.createElement("div");
    holder.className = "store-switcher";
    holder.innerHTML = `<label for="storeSelect">门店</label><select id="storeSelect">${STORE_IDS.map(id => `<option value="${id}" ${id === context.storeId ? "selected" : ""}>${STORE_NAMES[id]}</option>`).join("")}</select><button id="downloadIdbAllBtn" class="btn" type="button">备份全部8家门店</button>`;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change", event => {
      const select = event.target;
      const previousValue = context.storeId;
      select.disabled = true;
      switchStore(select.value).catch(error => {
        select.value = previousValue;
        select.disabled = false;
        alert(error.message);
      });
    });
    holder.querySelector("#downloadIdbAllBtn")?.addEventListener("click", () => downloadAll().catch(error => alert(error.message)));

    installCloudControls();
    const status = document.getElementById("statusBar");
    if (status) {
      const currentRepairs = capacityRepairReport.filter(item => item.storeId === context.storeId);
      if (currentRepairs.length) {
        const removedCount = currentRepairs.reduce((sum, item) => sum + item.removed.length, 0);
        const detail = currentRepairs.map(item => `${item.groupId}-${item.layer}层移出${item.removed.length}个超容量坑位，余量${item.remaining}mm`).join("；");
        status.textContent = `已修复“${context.storeName}”容量异常：${detail}。共${removedCount}个坑位对应SKU已进入未放入池，请核对后保存至云端。`;
        status.classList.remove("error");
      } else if (context.firstDeviceInitializationNeeded) {
        status.textContent = `这台设备首次使用：请打开“云端协作”登录，然后点击一次“拉取云端数据”。系统会自动下载云端最新8家门店，无需单独恢复。`;
        status.classList.remove("error");
      } else {
        status.textContent = `8家门店已保存在IndexedDB；当前为“${context.storeName}”。可正常编辑、拉取、保存及导出。`;
        status.classList.remove("error");
      }
    }
  }

  window.addEventListener("planogram:app-ready", injectUi, { once: true });
  window.PLANOGRAM_IDB_DEBUG = {
    version: VERSION,
    storeIds: STORE_IDS.slice(),
    switchStore,
    downloadAll,
    checkAllCloud,
    safePullCurrentStore,
    safePushCurrentStore,
    collectAllStores,
    getCloudBase: id => getCloudBase(dbRef, id),
    exportCurrentCloudExcel,
    capacityRepairReport: () => clone(capacityRepairReport),
    repairStoreCapacity,
    initializeAllStoresFromCloud,
    scanLocalStores
  };
})();
