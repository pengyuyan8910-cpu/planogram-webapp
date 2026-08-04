(() => {
  "use strict";

  const VERSION = "2026.08.04.08";
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

  async function prepare() {
    dbRef = await openDb();
    let selected = nativeGetItem.call(localStorage, SELECTED_KEY);
    let active = nativeGetItem.call(localStorage, ACTIVE_KEY);
    const current = parse(nativeGetItem.call(localStorage, MAIN_KEY));
    if (!STORE_IDS.includes(selected)) selected = STORE_IDS.includes(active) ? active : STORE_IDS[0];
    if (STORE_IDS.includes(active) && valid(current)) await dbPut(dbRef, active, validateStoreData(current, `本地“${STORE_NAMES[active]}”`));
    let data = await dbGet(dbRef, selected);
    if (!valid(data) && active === selected && valid(current)) data = current;
    if (!valid(data)) throw new Error("尚未恢复8家门店数据，请先使用容量安全恢复页面。\n");
    validateStoreData(data, `本地“${STORE_NAMES[selected]}”`);
    selectedStoreId = selected;
    purgePlanogramLocal();
    writeCurrent(selected, data);
    window.PLANOGRAM_INITIAL_DATA = clone(data);
    window.PLANOGRAM_STORE_CONTEXT = {
      storeId: selected,
      storeName: STORE_NAMES[selected],
      isOriginalStore: selected === STORE_IDS[0],
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
    return { db: dbRef, selected, data };
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
      cloudNote(`云端第${remote.revision}版已核对：${8 - mismatches.length}家一致；以下门店本地与云端不同，未覆盖：${mismatches.join("、")}。请切换到对应门店后使用“安全拉取当前门店”核对。`, true);
      return { revision: remote.revision, mismatches };
    }
    cloudNote(`核对完成：本地8家门店与云端第${remote.revision}版完全一致。现在可以编辑，修改后使用“安全保存当前门店”。`);
    return { revision: remote.revision, mismatches: [] };
  }

  async function safePullCurrentStore(options = {}) {
    await requireSession();
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    cloudNote(`正在安全拉取“${STORE_NAMES[id]}”…`);
    const remote = await readCloudDocument();
    const remoteData = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
    const localData = await currentData();

    if (sameData(localData, remoteData)) {
      await setCloudBase(dbRef, id, remoteData, remote.revision);
      cloudNote(`“${STORE_NAMES[id]}”本地与云端第${remote.revision}版完全一致，已建立安全保存基准。`);
      return { changed: false, revision: remote.revision };
    }

    await downloadCurrentBackup("安全拉取前备份");
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
    cloudNote(`“${STORE_NAMES[id]}”已安全拉取云端第${remote.revision}版，正在刷新。`);
    if (!options.noReload) location.reload();
    return { changed: true, revision: remote.revision };
  }

  async function safePushCurrentStore() {
    const session = await requireSession();
    const id = nativeGetItem.call(localStorage, ACTIVE_KEY) || selectedStoreId;
    cloudNote(`正在安全保存“${STORE_NAMES[id]}”…`);
    const localData = await currentData();
    const baseData = await getCloudBase(dbRef, id);
    if (!valid(baseData)) {
      throw new Error(`“${STORE_NAMES[id]}”尚未建立云端基准。请先点击“核对全部8家云端”或“安全拉取当前门店”。`);
    }

    const remote = await readCloudDocument();
    const remoteCurrent = validateStoreData(remote.payload.stores[id], `云端“${STORE_NAMES[id]}”`);
    if (!sameData(remoteCurrent, baseData)) {
      throw new Error(`“${STORE_NAMES[id]}”云端已被其他成员更新。已阻止保存，避免覆盖。请先安全拉取当前门店核对。`);
    }
    if (sameData(localData, remoteCurrent)) {
      await setCloudBase(dbRef, id, remoteCurrent, remote.revision);
      cloudNote(`“${STORE_NAMES[id]}”没有新修改，无需保存；当前云端为第${remote.revision}版。`);
      return { changed: false, revision: remote.revision };
    }

    await downloadCurrentBackup("安全保存前备份");
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
    cloudNote(`“${STORE_NAMES[id]}”已安全保存至云端第${revision}版；其他7家门店原样保留。`);
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

  function installSafeCloudControls() {
    const pull = document.getElementById("cloudPullBtn");
    const push = document.getElementById("cloudPushBtn");
    if (pull) { pull.disabled = false; pull.textContent = "安全拉取当前门店"; pull.title = "只覆盖当前门店；数据不同会先下载备份并二次确认"; }
    if (push) { push.disabled = false; push.textContent = "安全保存当前门店"; push.title = "保存前核对云端基准；只替换当前门店，保留其他7家"; }

    const actions = pull?.closest(".dialog-actions");
    if (actions && !document.getElementById("cloudCheckAllBtn")) {
      const check = document.createElement("button");
      check.id = "cloudCheckAllBtn";
      check.className = "btn";
      check.type = "button";
      check.textContent = "核对全部8家云端";
      actions.insertBefore(check, pull || actions.firstChild);
    }
    const helper = document.querySelector("#cloudDialog .admin-section:nth-of-type(2) p");
    if (helper) helper.textContent = "首次先点击“核对全部8家云端”。保存时只更新当前门店，并保留另外7家；检测到冲突会自动阻止覆盖。";
    const title = document.querySelector("#cloudDialog .dialog-header h2");
    if (title) title.textContent = `${STORE_NAMES[selectedStoreId]}｜安全云端协作`;

    const reset = document.getElementById("confirmResetBtn");
    if (reset) { reset.disabled = true; reset.title = "安全模式禁止恢复底表"; }
    const exportCloud = document.getElementById("exportCloudExcelBtn");
    if (exportCloud) { exportCloud.disabled = true; exportCloud.title = "请使用当前品类Excel陈列图导出"; }

    interceptButton("cloudCheckAllBtn", checkAllCloud);
    interceptButton("cloudPullBtn", safePullCurrentStore);
    interceptButton("cloudPushBtn", safePushCurrentStore);
    cloudNote("安全云端协作已启用。首次请登录后点击“核对全部8家云端”。");
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
      event.target.disabled = true;
      switchStore(event.target.value).catch(error => { event.target.disabled = false; alert(error.message); });
    });
    holder.querySelector("#downloadIdbAllBtn")?.addEventListener("click", () => downloadAll().catch(error => alert(error.message)));

    installSafeCloudControls();
    const status = document.getElementById("statusBar");
    if (status) {
      status.textContent = `8家门店已安全保存在IndexedDB；当前为“${context.storeName}”。云端协作已解锁，首次请进入云端协作核对全部8家。`;
      status.classList.remove("error");
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
    getCloudBase: id => getCloudBase(dbRef, id)
  };
})();
