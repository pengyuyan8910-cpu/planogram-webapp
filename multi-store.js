(() => {
  "use strict";

  const VERSION = "2026.08.04.11";
  const DB_NAME = "planogram-stable-v2";
  const DB_VERSION = 1;
  const STORE_TABLE = "stores";
  const BACKUP_TABLE = "backups";
  const META_TABLE = "meta";
  const LEGACY_DB_NAME = "planogram-eight-store-recovery-v1";
  const LEGACY_STORE_TABLE = "stores";
  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const LEGACY_CLOUD_ID = "main";
  const MIGRATION_FLAG = "stable_v2_enabled";
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

  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const clone = value => JSON.parse(JSON.stringify(value));
  const parse = value => { try { return value ? JSON.parse(value) : null; } catch (_) { return null; } };
  const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
  const nowIso = () => new Date().toISOString();
  const timestamp = () => nowIso().replace(/[:.]/g, "-");

  let dbRef = null;
  let selectedStoreId = STORE_IDS[0];
  let memoryState = null;
  let writeQueue = Promise.resolve();
  let startupReport = { imported: [], backedUp: [], missing: [], source: "" };

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

  function stableString(value) {
    return JSON.stringify(stableValue(value));
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function dataHash(value) {
    return hashString(stableString(value));
  }

  function sameData(left, right) {
    return dataHash(left) === dataHash(right) && stableString(left) === stableString(right);
  }


  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const copyValue = value => value === undefined ? undefined : clone(value);
  const equalValue = (left, right) => stableString(left) === stableString(right);

  function conflictValue(key, path, base, local, remote, resolutions, conflicts, kind = "field") {
    const choice = resolutions?.[key];
    if (choice === "local") return copyValue(local);
    if (choice === "remote") return copyValue(remote);
    conflicts.push({ key, path, kind, base: copyValue(base), local: copyValue(local), remote: copyValue(remote) });
    return copyValue(local);
  }

  function mergeValue(path, base, local, remote, resolutions, conflicts, keyPrefix = path) {
    if (equalValue(local, base)) return copyValue(remote);
    if (equalValue(remote, base)) return copyValue(local);
    if (equalValue(local, remote)) return copyValue(local);
    if (isRecord(base) && isRecord(local) && isRecord(remote)) {
      const out = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
      [...keys].sort().forEach(key => {
        const value = mergeValue(`${path}.${key}`, base[key], local[key], remote[key], resolutions, conflicts, `${keyPrefix}:${key}`);
        if (value !== undefined) out[key] = value;
      });
      return out;
    }
    return conflictValue(keyPrefix, path, base, local, remote, resolutions, conflicts);
  }

  function mergeKeyedObjects(baseItems, localItems, remoteItems, kind, resolutions, conflicts, itemTransform = value => value) {
    const mapOf = items => new Map((Array.isArray(items) ? items : []).filter(isRecord).map(item => [item.id, item]));
    const baseMap = mapOf(baseItems), localMap = mapOf(localItems), remoteMap = mapOf(remoteItems);
    const orderedIds = [];
    [remoteItems, localItems, baseItems].forEach(items => (Array.isArray(items) ? items : []).forEach(item => {
      if (item?.id && !orderedIds.includes(item.id)) orderedIds.push(item.id);
    }));
    const output = [];
    orderedIds.forEach(id => {
      const b = baseMap.get(id), l = localMap.get(id), r = remoteMap.get(id);
      const key = `${kind}:${id}`;
      if (!b) {
        if (l && !r) output.push(copyValue(l));
        else if (r && !l) output.push(copyValue(r));
        else if (l && r) output.push(equalValue(l, r) ? copyValue(l) : conflictValue(key, `${kind}[${id}]`, undefined, l, r, resolutions, conflicts, kind));
        return;
      }
      if (!l && !r) return;
      if (!l && r) {
        if (equalValue(r, b)) return;
        const chosen = conflictValue(key, `${kind}[${id}]删除/云端修改`, b, undefined, r, resolutions, conflicts, kind);
        if (chosen !== undefined) output.push(chosen);
        return;
      }
      if (l && !r) {
        if (equalValue(l, b)) return;
        const chosen = conflictValue(key, `${kind}[${id}]本地修改/云端删除`, b, l, undefined, resolutions, conflicts, kind);
        if (chosen !== undefined) output.push(chosen);
        return;
      }
      const tb = itemTransform(b), tl = itemTransform(l), tr = itemTransform(r);
      const merged = mergeValue(`${kind}[${id}]`, tb, tl, tr, resolutions, conflicts, key);
      if (merged !== undefined) output.push(merged);
    });
    return output;
  }

  function stripGroupPits(group) {
    if (!group) return group;
    const next = copyValue(group);
    next.layers = next.layers || {};
    ["A", "B", "C", "D"].forEach(layer => {
      next.layers[layer] = next.layers[layer] || {};
      next.layers[layer].pits = [];
    });
    return next;
  }

  function extractPitState(data, basePitIds = null) {
    const map = new Map();
    const sequences = new Map();
    (data?.groups || []).forEach(group => ["A", "B", "C", "D"].forEach(layer => {
      const key = `${group.id}::${layer}`;
      const pits = Array.isArray(group?.layers?.[layer]?.pits) ? group.layers[layer].pits : [];
      const ids = pits.map((pit, index) => pit?.id || `__missing__${key}::${index}::${pit?.productId || ""}`);
      sequences.set(key, ids);
      pits.forEach((pit, index) => {
        const id = ids[index];
        let previousBaseId = null;
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          if (!basePitIds || basePitIds.has(ids[cursor])) { previousBaseId = ids[cursor]; break; }
        }
        map.set(id, { id, groupId: group.id, layer, index, previousBaseId, pit: copyValue(pit) });
      });
    }));
    return { map, sequences };
  }

  function pitPlacementComparable(item) {
    if (!item) return undefined;
    return { groupId: item.groupId, layer: item.layer, previousBaseId: item.previousBaseId, pit: item.pit };
  }

  function mergePits(baseData, localData, remoteData, resolutions, conflicts) {
    const baseState = extractPitState(baseData);
    const baseIds = new Set(baseState.map.keys());
    const localState = extractPitState(localData, baseIds);
    const remoteState = extractPitState(remoteData, baseIds);
    const allIds = new Set([...baseState.map.keys(), ...localState.map.keys(), ...remoteState.map.keys()]);
    const chosen = new Map();

    allIds.forEach(id => {
      const b = baseState.map.get(id), l = localState.map.get(id), r = remoteState.map.get(id);
      const bc = pitPlacementComparable(b), lc = pitPlacementComparable(l), rc = pitPlacementComparable(r);
      const key = `pit:${id}`;
      let value;
      if (!b) {
        if (l && !r) value = l;
        else if (r && !l) value = r;
        else if (l && r) value = equalValue(lc, rc) ? l : conflictValue(key, `坑位[${id}]两端新增不同`, undefined, l, r, resolutions, conflicts, "pit");
      } else if (!l && !r) {
        value = undefined;
      } else if (!l && r) {
        value = equalValue(rc, bc) ? undefined : conflictValue(key, `坑位[${id}]本地删除/云端修改`, b, undefined, r, resolutions, conflicts, "pit");
      } else if (l && !r) {
        value = equalValue(lc, bc) ? undefined : conflictValue(key, `坑位[${id}]本地修改/云端删除`, b, l, undefined, resolutions, conflicts, "pit");
      } else if (equalValue(lc, bc)) {
        value = r;
      } else if (equalValue(rc, bc)) {
        value = l;
      } else if (equalValue(lc, rc)) {
        value = l;
      } else {
        value = conflictValue(key, `坑位[${id}]同时被不同方式修改`, b, l, r, resolutions, conflicts, "pit");
      }
      if (value !== undefined) chosen.set(id, copyValue(value));
    });

    const resultSequences = new Map();
    remoteState.sequences.forEach((ids, key) => resultSequences.set(key, ids.filter(id => chosen.has(id))));
    chosen.forEach((item, id) => {
      const targetKey = `${item.groupId}::${item.layer}`;
      if (!resultSequences.has(targetKey)) resultSequences.set(targetKey, []);
      resultSequences.forEach((ids, key) => {
        const index = ids.indexOf(id);
        if (index >= 0 && key !== targetKey) ids.splice(index, 1);
      });
      const target = resultSequences.get(targetKey);
      if (target.includes(id)) return;
      const localSeq = localState.sequences.get(targetKey) || [];
      const remoteSeq = remoteState.sequences.get(targetKey) || [];
      const preferredSeq = localState.map.has(id) ? localSeq : remoteSeq;
      const pos = preferredSeq.indexOf(id);
      let inserted = false;
      for (let i = pos - 1; i >= 0; i -= 1) {
        const prev = preferredSeq[i];
        const found = target.indexOf(prev);
        if (found >= 0) { target.splice(found + 1, 0, id); inserted = true; break; }
      }
      if (!inserted) {
        for (let i = pos + 1; i < preferredSeq.length; i += 1) {
          const next = preferredSeq[i];
          const found = target.indexOf(next);
          if (found >= 0) { target.splice(found, 0, id); inserted = true; break; }
        }
      }
      if (!inserted) target.push(id);
    });
    return { chosen, sequences: resultSequences };
  }

  function mergeStoreData(base, local, remote, resolutions = {}) {
    const conflicts = [];
    const rootBase = copyValue(base), rootLocal = copyValue(local), rootRemote = copyValue(remote);
    delete rootBase.products; delete rootBase.groups;
    delete rootLocal.products; delete rootLocal.groups;
    delete rootRemote.products; delete rootRemote.groups;
    const mergedRoot = mergeValue("store", rootBase, rootLocal, rootRemote, resolutions, conflicts, "store") || {};
    const products = mergeKeyedObjects(base.products, local.products, remote.products, "product", resolutions, conflicts);
    const mergedGroups = mergeKeyedObjects(base.groups, local.groups, remote.groups, "group", resolutions, conflicts, stripGroupPits);
    const pitResult = mergePits(base, local, remote, resolutions, conflicts);
    const groupsById = new Map(mergedGroups.map(group => [group.id, group]));
    pitResult.sequences.forEach((ids, key) => {
      const [groupId, layer] = key.split("::");
      const group = groupsById.get(groupId);
      if (!group) return;
      group.layers = group.layers || {};
      group.layers[layer] = group.layers[layer] || { capacity: 0, pits: [] };
      group.layers[layer].pits = ids.map(id => pitResult.chosen.get(id)?.pit).filter(Boolean);
    });
    mergedGroups.forEach(group => ["A", "B", "C", "D"].forEach(layer => {
      group.layers = group.layers || {};
      group.layers[layer] = group.layers[layer] || { capacity: 0, pits: [] };
      if (!Array.isArray(group.layers[layer].pits)) group.layers[layer].pits = [];
    }));
    const data = { ...mergedRoot, products, groups: mergedGroups };
    return { data, conflicts };
  }

  function countPits(data) {
    return (data?.groups || []).reduce((sum, group) => sum + ["A", "B", "C", "D"].reduce((layerSum, layer) => (
      layerSum + (Array.isArray(group?.layers?.[layer]?.pits) ? group.layers[layer].pits.length : 0)
    ), 0), 0);
  }

  function validateStoreData(data, label = "门店", options = {}) {
    const strictCapacity = options.strictCapacity === true;
    const errors = [];
    if (!isRecord(data)) errors.push(`${label}不是有效对象`);
    if (!Array.isArray(data?.products) || data.products.length === 0) errors.push(`${label}商品池为空`);
    if (!Array.isArray(data?.groups) || data.groups.length === 0) errors.push(`${label}货架组为空`);
    if (errors.length) return { ok: false, errors };

    const productIds = new Set();
    const productsById = new Map();
    data.products.forEach((product, index) => {
      if (!isRecord(product)) {
        errors.push(`${label}第${index + 1}条商品不是对象`);
        return;
      }
      if (typeof product.id !== "string" || !product.id.trim()) {
        errors.push(`${label}第${index + 1}条商品缺少有效ID`);
        return;
      }
      if (productIds.has(product.id)) errors.push(`${label}存在重复商品ID：${product.id}`);
      productIds.add(product.id);
      productsById.set(product.id, product);
    });

    const groupIds = new Set();
    data.groups.forEach((group, groupIndex) => {
      if (!isRecord(group)) {
        errors.push(`${label}第${groupIndex + 1}个货架组不是对象`);
        return;
      }
      if (typeof group.id !== "string" || !group.id.trim()) {
        errors.push(`${label}第${groupIndex + 1}个货架组缺少有效ID`);
        return;
      }
      if (groupIds.has(group.id)) errors.push(`${label}存在重复货架组ID：${group.id}`);
      groupIds.add(group.id);
      ["A", "B", "C", "D"].forEach(layer => {
        const layerData = group.layers?.[layer];
        if (!isRecord(layerData) || !Array.isArray(layerData.pits)) {
          errors.push(`${label} ${group.id}-${layer}层坑位不是数组`);
          return;
        }
        let used = 0;
        layerData.pits.forEach((pit, pitIndex) => {
          if (!isRecord(pit) || typeof pit.productId !== "string" || !productIds.has(pit.productId)) {
            errors.push(`${label} ${group.id}-${layer}层第${pitIndex + 1}个坑位引用无效商品`);
            return;
          }
          const width = Number(productsById.get(pit.productId)?.faceWidth);
          used += Number.isFinite(width) && width > 0 ? width : 0;
        });
        if (strictCapacity) {
          const capacity = Number(layerData.capacity);
          const safeCapacity = Number.isFinite(capacity) ? capacity : 0;
          if (safeCapacity < 0 || used > safeCapacity) {
            errors.push(`${label} ${group.id}-${layer}层容量${safeCapacity}mm，已用${used}mm，超出${Math.max(0, used - safeCapacity)}mm`);
          }
        }
      });
    });
    return { ok: errors.length === 0, errors };
  }

  function assertStoreData(data, label = "门店", options = {}) {
    const result = validateStoreData(data, label, options);
    if (!result.ok) throw new Error(result.errors.slice(0, 8).join("；"));
    return data;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_TABLE)) db.createObjectStore(STORE_TABLE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(BACKUP_TABLE)) {
          const backups = db.createObjectStore(BACKUP_TABLE, { keyPath: "key" });
          backups.createIndex("storeId", "storeId", { unique: false });
          backups.createIndex("createdAt", "createdAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(META_TABLE)) db.createObjectStore(META_TABLE, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("稳定版IndexedDB打开失败"));
    });
  }

  function txRequest(request, fallbackMessage) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(fallbackMessage));
    });
  }

  async function dbGetStore(id) {
    const row = await txRequest(dbRef.transaction(STORE_TABLE, "readonly").objectStore(STORE_TABLE).get(id), "读取门店数据失败");
    return row || null;
  }

  async function dbPutStore(id, data, patch = {}) {
    assertStoreData(data, `本地“${STORE_NAMES[id] || id}”`);
    const old = await dbGetStore(id);
    const row = {
      id,
      name: STORE_NAMES[id] || id,
      data: clone(data),
      dataHash: dataHash(data),
      localUpdatedAt: nowIso(),
      cloudRevision: patch.cloudRevision ?? old?.cloudRevision ?? null,
      cloudHash: patch.cloudHash ?? old?.cloudHash ?? null,
      cloudBaseData: patch.cloudBaseData !== undefined ? copyValue(patch.cloudBaseData) : copyValue(old?.cloudBaseData ?? null),
      cloudUpdatedAt: patch.cloudUpdatedAt ?? old?.cloudUpdatedAt ?? null,
      source: patch.source ?? old?.source ?? "local",
      bootstrapOnly: patch.bootstrapOnly ?? old?.bootstrapOnly ?? false,
      dirty: patch.dirty ?? ((patch.cloudHash ?? old?.cloudHash) ? dataHash(data) !== (patch.cloudHash ?? old?.cloudHash) : true)
    };
    await new Promise((resolve, reject) => {
      const tx = dbRef.transaction(STORE_TABLE, "readwrite");
      tx.objectStore(STORE_TABLE).put(row);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("保存门店数据失败"));
      tx.onabort = () => reject(tx.error || new Error("保存门店数据中止"));
    });
    return row;
  }

  async function dbGetAllStores() {
    const rows = await txRequest(dbRef.transaction(STORE_TABLE, "readonly").objectStore(STORE_TABLE).getAll(), "读取全部门店失败");
    return Array.isArray(rows) ? rows : [];
  }

  async function dbPutMeta(key, value) {
    await new Promise((resolve, reject) => {
      const tx = dbRef.transaction(META_TABLE, "readwrite");
      tx.objectStore(META_TABLE).put({ key, value, updatedAt: nowIso() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("保存同步元数据失败"));
    });
  }

  async function dbGetMeta(key) {
    const row = await txRequest(dbRef.transaction(META_TABLE, "readonly").objectStore(META_TABLE).get(key), "读取同步元数据失败");
    return row?.value ?? null;
  }

  async function saveLocalBackup(storeId, data, reason, extra = {}) {
    if (!data || !validateStoreData(data).ok) return null;
    const key = `${storeId}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      key,
      storeId,
      storeName: STORE_NAMES[storeId] || storeId,
      reason,
      data: clone(data),
      dataHash: dataHash(data),
      createdAt: nowIso(),
      ...extra
    };
    await new Promise((resolve, reject) => {
      const tx = dbRef.transaction(BACKUP_TABLE, "readwrite");
      tx.objectStore(BACKUP_TABLE).put(row);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("保存本地历史备份失败"));
    });
    await trimLocalBackups(storeId, 12);
    return row;
  }

  async function trimLocalBackups(storeId, keep = 12) {
    const rows = await txRequest(dbRef.transaction(BACKUP_TABLE, "readonly").objectStore(BACKUP_TABLE).index("storeId").getAll(storeId), "读取历史备份失败");
    const oldRows = (rows || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(keep);
    if (!oldRows.length) return;
    await new Promise((resolve, reject) => {
      const tx = dbRef.transaction(BACKUP_TABLE, "readwrite");
      oldRows.forEach(row => tx.objectStore(BACKUP_TABLE).delete(row.key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("清理旧备份失败"));
    });
  }

  function openLegacyDbIfExists() {
    return new Promise(resolve => {
      let created = false;
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onupgradeneeded = () => {
        created = true;
        request.transaction.abort();
      };
      request.onsuccess = () => {
        if (created) {
          request.result.close();
          indexedDB.deleteDatabase(LEGACY_DB_NAME);
          resolve(null);
          return;
        }
        resolve(request.result);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  async function readLegacyStores() {
    const legacyDb = await openLegacyDbIfExists();
    if (!legacyDb || !legacyDb.objectStoreNames.contains(LEGACY_STORE_TABLE)) return [];
    try {
      const rows = await txRequest(legacyDb.transaction(LEGACY_STORE_TABLE, "readonly").objectStore(LEGACY_STORE_TABLE).getAll(), "读取旧版IndexedDB失败");
      return (rows || []).filter(row => STORE_IDS.includes(row.id) && validateStoreData(row.data).ok);
    } finally {
      legacyDb.close();
    }
  }

  function downloadJson(filename, value) {
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

  function nativeSelectedStore() {
    const active = nativeGetItem.call(localStorage, ACTIVE_KEY);
    const selected = nativeGetItem.call(localStorage, SELECTED_KEY);
    if (STORE_IDS.includes(active)) return active;
    if (STORE_IDS.includes(selected)) return selected;
    return STORE_IDS[0];
  }

  function setMemoryStore(id, data) {
    selectedStoreId = id;
    memoryState = clone(assertStoreData(data, `当前“${STORE_NAMES[id]}”`));
    nativeSetItem.call(localStorage, SELECTED_KEY, id);
    nativeSetItem.call(localStorage, ACTIVE_KEY, id);
    nativeRemoveItem.call(localStorage, MAIN_KEY);
  }

  function installVirtualStorage() {
    Storage.prototype.getItem = function(key) {
      if (this === localStorage && key === MAIN_KEY && memoryState) return JSON.stringify(memoryState);
      return nativeGetItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && key === MAIN_KEY) {
        const parsed = parse(value);
        const result = validateStoreData(parsed, `当前“${STORE_NAMES[selectedStoreId]}”`);
        if (!result.ok) {
          console.error("拒绝持久化损坏数据", result.errors);
          showStatus(`本地保存被阻止：${result.errors.slice(0, 3).join("；")}`, true);
          return;
        }
        memoryState = clone(parsed);
        writeQueue = writeQueue
          .then(async () => {
            const old = await dbGetStore(selectedStoreId);
            await dbPutStore(selectedStoreId, parsed, {
              cloudRevision: old?.cloudRevision ?? null,
              cloudHash: old?.cloudHash ?? null,
              cloudUpdatedAt: old?.cloudUpdatedAt ?? null,
              source: "app-edit",
              bootstrapOnly: false,
              dirty: old?.cloudHash ? dataHash(parsed) !== old.cloudHash : true
            });
          })
          .catch(error => {
            console.error(error);
            showStatus(`本地保存失败：${error.message}`, true);
          });
        return;
      }
      nativeSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (this === localStorage && key === MAIN_KEY) return;
      nativeRemoveItem.call(this, key);
    };
  }

  async function importExistingLocalData() {
    const existingRows = await dbGetAllStores();
    const existingIds = new Set(existingRows.map(row => row.id));
    const legacyRows = await readLegacyStores();

    for (const legacy of legacyRows) {
      if (existingIds.has(legacy.id)) continue;
      await dbPutStore(legacy.id, legacy.data, { source: "legacy-indexeddb-import", dirty: true, bootstrapOnly: false });
      await saveLocalBackup(legacy.id, legacy.data, "稳定版升级前旧IndexedDB快照", { sourceDb: LEGACY_DB_NAME });
      startupReport.imported.push(legacy.id);
      startupReport.backedUp.push(legacy.id);
      existingIds.add(legacy.id);
    }

    const activeId = nativeSelectedStore();
    const nativeRaw = nativeGetItem.call(localStorage, MAIN_KEY);
    const nativeData = parse(nativeRaw);
    if (STORE_IDS.includes(activeId) && validateStoreData(nativeData).ok) {
      const existing = await dbGetStore(activeId);
      if (!existing || !sameData(existing.data, nativeData)) {
        if (existing?.data) await saveLocalBackup(activeId, existing.data, "稳定版升级前已有V2快照");
        await dbPutStore(activeId, nativeData, { source: "legacy-localstorage-import", dirty: true, bootstrapOnly: false });
        await saveLocalBackup(activeId, nativeData, "稳定版升级前localStorage快照");
        if (!startupReport.imported.includes(activeId)) startupReport.imported.push(activeId);
        if (!startupReport.backedUp.includes(activeId)) startupReport.backedUp.push(activeId);
      }
    }

    nativeRemoveItem.call(localStorage, MAIN_KEY);
  }

  async function prepare() {
    dbRef = await openDb();
    await importExistingLocalData();

    let selected = nativeSelectedStore();
    let row = await dbGetStore(selected);
    if (!row) {
      const rows = (await dbGetAllStores()).filter(item => STORE_IDS.includes(item.id) && validateStoreData(item.data).ok);
      if (rows.length) {
        row = rows[0];
        selected = row.id;
      }
    }

    if (!row) {
      const builtIn = clone(window.PLANOGRAM_INITIAL_DATA || {});
      assertStoreData(builtIn, "内置和县底表");
      selected = STORE_IDS[0];
      row = await dbPutStore(selected, builtIn, { source: "builtin-bootstrap", dirty: false, bootstrapOnly: true });
    }

    const rows = await dbGetAllStores();
    startupReport.missing = STORE_IDS.filter(id => !rows.some(rowItem => rowItem.id === id && validateStoreData(rowItem.data).ok));
    startupReport.source = row.source || "local";

    setMemoryStore(selected, row.data);
    installVirtualStorage();
    window.PLANOGRAM_INITIAL_DATA = clone(row.data);
    window.PLANOGRAM_STORE_CONTEXT = {
      storeId: selected,
      storeName: STORE_NAMES[selected],
      isOriginalStore: selected === STORE_IDS[0],
      missingLocalStoreIds: startupReport.missing.slice(),
      stableVersion: VERSION,
      config: { name: STORE_NAMES[selected], meta: row.data.storeMeta || {} }
    };
    await dbPutMeta("lastStartup", { at: nowIso(), selected, report: startupReport });
    return { db: dbRef, selected, row, report: startupReport };
  }

  window.PLANOGRAM_STORE_READY = prepare();

  async function currentRow() {
    await writeQueue;
    const row = await dbGetStore(selectedStoreId);
    if (!row) throw new Error(`本机缺少“${STORE_NAMES[selectedStoreId]}”数据`);
    assertStoreData(row.data, `本地“${STORE_NAMES[selectedStoreId]}”`);
    return row;
  }

  async function switchStore(nextId) {
    if (!STORE_IDS.includes(nextId)) return;
    await writeQueue;
    let row = await dbGetStore(nextId);
    if (!row) {
      const session = await optionalSession();
      if (session) {
        showStatus(`本机没有“${STORE_NAMES[nextId]}”，正在从云端自动下载…`);
        const remote = await readCloudStore(nextId);
        row = await applyRemoteStore(nextId, remote, "switch-missing-auto-pull");
      } else {
        openCloudDialogWithNote(`本机没有“${STORE_NAMES[nextId]}”数据。登录后再次切换，系统会自动下载。`);
        throw new Error(`请先登录云端，再打开“${STORE_NAMES[nextId]}”`);
      }
    }
    setMemoryStore(nextId, row.data);
    location.reload();
  }

  async function collectAllStores() {
    await writeQueue;
    const rows = await dbGetAllStores();
    const stores = {};
    for (const id of STORE_IDS) {
      const row = rows.find(item => item.id === id);
      if (row?.data && validateStoreData(row.data).ok) stores[id] = row.data;
    }
    return stores;
  }

  async function downloadAll() {
    const stores = await collectAllStores();
    downloadJson(`八家门店稳定版完整备份_${timestamp()}.json`, {
      type: "planogram-stable-v2-all-store-backup",
      version: VERSION,
      createdAt: nowIso(),
      storeCount: Object.keys(stores).length,
      stores
    });
  }

  function cloudClient() {
    return window.PLANOGRAM_CLOUD_CLIENT || null;
  }

  async function optionalSession() {
    const client = cloudClient();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    return data?.session || null;
  }

  async function requireSession() {
    const session = await optionalSession();
    if (!session?.user) throw new Error("请先登录云端协作账号");
    return session;
  }

  function showStatus(message, isError = false) {
    const status = document.getElementById("statusBar");
    if (status) {
      status.textContent = message;
      status.classList.toggle("error", isError);
    }
    const cloudStatus = document.getElementById("cloudSyncStatus");
    if (cloudStatus) {
      cloudStatus.textContent = message;
      cloudStatus.classList.toggle("error", isError);
    }
  }

  function openCloudDialogWithNote(message) {
    const dialog = document.getElementById("cloudDialog");
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    showStatus(message, true);
  }

  function isMissingStableSchema(error) {
    const text = `${error?.code || ""} ${error?.message || ""} ${error?.details || ""}`.toLowerCase();
    return text.includes("planogram_store_documents") || text.includes("does not exist") || text.includes("42p01") || text.includes("pgrst202");
  }

  async function readMigrationFlag() {
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_system_flags")
      .select("flag_value,updated_at")
      .eq("flag_key", MIGRATION_FLAG)
      .maybeSingle();
    if (error) {
      if (isMissingStableSchema(error)) return null;
      throw error;
    }
    return data?.flag_value || null;
  }

  async function runOwnerMigration() {
    const session = await requireSession();
    const email = String(session.user.email || "").toLowerCase();
    if (email !== "pengyuyan8910@gmail.com") throw new Error("只有项目所有者账号可以执行首次无损迁移");
    showStatus("正在把旧main最新数据无损复制为8家独立门店记录…");
    const client = cloudClient();
    const { data, error } = await client.rpc("migrate_planogram_main_to_store_documents");
    if (error) {
      if (isMissingStableSchema(error)) throw new Error("请先在Supabase SQL Editor执行包内“01_无损升级到单店独立存储.sql”");
      throw error;
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length !== 8) throw new Error(`迁移返回${rows.length}家，不是8家，已停止后续操作`);
    await dbPutMeta("serverMigration", { at: nowIso(), rows });
    showStatus("无损迁移完成：旧main已保留并冻结，8家门店已拆分为独立云端记录。现在点击“拉取云端数据”完成本机校准。");
    return rows;
  }

  async function readCloudStore(id) {
    await requireSession();
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_store_documents")
      .select("store_id,store_name,payload,revision,updated_at,updated_by_email")
      .eq("store_id", id)
      .maybeSingle();
    if (error) {
      if (isMissingStableSchema(error)) throw new Error("稳定数据库尚未启用。请先执行无损升级SQL，再由所有者点击“执行首次无损迁移”");
      throw error;
    }
    if (!data) throw new Error(`云端缺少“${STORE_NAMES[id]}”独立记录`);
    assertStoreData(data.payload, `云端“${STORE_NAMES[id]}”`);
    return {
      id,
      name: data.store_name || STORE_NAMES[id],
      data: data.payload,
      revision: Number(data.revision) || 0,
      updatedAt: data.updated_at || null,
      updatedByEmail: data.updated_by_email || null,
      hash: dataHash(data.payload)
    };
  }

  async function readAllCloudStores() {
    await requireSession();
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_store_documents")
      .select("store_id,store_name,payload,revision,updated_at,updated_by_email")
      .in("store_id", STORE_IDS);
    if (error) {
      if (isMissingStableSchema(error)) throw new Error("稳定数据库尚未启用。请先执行无损升级SQL，再由所有者点击“执行首次无损迁移”");
      throw error;
    }
    const rows = Array.isArray(data) ? data : [];
    const map = new Map(rows.map(row => [row.store_id, row]));
    const missing = STORE_IDS.filter(id => !map.has(id));
    if (missing.length) throw new Error(`稳定云端缺少${missing.length}家：${missing.map(id => STORE_NAMES[id]).join("、")}`);
    return STORE_IDS.map(id => {
      const row = map.get(id);
      assertStoreData(row.payload, `云端“${STORE_NAMES[id]}”`);
      return {
        id,
        name: row.store_name || STORE_NAMES[id],
        data: row.payload,
        revision: Number(row.revision) || 0,
        updatedAt: row.updated_at || null,
        updatedByEmail: row.updated_by_email || null,
        hash: dataHash(row.payload)
      };
    });
  }

  async function applyRemoteStore(id, remote, reason) {
    const existing = await dbGetStore(id);
    if (existing?.data && !sameData(existing.data, remote.data)) {
      await saveLocalBackup(id, existing.data, `云端覆盖前自动备份：${reason}`, {
        cloudRevision: existing.cloudRevision,
        remoteRevision: remote.revision
      });
    }
    return dbPutStore(id, remote.data, {
      cloudRevision: remote.revision,
      cloudHash: remote.hash,
      cloudBaseData: remote.data,
      cloudUpdatedAt: remote.updatedAt,
      source: reason,
      bootstrapOnly: false,
      dirty: false
    });
  }

  async function initializeMissingStoresFromCloud() {
    const remotes = await readAllCloudStores();
    const filled = [];
    const preserved = [];
    for (const remote of remotes) {
      const local = await dbGetStore(remote.id);
      if (!local || local.bootstrapOnly) {
        await applyRemoteStore(remote.id, remote, "new-device-cloud-initialization");
        filled.push(remote.id);
      } else if (sameData(local.data, remote.data)) {
        await dbPutStore(remote.id, local.data, {
          cloudRevision: remote.revision,
          cloudHash: remote.hash,
          cloudUpdatedAt: remote.updatedAt,
          source: local.source || "local",
          bootstrapOnly: false,
          dirty: false
        });
      } else {
        preserved.push(remote.id);
      }
    }
    return { remotes, filled, preserved };
  }

  async function pullCloudData() {
    await requireSession();
    const localRows = await dbGetAllStores();
    const validLocalIds = new Set(localRows.filter(row => validateStoreData(row.data).ok && !row.bootstrapOnly).map(row => row.id));
    const missing = STORE_IDS.filter(id => !validLocalIds.has(id));

    if (missing.length) {
      showStatus(`检测到本机缺少${missing.length}家门店，正在从稳定云端补齐；已有本地门店不会被覆盖…`);
      const result = await initializeMissingStoresFromCloud();
      const current = await dbGetStore(selectedStoreId);
      if (current?.bootstrapOnly) {
        const remote = result.remotes.find(item => item.id === selectedStoreId);
        if (remote) await applyRemoteStore(selectedStoreId, remote, "bootstrap-current-replace");
      }
      const conflictText = result.preserved.length
        ? `；${result.preserved.length}家本地与云端不同，已保留本地未覆盖：${result.preserved.map(id => STORE_NAMES[id]).join("、")}`
        : "";
      showStatus(`初始化完成：补齐${result.filled.length}家门店${conflictText}。正在刷新。`, result.preserved.length > 0);
      const row = await dbGetStore(selectedStoreId);
      if (row) setMemoryStore(selectedStoreId, row.data);
      location.reload();
      return;
    }

    const remote = await readCloudStore(selectedStoreId);
    const local = await currentRow();
    if (sameData(local.data, remote.data)) {
      await dbPutStore(selectedStoreId, local.data, {
        cloudRevision: remote.revision,
        cloudHash: remote.hash,
        cloudBaseData: remote.data,
        cloudUpdatedAt: remote.updatedAt,
        source: local.source || "local",
        bootstrapOnly: false,
        dirty: false
      });
      showStatus(`“${STORE_NAMES[selectedStoreId]}”已是云端最新第${remote.revision}版，无需覆盖。`);
      return;
    }

    await saveLocalBackup(selectedStoreId, local.data, "拉取云端前自动备份", {
      localCloudRevision: local.cloudRevision,
      remoteRevision: remote.revision
    });
    const localSummary = `${local.data.products.length}个商品、${local.data.groups.length}组、${countPits(local.data)}个坑位`;
    const remoteSummary = `${remote.data.products.length}个商品、${remote.data.groups.length}组、${countPits(remote.data)}个坑位`;
    const confirmed = window.confirm(
      `“${STORE_NAMES[selectedStoreId]}”本地与云端第${remote.revision}版不同。\n\n本地：${localSummary}\n云端：${remoteSummary}\n\n系统已在浏览器历史区保存本地快照。确定用云端覆盖当前门店吗？其他7家不会改动。`
    );
    if (!confirmed) {
      showStatus(`已取消拉取，“${STORE_NAMES[selectedStoreId]}”本地数据保持不变。`, true);
      return;
    }
    const row = await applyRemoteStore(selectedStoreId, remote, "manual-cloud-pull");
    setMemoryStore(selectedStoreId, row.data);
    showStatus(`“${STORE_NAMES[selectedStoreId]}”已更新到云端第${remote.revision}版，正在刷新。`);
    location.reload();
  }

  function summarizeConflictValue(value) {
    if (value === undefined) return "（删除）";
    if (value === null) return "null";
    if (isRecord(value) && value.groupId && value.layer) {
      return `${value.groupId}-${value.layer}层｜${value.pit?.productId || value.id || "坑位"}`;
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  }

  function resolveMergeConflicts(conflicts) {
    return new Promise(resolve => {
      document.getElementById("stableConflictDialog")?.remove();
      const dialog = document.createElement("dialog");
      dialog.id = "stableConflictDialog";
      dialog.className = "editor-dialog admin-dialog stable-conflict-dialog";
      dialog.innerHTML = `
        <div class="dialog-header"><div><p class="eyebrow">多人修改冲突</p><h2>${escapeHtml(STORE_NAMES[selectedStoreId])}｜${conflicts.length}处需要选择</h2></div><button class="icon-btn stable-conflict-cancel" type="button">×</button></div>
        <p class="admin-summary">不同SKU或不同字段已经自动合并。下面仅显示双方同时修改了同一字段或同一坑位的位置。默认保留本地，可逐项改为采用云端。</p>
        <div class="stable-conflict-list">${conflicts.map((item, index) => `
          <div class="stable-conflict-row">
            <div class="stable-conflict-path"><b>${index + 1}. ${escapeHtml(item.path)}</b><small>${escapeHtml(item.kind)}</small></div>
            <div class="stable-conflict-values"><span><b>本地</b>${escapeHtml(summarizeConflictValue(item.local))}</span><span><b>云端</b>${escapeHtml(summarizeConflictValue(item.remote))}</span></div>
            <select data-conflict-key="${escapeHtml(item.key)}"><option value="local" selected>保留本地</option><option value="remote">采用云端</option></select>
          </div>`).join("")}</div>
        <div class="dialog-actions"><button class="btn stable-conflict-cancel" type="button">取消，返回继续编辑</button><button id="stableResolveAllRemote" class="btn" type="button">全部采用云端</button><button id="stableResolveConfirm" class="btn btn-primary" type="button">按以上选择合并并保存</button></div>`;
      document.body.appendChild(dialog);
      const close = () => { dialog.close(); dialog.remove(); resolve(null); };
      dialog.querySelectorAll(".stable-conflict-cancel").forEach(node => node.addEventListener("click", close));
      dialog.querySelector("#stableResolveAllRemote")?.addEventListener("click", () => {
        dialog.querySelectorAll("select[data-conflict-key]").forEach(select => { select.value = "remote"; });
      });
      dialog.querySelector("#stableResolveConfirm")?.addEventListener("click", () => {
        const resolutions = {};
        dialog.querySelectorAll("select[data-conflict-key]").forEach(select => { resolutions[select.dataset.conflictKey] = select.value; });
        dialog.close(); dialog.remove(); resolve(resolutions);
      });
      dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
      dialog.showModal();
    });
  }

  async function saveCloudData() {
    const session = await requireSession();
    const local = await currentRow();
    assertStoreData(local.data, `准备保存的“${STORE_NAMES[selectedStoreId]}”`, { strictCapacity: true });
    const remote = await readCloudStore(selectedStoreId);

    if (sameData(local.data, remote.data)) {
      await dbPutStore(selectedStoreId, local.data, {
        cloudRevision: remote.revision,
        cloudHash: remote.hash,
        cloudBaseData: remote.data,
        cloudUpdatedAt: remote.updatedAt,
        source: local.source || "local",
        bootstrapOnly: false,
        dirty: false
      });
      showStatus(`“${STORE_NAMES[selectedStoreId]}”没有新修改；云端当前为第${remote.revision}版。`);
      return;
    }

    let payloadToSave = clone(local.data);
    let expectedRevision = remote.revision;
    let mergeMessage = "";
    const remoteChangedSinceBase = local.cloudRevision && (
      Number(local.cloudRevision) !== Number(remote.revision) ||
      (local.cloudHash && local.cloudHash !== remote.hash)
    );

    if (!local.cloudRevision || !validateStoreData(local.cloudBaseData).ok) {
      await saveLocalBackup(selectedStoreId, local.data, "首次稳定版保存前本地快照", { remoteRevision: remote.revision });
      const confirmed = window.confirm(
        `“${STORE_NAMES[selectedStoreId]}”尚未建立可用于三方合并的云端基线，本地与云端第${remote.revision}版不同。\n\n已保留本地快照。确定以当前本地数据生成新的云端版本吗？`
      );
      if (!confirmed) {
        showStatus("已取消保存，本地和云端均未改动。建议先拉取云端建立基线。", true);
        return;
      }
    } else if (remoteChangedSinceBase) {
      showStatus(`检测到云端已更新到第${remote.revision}版，正在按“基线＋本地＋云端”执行三方合并…`);
      let merged = mergeStoreData(local.cloudBaseData, local.data, remote.data, {});
      if (merged.conflicts.length) {
        const resolutions = await resolveMergeConflicts(merged.conflicts);
        if (!resolutions) {
          showStatus(`已取消冲突处理，本地修改仍完整保留，云端未写入。`, true);
          return;
        }
        merged = mergeStoreData(local.cloudBaseData, local.data, remote.data, resolutions);
        if (merged.conflicts.length) throw new Error(`仍有${merged.conflicts.length}处冲突未解决，已停止保存`);
        mergeMessage = `已按选择解决冲突并合并云端第${remote.revision}版`;
      } else {
        mergeMessage = `已自动合并云端第${remote.revision}版中的非重叠修改`;
      }
      payloadToSave = merged.data;
      assertStoreData(payloadToSave, `三方合并后的“${STORE_NAMES[selectedStoreId]}”`, { strictCapacity: true });
      if (sameData(payloadToSave, remote.data)) {
        const row = await applyRemoteStore(selectedStoreId, remote, "three-way-merge-result-equals-remote");
        setMemoryStore(selectedStoreId, row.data);
        showStatus(`${mergeMessage}；合并结果与云端一致，无需新增版本，正在刷新。`);
        location.reload();
        return;
      }
    }

    await saveLocalBackup(selectedStoreId, local.data, "保存云端前浏览器历史快照", {
      expectedRevision,
      user: session.user.email || session.user.id,
      mergeSourceRevision: remote.revision
    });
    if (!sameData(payloadToSave, local.data)) {
      await dbPutStore(selectedStoreId, payloadToSave, {
        cloudRevision: remote.revision,
        cloudHash: remote.hash,
        cloudBaseData: remote.data,
        cloudUpdatedAt: remote.updatedAt,
        source: "three-way-merged-pending-save",
        bootstrapOnly: false,
        dirty: true
      });
    }
    showStatus(`正在只上传“${STORE_NAMES[selectedStoreId]}”到云端；其他7家不会传输或改动…`);
    const client = cloudClient();
    const { data, error } = await client.rpc("save_planogram_store", {
      p_store_id: selectedStoreId,
      p_payload: payloadToSave,
      p_expected_revision: expectedRevision
    });
    if (error) {
      if (String(error.code || "").toUpperCase() === "40001" || String(error.message || "").includes("版本冲突")) {
        throw new Error("保存期间云端又产生了新版本。已阻止覆盖；本地及已合并的数据仍保存在浏览器中，请再次点击保存重新合并。 ");
      }
      throw error;
    }
    const result = Array.isArray(data) ? data[0] : data;
    const revision = Number(result?.revision) || expectedRevision + 1;
    const hash = dataHash(payloadToSave);
    await dbPutStore(selectedStoreId, payloadToSave, {
      cloudRevision: revision,
      cloudHash: hash,
      cloudBaseData: payloadToSave,
      cloudUpdatedAt: result?.updated_at || nowIso(),
      source: "stable-cloud-save",
      bootstrapOnly: false,
      dirty: false
    });
    if (!sameData(payloadToSave, local.data)) setMemoryStore(selectedStoreId, payloadToSave);
    showStatus(`“${STORE_NAMES[selectedStoreId]}”已保存为独立云端第${revision}版；其他7家未传输、未改动。${mergeMessage ? `${mergeMessage}；` : ""}服务器历史版本已自动保留。`);
    if (!sameData(payloadToSave, local.data)) location.reload();
  }

  async function listHistory() {
    await requireSession();
    const client = cloudClient();
    const { data, error } = await client
      .from("planogram_store_history")
      .select("revision,saved_at,saved_by_email,source,source_revision")
      .eq("store_id", selectedStoreId)
      .order("revision", { ascending: false })
      .limit(20);
    if (error) throw error;
    return Array.isArray(data) ? data : [];
  }

  async function renderHistory() {
    const box = document.getElementById("stableHistoryList");
    if (!box) return;
    box.textContent = "正在读取历史版本…";
    const rows = await listHistory();
    if (!rows.length) {
      box.textContent = "当前门店暂无历史版本。";
      return;
    }
    box.innerHTML = rows.map((row, index) => {
      const source = row.source === "restore" ? `恢复自第${row.source_revision}版` : row.source === "legacy-main-migration" ? "旧main迁移快照" : "正常保存";
      const time = row.saved_at ? new Date(row.saved_at).toLocaleString("zh-CN") : "";
      return `<div class="stable-history-row" data-revision="${row.revision}"><div><b>第${row.revision}版</b> · ${source}<br><small>${time}${row.saved_by_email ? ` · ${escapeHtml(row.saved_by_email)}` : ""}</small></div>${index === 0 ? "<span>当前/最新</span>" : `<button class="btn stable-restore-btn" type="button" data-revision="${row.revision}">恢复此版本</button>`}</div>`;
    }).join("");
    box.querySelectorAll(".stable-restore-btn").forEach(button => button.addEventListener("click", () => restoreHistoryVersion(Number(button.dataset.revision))));
  }

  async function restoreHistoryVersion(targetRevision) {
    await requireSession();
    const remote = await readCloudStore(selectedStoreId);
    const confirmed = window.confirm(
      `确定把“${STORE_NAMES[selectedStoreId]}”恢复为历史第${targetRevision}版吗？\n\n系统不会删除现有版本，而是生成新的第${remote.revision + 1}版。`
    );
    if (!confirmed) return;
    const local = await currentRow();
    await saveLocalBackup(selectedStoreId, local.data, `恢复服务器第${targetRevision}版前本地快照`, { remoteRevision: remote.revision });
    const client = cloudClient();
    const { data, error } = await client.rpc("restore_planogram_store_version", {
      p_store_id: selectedStoreId,
      p_target_revision: targetRevision,
      p_expected_revision: remote.revision
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    const latest = await readCloudStore(selectedStoreId);
    const row = await applyRemoteStore(selectedStoreId, latest, `server-history-restore-${targetRevision}`);
    setMemoryStore(selectedStoreId, row.data);
    showStatus(`已从历史第${targetRevision}版恢复并生成云端第${result?.revision || latest.revision}版，正在刷新。`);
    location.reload();
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
    return { capacity: Math.max(0, exportInteger(source.capacity, 0)), pits: Array.isArray(source.pits) ? source.pits : [] };
  }
  function buildPlacedOnlyExportRows(data) {
    const productsById = new Map((data.products || []).map(product => [product.id, product]));
    const placedProductIds = new Set();
    (data.groups || []).forEach(group => ["D", "C", "B", "A"].forEach(layer => {
      exportLayer(group, layer).pits.forEach(pit => {
        const product = productsById.get(pit.productId);
        if (product && product.status !== "eliminated") placedProductIds.add(product.id);
      });
    }));
    const products = (data.products || []).filter(product => placedProductIds.has(product.id) && product.status !== "eliminated").map(product => ({
      "一级品类": product.category || "", "二级品类": product.secondCategory || "", "三级品类": product.thirdCategory || "", "四级品类": product.fourthCategory || "",
      "SKU编码": product.barcode || "", "SKU名称": product.name || "", "等级": product.grade || "", "新品状态": product.newFlag || "",
      "长(mm)": exportInteger(product.faceWidth, 0), "宽(mm)": exportInteger(product.depth, 0), "高(mm)": exportInteger(product.height, 0),
      "箱规(件/箱)": exportInteger(product.packSize, 0), "满陈箱数": exportInteger(product.shelfBoxes, 0), "周转天数": exportNumber(product.turnoverDays, 0),
      "基础坑位": exportInteger(product.basePits, 0), "计划坑位": exportInteger(product.plannedPits, 0), "状态": "陈列中"
    }));
    const layerRows = (data.groups || []).flatMap(group => ["D", "C", "B", "A"].map(layer => {
      const layerData = exportLayer(group, layer);
      const visiblePits = layerData.pits.filter(pit => placedProductIds.has(pit.productId));
      const used = visiblePits.reduce((sum, pit) => sum + Math.max(0, exportInteger(productsById.get(pit.productId)?.faceWidth, 0)), 0);
      return { "一级品类": group.category || "", "二级品类": group.secondCategory || "", "货架组": group.id || "", "货架类型": group.type || "", "层级": layer, "容量(mm)": layerData.capacity, "已用(mm)": used, "余量(mm)": layerData.capacity - used, "坑位数": visiblePits.length };
    }));
    const placements = (data.groups || []).flatMap(group => ["D", "C", "B", "A"].flatMap(layer => {
      let order = 0;
      return exportLayer(group, layer).pits.flatMap(pit => {
        const product = productsById.get(pit.productId);
        if (!product || !placedProductIds.has(product.id) || product.status === "eliminated") return [];
        order += 1;
        return [{ "货架组": group.id || "", "层级": layer, "顺序": order, "坑位ID": pit.id || "", "SKU编码": product.barcode || pit.barcode || "", "SKU名称": product.name || "", "坑位类型": pit.kind === "expansion" ? "扩陈" : "基础" }];
      });
    }));
    return { products, layerRows, placements };
  }

  function safeExportFileName(value) {
    return String(value || "当前云端陈列底表").replace(/[\\/:*?"<>|]/g, "_");
  }

  async function exportCurrentCloudExcel() {
    const remote = await readCloudStore(selectedStoreId);
    if (!window.XLSX) throw new Error("Excel导出组件未加载，请联网刷新页面后重试");
    const rows = buildPlacedOnlyExportRows(remote.data);
    if (!rows.products.length || !rows.placements.length) throw new Error("当前门店云端数据中没有陈列中的SKU可导出");
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.products), "SKU底表");
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.layerRows), "货架层");
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(rows.placements), "陈列坑位");
    window.XLSX.writeFile(workbook, safeExportFileName(`${STORE_NAMES[selectedStoreId]}_云端第${remote.revision}版_陈列中SKU_${new Date().toISOString().slice(0, 10)}.xlsx`));
    showStatus(`已导出“${STORE_NAMES[selectedStoreId]}”独立云端第${remote.revision}版Excel：${rows.products.length}个SKU、${rows.placements.length}个坑位。`);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function interceptButton(id, handler) {
    const node = document.getElementById(id);
    if (!node || node.dataset.stableBound === "1") return;
    node.dataset.stableBound = "1";
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      node.disabled = true;
      Promise.resolve(handler(event)).catch(error => {
        console.error(error);
        showStatus(error?.message || "操作失败", true);
      }).finally(() => { node.disabled = false; });
    }, true);
  }

  function installCloudControls() {
    const pull = document.getElementById("cloudPullBtn");
    const push = document.getElementById("cloudPushBtn");
    if (pull) {
      pull.disabled = false;
      pull.textContent = "拉取云端数据";
      pull.title = "新设备自动补齐8家；已有设备只拉取当前门店；覆盖前保留浏览器历史快照";
    }
    if (push) {
      push.disabled = false;
      push.textContent = "保存至云端";
      push.title = "只上传当前门店，服务器自动保留历史版本";
    }
    const helper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (helper) helper.textContent = "每家门店独立存储。拉取只更新当前门店（新设备会自动补齐缺失门店）；保存只上传当前门店，并自动生成服务器历史版本。";
    const title = document.querySelector("#cloudDialog .dialog-header h2");
    if (title) title.textContent = `${STORE_NAMES[selectedStoreId]}｜稳定云端协作`;

    let actions = pull?.closest(".dialog-actions");
    if (actions && !document.getElementById("stableMigrationBtn")) {
      const migrate = document.createElement("button");
      migrate.id = "stableMigrationBtn";
      migrate.className = "btn";
      migrate.type = "button";
      migrate.textContent = "执行首次无损迁移";
      migrate.title = "仅项目所有者首次升级时使用；不会删除旧main";
      actions.insertBefore(migrate, pull || actions.firstChild);
    }
    if (actions && !document.getElementById("stableHistoryBtn")) {
      const history = document.createElement("button");
      history.id = "stableHistoryBtn";
      history.className = "btn";
      history.type = "button";
      history.textContent = "历史版本";
      actions.appendChild(history);
    }
    const section = pull?.closest(".admin-section");
    if (section && !document.getElementById("stableHistoryList")) {
      const list = document.createElement("div");
      list.id = "stableHistoryList";
      list.className = "stable-history-list";
      list.hidden = true;
      section.appendChild(list);
    }

    const exportCloud = document.getElementById("exportCloudExcelBtn");
    if (exportCloud) {
      exportCloud.disabled = false;
      exportCloud.textContent = "导出当前云端 Excel";
      exportCloud.title = "直接读取当前门店独立云端记录导出，不覆盖本地";
    }
    const reset = document.getElementById("confirmResetBtn");
    if (reset) {
      reset.disabled = true;
      reset.title = "稳定版禁止一键恢复底表，避免覆盖人工修改";
    }

    interceptButton("cloudPullBtn", pullCloudData);
    interceptButton("cloudPushBtn", saveCloudData);
    interceptButton("exportCloudExcelBtn", exportCurrentCloudExcel);
    interceptButton("stableMigrationBtn", runOwnerMigration);
    interceptButton("stableHistoryBtn", async () => {
      const list = document.getElementById("stableHistoryList");
      if (!list) return;
      list.hidden = !list.hidden;
      if (!list.hidden) await renderHistory();
    });
  }

  async function installUi() {
    await window.PLANOGRAM_STORE_READY;
    const context = window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot = document.querySelector(".topbar > div:first-child");
    const eyebrow = titleRoot?.querySelector(".eyebrow");
    if (eyebrow) eyebrow.textContent = context.storeName;

    const previousSwitcher = document.querySelector(".store-switcher");
    if (previousSwitcher) previousSwitcher.remove();
    const holder = document.createElement("div");
    holder.className = "store-switcher";
    holder.innerHTML = `<label for="storeSelect">门店</label><select id="storeSelect">${STORE_IDS.map(id => `<option value="${id}" ${id === context.storeId ? "selected" : ""}>${STORE_NAMES[id]}</option>`).join("")}</select><button id="downloadStableAllBtn" class="btn" type="button">备份全部8家门店</button>`;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change", event => {
      const select = event.target;
      const oldValue = context.storeId;
      select.disabled = true;
      switchStore(select.value).catch(error => {
        select.value = oldValue;
        select.disabled = false;
        alert(error.message);
      });
    });
    holder.querySelector("#downloadStableAllBtn")?.addEventListener("click", () => downloadAll().catch(error => alert(error.message)));

    installCloudControls();
    const schemaFlag = await optionalSession().then(session => session ? readMigrationFlag().catch(() => null) : null);
    if (schemaFlag?.enabled) {
      showStatus(`稳定数据架构已启用：当前为“${context.storeName}”。本地使用IndexedDB缓存，云端每店独立保存并保留历史版本。`);
    } else if (startupReport.missing.length) {
      showStatus(`已保护现有本地数据；本机仍缺少${startupReport.missing.length}家门店。登录后点击“拉取云端数据”会自动补齐，已有本地数据不会被静默覆盖。`);
    } else {
      showStatus(`现有8家本地数据已迁入稳定缓存并保留升级前快照。完成Supabase无损升级后即可使用每店独立云端保存。`);
    }
  }

  window.addEventListener("planogram:app-ready", installUi, { once: true });
  window.PLANOGRAM_STABLE_DEBUG = {
    version: VERSION,
    storeIds: STORE_IDS.slice(),
    validateStoreData,
    mergeStoreData,
    collectAllStores,
    readCloudStore,
    readAllCloudStores,
    pullCloudData,
    saveCloudData,
    runOwnerMigration,
    listHistory,
    switchStore,
    getStartupReport: () => clone(startupReport),
    getCurrentRow: currentRow,
    getLocalBackups: async storeId => txRequest(dbRef.transaction(BACKUP_TABLE, "readonly").objectStore(BACKUP_TABLE).index("storeId").getAll(storeId), "读取备份失败")
  };
})();
