(() => {
  "use strict";

  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const STORE_PREFIX = "planogram-store-state-v1::";
  const ORIGINAL_STORE_ID = "hexian-xiaoshikou";
  const CLOUD_DOCUMENT_ID = "main";
  const CLOUD_WRAPPER_TYPE = "planogram-multistore-cloud";
  const CLOUD_SCHEMA_VERSION = 1;
  const CLOUD_SESSION_PREFIX = "planogram-cloud-session-v2::";
  const CLOUD_PULL_FLAG_PREFIX = "planogram-cloud-pulled-v2::";
  const CLOUD_EXPORT_FLAG = "planogram-cloud-export-v2";
  const CLOUD_BASE_KEY = "planogram-cloud-base-v2";
  const originalData = JSON.parse(JSON.stringify(window.PLANOGRAM_INITIAL_DATA || { categories: [], products: [], groups: [] }));
  const allocationRoot = window.PLANOGRAM_STORE_ALLOCATIONS || { stores: {} };
  const storeConfigs = allocationRoot.stores || {};
  const CONTINUOUS_LAYOUT_VERSION = allocationRoot.version || "1";
  const LAYERS = ["A", "B", "C", "D"];
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;

  const nativeSupabaseCreateClient = window.supabase?.createClient?.bind(window.supabase);
  if (nativeSupabaseCreateClient) {
    window.supabase.createClient = (...args) => {
      const client = nativeSupabaseCreateClient(...args);
      window.PLANOGRAM_CLOUD_CLIENT = client;
      return client;
    };
  }

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
      layoutVersion: config.layoutVersion || CONTINUOUS_LAYOUT_VERSION,
      layoutMode: config.layoutMode || "continuous-shelf-bands",
      categories,
      products,
      groups,
      storeMeta: clone(config.meta || {}),
      generatedAt: allocationRoot.generatedAt || ""
    };
  }


  function sameJson(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  function migrateStoreLayout(storeId, inputData) {
    if (!validData(inputData) || storeId === ORIGINAL_STORE_ID || !storeConfigs[storeId]) {
      return validData(inputData) ? clone(inputData) : inputData;
    }

    const target = buildStoreInitial(storeId);
    const targetVersion = target.layoutVersion || CONTINUOUS_LAYOUT_VERSION;
    const targetGroups = target.groups || [];
    const inputGroups = inputData.groups || [];
    const targetIds = targetGroups.map(group => group.id);
    const inputIds = inputGroups.map(group => group.id);
    const alreadyContinuous =
      inputData.layoutVersion === targetVersion &&
      sameJson(targetIds, inputIds) &&
      targetGroups.every((group, index) =>
        sameJson(group.sourceGroupIds || [group.id], inputGroups[index]?.sourceGroupIds || [inputGroups[index]?.id])
      );

    if (alreadyContinuous) return clone(inputData);

    const currentById = new Map(inputGroups.map(group => [group.id, group]));
    const migratedGroups = targetGroups.map(template => {
      const targetGroup = clone(template);
      const sourceIds = targetGroup.sourceGroupIds || [targetGroup.id];
      const existingBand = currentById.get(targetGroup.id);
      const useExistingBand =
        existingBand &&
        (Array.isArray(existingBand.sourceGroupIds) || sourceIds.length === 1 || !sourceIds.some(id => currentById.has(id)));
      const sourceGroups = useExistingBand
        ? [existingBand]
        : sourceIds.map(id => currentById.get(id)).filter(Boolean);

      LAYERS.forEach(layer => {
        const targetLayer = targetGroup.layers?.[layer] || { capacity: 1200, pits: [] };
        const collected = [];
        if (sourceGroups.length) {
          sourceGroups.forEach(sourceGroup => {
            const sourceLayer = sourceGroup.layers?.[layer] || { pits: [] };
            (sourceLayer.pits || []).forEach((pit, index) => {
              collected.push({
                ...clone(pit),
                sourceGroupId: pit.sourceGroupId || (
                  sourceGroups.length === 1 && Array.isArray(sourceGroup.sourceGroupIds)
                    ? pit.sourceGroupId || ""
                    : sourceGroup.id
                ),
                sourcePitOrder: pit.sourcePitOrder || index + 1
              });
            });
          });
        }
        targetGroup.layers[layer] = {
          ...targetLayer,
          pits: sourceGroups.length ? collected : clone(targetLayer.pits || [])
        };
      });
      return targetGroup;
    });

    const migrated = {
      ...clone(inputData),
      version: target.version,
      source: target.source,
      storeId,
      storeName: target.storeName,
      layoutVersion: targetVersion,
      layoutMode: target.layoutMode,
      categories: clone(inputData.categories || target.categories || []),
      products: clone(inputData.products || target.products || []),
      groups: migratedGroups,
      storeMeta: {
        ...clone(inputData.storeMeta || {}),
        ...clone(target.storeMeta || {}),
        migratedToContinuousBandsAt: new Date().toISOString()
      },
      generatedAt: target.generatedAt
    };
    return migrated;
  }

  function migrateAndPersistStore(storeId, data) {
    const migrated = migrateStoreLayout(storeId, data);
    if (validData(migrated) && !sameJson(migrated, data)) {
      writeRaw(storeKey(storeId), JSON.stringify(migrated));
    }
    return migrated;
  }

  function writeRaw(key, value) {
    nativeSetItem.call(window.localStorage, key, value);
  }

  function saveMainToStore(storeId) {
    const current = parseJson(window.localStorage.getItem(MAIN_KEY));
    if (!validData(current)) return;
    const migrated = migrateStoreLayout(storeId, current);
    writeRaw(storeKey(storeId), JSON.stringify(migrated));
  }

  function loadStoreState(storeId) {
    const saved = parseJson(window.localStorage.getItem(storeKey(storeId)));
    const source = validData(saved) ? saved : buildStoreInitial(storeId);
    return migrateAndPersistStore(storeId, source);
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
    } else {
      const migratedCurrent = migrateStoreLayout(selected, currentMain);
      if (!sameJson(migratedCurrent, currentMain)) {
        writeRaw(MAIN_KEY, JSON.stringify(migratedCurrent));
        writeRaw(storeKey(selected), JSON.stringify(migratedCurrent));
      }
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
  let multiStoreCloudRevision = 0;
  let multiStoreCloudBaseData = null;

  const baseSnapshot = parseJson(window.sessionStorage.getItem(CLOUD_BASE_KEY));
  if (baseSnapshot?.storeId === selectedStoreId && baseSnapshot?.revision >= 0 && validData(baseSnapshot.data)) {
    multiStoreCloudRevision = Number(baseSnapshot.revision) || 0;
    multiStoreCloudBaseData = migrateStoreLayout(selectedStoreId, baseSnapshot.data);
  } else {
    const pulledFlag = parseJson(window.sessionStorage.getItem(CLOUD_PULL_FLAG_PREFIX + selectedStoreId));
    if (pulledFlag?.revision >= 0) {
      const pulledState = parseJson(window.localStorage.getItem(MAIN_KEY));
      if (validData(pulledState)) {
        multiStoreCloudRevision = Number(pulledFlag.revision) || 0;
        multiStoreCloudBaseData = migrateStoreLayout(selectedStoreId, pulledState);
      }
      window.sessionStorage.removeItem(CLOUD_PULL_FLAG_PREFIX + selectedStoreId);
    } else {
      const sessionMeta = parseJson(window.sessionStorage.getItem(CLOUD_SESSION_PREFIX + selectedStoreId));
      if (sessionMeta?.revision >= 0) multiStoreCloudRevision = Number(sessionMeta.revision) || 0;
    }
  }

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

  function cloudClient() {
    return window.PLANOGRAM_CLOUD_CLIENT || null;
  }

  function cloudNote(message, isError = false) {
    const node = document.getElementById("cloudSyncStatus");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", isError);
  }

  function setCloudSessionMeta(revision) {
    multiStoreCloudRevision = Number(revision) || 0;
    window.sessionStorage.setItem(CLOUD_SESSION_PREFIX + selectedStoreId, JSON.stringify({
      revision: multiStoreCloudRevision,
      updatedAt: new Date().toISOString()
    }));
  }

  function persistCloudBase(data, revision) {
    const migrated = migrateStoreLayout(selectedStoreId, data);
    multiStoreCloudBaseData = clone(migrated);
    setCloudSessionMeta(revision);
    try {
      window.sessionStorage.setItem(CLOUD_BASE_KEY, JSON.stringify({
        storeId: selectedStoreId,
        revision: multiStoreCloudRevision,
        data: multiStoreCloudBaseData
      }));
    } catch (error) {
      console.warn("云端基准快照保存失败；刷新页面后需重新拉取云端数据。", error);
    }
  }

  async function requireMultiStoreCloudSession() {
    const client = cloudClient();
    if (!client) {
      cloudNote("云端组件加载失败，请刷新页面后重试。", true);
      return null;
    }
    const { data: { session }, error } = await client.auth.getSession();
    if (error || !session?.user) {
      cloudNote(error?.message || "请先登录云端协作账号。", true);
      return null;
    }
    return session;
  }

  function emptyCloudWrapper() {
    return {
      type: CLOUD_WRAPPER_TYPE,
      schemaVersion: CLOUD_SCHEMA_VERSION,
      version: "2026.07.29.06",
      updatedAt: new Date().toISOString(),
      stores: {},
      storeMeta: {}
    };
  }

  function normalizeCloudPayload(payload) {
    if (payload?.type === CLOUD_WRAPPER_TYPE && payload.stores && typeof payload.stores === "object") {
      return {
        ...clone(payload),
        type: CLOUD_WRAPPER_TYPE,
        schemaVersion: CLOUD_SCHEMA_VERSION,
        stores: clone(payload.stores || {}),
        storeMeta: clone(payload.storeMeta || {})
      };
    }
    const wrapper = emptyCloudWrapper();
    if (validData(payload)) {
      wrapper.stores[ORIGINAL_STORE_ID] = clone(payload);
      wrapper.storeMeta[ORIGINAL_STORE_ID] = {
        name: storeName(ORIGINAL_STORE_ID),
        migratedFromSingleStore: true
      };
    }
    return wrapper;
  }

  function currentLocalData() {
    const data = parseJson(window.localStorage.getItem(MAIN_KEY));
    const source = validData(data) ? data : buildStoreInitial(selectedStoreId);
    const migrated = migrateStoreLayout(selectedStoreId, source);
    if (!sameJson(migrated, source)) {
      writeRaw(storeKey(selectedStoreId), JSON.stringify(migrated));
      writeRaw(MAIN_KEY, JSON.stringify(migrated));
    }
    return migrated;
  }

  function sameCloudValue(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  function cloudClone(value) {
    return value === undefined ? undefined : clone(value);
  }

  function mergeCloudRecord(base, local, remote, label, conflicts) {
    if (sameCloudValue(local, base)) return cloudClone(remote);
    if (sameCloudValue(remote, base)) return cloudClone(local);
    if (sameCloudValue(local, remote)) return cloudClone(local);
    if (!base || !local || !remote || typeof base !== "object" || Array.isArray(base) || Array.isArray(local) || Array.isArray(remote)) {
      conflicts.push(label);
      return cloudClone(remote);
    }
    const merged = { ...cloudClone(remote) };
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    keys.forEach(key => {
      if (key === "id" || key === "layers") return;
      const baseValue = base[key];
      const localValue = local[key];
      const remoteValue = remote[key];
      if (sameCloudValue(localValue, baseValue)) return;
      if (sameCloudValue(remoteValue, baseValue) || sameCloudValue(localValue, remoteValue)) {
        merged[key] = cloudClone(localValue);
        return;
      }
      conflicts.push(label + " 字段:" + key);
    });
    return merged;
  }

  function productBlocks(pits) {
    const map = new Map();
    (pits || []).forEach(pit => {
      const list = map.get(pit.productId) || [];
      list.push(pit);
      map.set(pit.productId, list);
    });
    return map;
  }

  function mergeLayerPits(basePits, localPits, remotePits, label, conflicts) {
    if (sameCloudValue(localPits, basePits)) return clone(remotePits || []);
    if (sameCloudValue(remotePits, basePits)) return clone(localPits || []);
    if (sameCloudValue(localPits, remotePits)) return clone(localPits || []);
    const base = productBlocks(basePits);
    const local = productBlocks(localPits);
    const remote = productBlocks(remotePits);
    let merged = clone(remotePits || []);
    [...local.keys()].forEach(productId => {
      const baseBlock = base.get(productId) || [];
      const localBlock = local.get(productId) || [];
      const remoteBlock = remote.get(productId) || [];
      const localChanged = !sameCloudValue(localBlock, baseBlock);
      const remoteChanged = !sameCloudValue(remoteBlock, baseBlock);
      if (!localChanged) return;
      if (remoteChanged && !sameCloudValue(localBlock, remoteBlock)) {
        conflicts.push(label + " SKU:" + productId);
        return;
      }
      merged = merged.filter(pit => pit.productId !== productId);
      merged.push(...clone(localBlock));
    });
    return merged;
  }

  function mergeCloudGroups(base, local, remote, label, conflicts) {
    if (!base || !local || !remote) return mergeCloudRecord(base, local, remote, label, conflicts);
    const baseMeta = { ...base, layers: undefined };
    const localMeta = { ...local, layers: undefined };
    const remoteMeta = { ...remote, layers: undefined };
    const merged = mergeCloudRecord(baseMeta, localMeta, remoteMeta, label, conflicts);
    merged.layers = { ...clone(remote.layers || {}) };
    ["A", "B", "C", "D"].forEach(layer => {
      const baseLayer = base.layers?.[layer] || { pits: [] };
      const localLayer = local.layers?.[layer] || { pits: [] };
      const remoteLayer = remote.layers?.[layer] || { pits: [] };
      const layerMeta = mergeCloudRecord(
        { ...baseLayer, pits: undefined },
        { ...localLayer, pits: undefined },
        { ...remoteLayer, pits: undefined },
        label + "-" + layer,
        conflicts
      );
      layerMeta.pits = mergeLayerPits(baseLayer.pits, localLayer.pits, remoteLayer.pits, label + "-" + layer, conflicts);
      merged.layers[layer] = layerMeta;
    });
    return merged;
  }

  function mergeCloudList(baseList, localList, remoteList, label, merger, conflicts) {
    const map = list => new Map((list || []).map(item => [item.id, item]));
    const base = map(baseList);
    const local = map(localList);
    const remote = map(remoteList);
    const ids = [
      ...(remoteList || []).map(item => item.id),
      ...(localList || []).map(item => item.id).filter(id => !remote.has(id))
    ];
    return ids.map(id => merger(base.get(id), local.get(id), remote.get(id), label + " " + id, conflicts));
  }

  function mergeStoreData(base, local, remote) {
    base = validData(base) ? migrateStoreLayout(selectedStoreId, base) : base;
    local = validData(local) ? migrateStoreLayout(selectedStoreId, local) : local;
    remote = validData(remote) ? migrateStoreLayout(selectedStoreId, remote) : remote;
    if (!base) return { merged: clone(local), conflicts: [] };
    if (!remote) return { merged: clone(local), conflicts: [] };
    const conflicts = [];
    const merged = { ...cloudClone(remote) };
    merged.categories = [...new Set([...(remote.categories || []), ...(local.categories || [])])];
    merged.products = mergeCloudList(base.products, local.products, remote.products, "SKU", mergeCloudRecord, conflicts);
    merged.groups = mergeCloudList(base.groups, local.groups, remote.groups, "货架组", mergeCloudGroups, conflicts);
    const metaKeys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    metaKeys.forEach(key => {
      if (["categories", "products", "groups"].includes(key)) return;
      const baseValue = base[key];
      const localValue = local[key];
      const remoteValue = remote[key];
      if (sameCloudValue(localValue, baseValue)) return;
      if (sameCloudValue(remoteValue, baseValue) || sameCloudValue(localValue, remoteValue)) merged[key] = cloudClone(localValue);
      else conflicts.push("门店字段:" + key);
    });
    return { merged, conflicts };
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

  async function saveCloudWrapper(wrapper, expectedRevision) {
    const client = cloudClient();
    wrapper.updatedAt = new Date().toISOString();
    const { data, error } = await client.rpc("save_planogram_document", {
      p_payload: wrapper,
      p_expected_revision: expectedRevision
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return Number(row?.revision) || Number(expectedRevision) + 1;
  }

  function applyCloudStoreLocally(data, revision, pendingExport = false) {
    const migrated = migrateStoreLayout(selectedStoreId, data);
    persistCloudBase(migrated, revision);
    writeRaw(storeKey(selectedStoreId), JSON.stringify(migrated));
    writeRaw(MAIN_KEY, JSON.stringify(migrated));
    writeRaw(ACTIVE_KEY, selectedStoreId);
    writeRaw(SELECTED_KEY, selectedStoreId);
    window.sessionStorage.setItem(CLOUD_PULL_FLAG_PREFIX + selectedStoreId, JSON.stringify({ revision }));
    if (pendingExport) window.sessionStorage.setItem(CLOUD_EXPORT_FLAG, selectedStoreId);
    window.location.reload();
  }

  async function pullCurrentStoreCloud(options = {}) {
    if (!await requireMultiStoreCloudSession()) return;
    cloudNote("正在拉取“" + storeName(selectedStoreId) + "”云端数据…");
    try {
      const remote = await readCloudDocument();
      const wrapper = normalizeCloudPayload(remote?.payload);
      const rawStoreData = wrapper.stores[selectedStoreId];
      const storeData = validData(rawStoreData)
        ? migrateStoreLayout(selectedStoreId, rawStoreData)
        : rawStoreData;
      setCloudSessionMeta(remote?.revision || 0);
      if (!validData(storeData)) {
        cloudNote("“" + storeName(selectedStoreId) + "”云端尚未初始化。确认本地陈列后点击“保存至云端”即可创建。", true);
        return;
      }
      cloudNote("已拉取“" + storeName(selectedStoreId) + "”云端第 " + (remote?.revision || 0) + " 版，正在刷新页面…");
      applyCloudStoreLocally(clone(storeData), remote?.revision || 0, Boolean(options.exportAfterPull));
    } catch (error) {
      cloudNote(error.message || "云端数据拉取失败。", true);
    }
  }

  async function pushCurrentStoreCloud(attempt = 0) {
    const session = await requireMultiStoreCloudSession();
    if (!session) return;
    cloudNote("正在保存“" + storeName(selectedStoreId) + "”至云端…");
    try {
      const localData = currentLocalData();
      const remote = await readCloudDocument();
      const wrapper = normalizeCloudPayload(remote?.payload);
      const rawRemoteStoreData = wrapper.stores[selectedStoreId];
      const remoteStoreData = validData(rawRemoteStoreData)
        ? migrateStoreLayout(selectedStoreId, rawRemoteStoreData)
        : rawRemoteStoreData;
      let nextStoreData = clone(localData);

      if (validData(remoteStoreData)) {
        if (!multiStoreCloudBaseData) {
          cloudNote("当前页面尚未建立该门店的云端基准，请先点击“拉取云端数据”，再修改并保存。", true);
          return;
        }
        const result = mergeStoreData(multiStoreCloudBaseData, localData, remoteStoreData);
        if (result.conflicts.length) {
          cloudNote("发现同一门店数据冲突：" + result.conflicts.slice(0, 3).join("、") + "。本地修改仍保留，请先拉取核对后再保存。", true);
          return;
        }
        nextStoreData = result.merged;
      }

      wrapper.stores[selectedStoreId] = clone(nextStoreData);
      wrapper.storeMeta[selectedStoreId] = {
        ...(wrapper.storeMeta[selectedStoreId] || {}),
        name: storeName(selectedStoreId),
        updatedAt: new Date().toISOString(),
        updatedBy: session.user.email || session.user.id
      };

      const revision = await saveCloudWrapper(wrapper, remote?.revision || 0);
      persistCloudBase(nextStoreData, revision);
      writeRaw(storeKey(selectedStoreId), JSON.stringify(nextStoreData));
      writeRaw(MAIN_KEY, JSON.stringify(nextStoreData));
      cloudNote("“" + storeName(selectedStoreId) + "”已保存至云端第 " + revision + " 版；其他门店数据未被覆盖。");
    } catch (error) {
      if (error?.code === "P0001" && attempt < 1) {
        cloudNote("云端刚被其他成员更新，正在自动合并后重试…");
        await pushCurrentStoreCloud(attempt + 1);
        return;
      }
      cloudNote(error.message || "云端保存失败。", true);
    }
  }

  async function restoreCurrentStoreCloud() {
    const passwordInput = document.getElementById("restorePasswordInput");
    if (passwordInput?.value !== "666888") {
      cloudNote("恢复密码不正确。", true);
      return;
    }
    if (!await requireMultiStoreCloudSession()) return;
    if (!window.confirm("确认仅恢复“" + storeName(selectedStoreId) + "”的云端首版吗？其他门店不会受影响。")) return;
    cloudNote("正在恢复“" + storeName(selectedStoreId) + "”云端首版…");
    try {
      const remote = await readCloudDocument();
      const wrapper = normalizeCloudPayload(remote?.payload);
      const restored = buildStoreInitial(selectedStoreId);
      wrapper.stores[selectedStoreId] = clone(restored);
      wrapper.storeMeta[selectedStoreId] = {
        ...(wrapper.storeMeta[selectedStoreId] || {}),
        name: storeName(selectedStoreId),
        restoredAt: new Date().toISOString()
      };
      const revision = await saveCloudWrapper(wrapper, remote?.revision || 0);
      const dialog = document.getElementById("resetConfirmDialog");
      if (dialog?.open) dialog.close();
      cloudNote("“" + storeName(selectedStoreId) + "”已恢复为云端第 " + revision + " 版，正在刷新页面…");
      applyCloudStoreLocally(restored, revision, false);
    } catch (error) {
      cloudNote(error.message || "恢复云端首版失败。", true);
    }
  }

  function interceptButton(id, handler) {
    const node = document.getElementById(id);
    if (!node || node.dataset.multistoreCloudBound === "1") return;
    node.dataset.multistoreCloudBound = "1";
    node.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve(handler(event)).catch(error => cloudNote(error.message || "云端操作失败。", true));
    }, true);
  }

  function installMultiStoreCloudControls() {
    ["cloudBtn", "exportCloudExcelBtn", "resetBtn"].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.hidden = false;
    });

    const cloudTitle = document.querySelector("#cloudDialog .dialog-header h2");
    if (cloudTitle) cloudTitle.textContent = storeName(selectedStoreId) + "｜云端数据协作";
    const cloudHelper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (cloudHelper) cloudHelper.textContent = "当前仅拉取和保存已选择门店；各门店云端数据相互独立，不会覆盖。";
    const resetTitle = document.querySelector("#resetConfirmDialog .dialog-header h2");
    if (resetTitle) resetTitle.textContent = "恢复当前门店云端底表";
    const resetHelper = document.querySelector("#resetConfirmDialog .helper");
    if (resetHelper) resetHelper.textContent = "输入密码后，仅用当前门店首版覆盖该门店的云端和本机数据，其他门店不受影响。";

    interceptButton("cloudPullBtn", () => pullCurrentStoreCloud());
    interceptButton("cloudPushBtn", () => pushCurrentStoreCloud());
    interceptButton("exportCloudExcelBtn", () => pullCurrentStoreCloud({ exportAfterPull: true }));
    interceptButton("confirmResetBtn", restoreCurrentStoreCloud);

    const pendingExportStore = window.sessionStorage.getItem(CLOUD_EXPORT_FLAG);
    if (pendingExportStore === selectedStoreId) {
      window.sessionStorage.removeItem(CLOUD_EXPORT_FLAG);
      window.setTimeout(() => document.getElementById("exportExcelBtn")?.click(), 150);
    }
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
      ${context.isOriginalStore ? "" : '<button id="storePointBtn" class="btn" type="button">门店点位</button>'}
    `;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change", event => switchStore(event.target.value));

    installMultiStoreCloudControls();

    if (!context.isOriginalStore) {
      const status = document.getElementById("statusBar");
      if (status) status.textContent = `${context.storeName}已按实际连续货架带展示；本地调整与云端协作均按门店隔离。`;
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
