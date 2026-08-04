(() => {
  "use strict";
  const VERSION = "2026.08.03.07";
  const DB_NAME = "planogram-eight-store-recovery-v1";
  const DB_VERSION = 1;
  const DB_STORE = "stores";
  const MAIN_KEY = "planogram-webapp-state-v1";
  const SELECTED_KEY = "planogram-selected-store-v1";
  const ACTIVE_KEY = "planogram-active-store-v1";
  const STORE_IDS = ["hexian-xiaoshikou", "tongling-yurun", "jiujiang-zhonghui", "fanchang-zhongchen", "luan-zizhulin", "wuhu-fenghuangcheng", "sanshan-xingyue", "jiujiang-wantai"];
  const STORE_NAMES = {"hexian-xiaoshikou": "和县小市口生活馆", "tongling-yurun": "铜陵雨润广场生活馆", "jiujiang-zhonghui": "九江中辉世纪城生活馆", "fanchang-zhongchen": "繁昌中辰一品生活馆", "luan-zizhulin": "六安紫竹林生活馆", "wuhu-fenghuangcheng": "芜湖凤凰城生活馆", "sanshan-xingyue": "三山星悦广场生活馆", "jiujiang-wantai": "九江万泰城生活馆"};
  const nativeSetItem = Storage.prototype.setItem;
  const nativeGetItem = Storage.prototype.getItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  const clone = value => JSON.parse(JSON.stringify(value));
  const parse = value => { try { return value ? JSON.parse(value) : null; } catch (_) { return null; } };
  const valid = value => Boolean(value && Array.isArray(value.products) && value.products.length && Array.isArray(value.groups) && value.groups.length);

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
      request.onerror = () => reject(request.error || new Error("读取门店数据失败"));
    });
  }
  function dbPut(db, id, data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ id, name: STORE_NAMES[id], data: clone(data), updatedAt: new Date().toISOString() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error("保存门店数据失败"));
      tx.onabort = () => reject(tx.error || new Error("保存门店数据中止"));
    });
  }
  function purgePlanogramLocal() {
    const keys=[];
    for (let i=0;i<localStorage.length;i++) { const key=localStorage.key(i); if (key && key.startsWith("planogram-")) keys.push(key); }
    keys.forEach(key => nativeRemoveItem.call(localStorage,key));
  }
  function writeCurrent(id, data) {
    const payload=JSON.stringify(data);
    try {
      nativeSetItem.call(localStorage,SELECTED_KEY,id);
      nativeSetItem.call(localStorage,ACTIVE_KEY,id);
      nativeSetItem.call(localStorage,MAIN_KEY,payload);
    } catch (error) {
      purgePlanogramLocal();
      nativeSetItem.call(localStorage,SELECTED_KEY,id);
      nativeSetItem.call(localStorage,ACTIVE_KEY,id);
      nativeSetItem.call(localStorage,MAIN_KEY,payload);
    }
  }
  function downloadJson(filename, value) {
    const blob=new Blob([JSON.stringify(value,null,2)],{type:"application/json;charset=utf-8"});
    const url=URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
  }

  let dbRef=null;
  let saveTimer=null;
  async function prepare() {
    dbRef=await openDb();
    let selected=nativeGetItem.call(localStorage,SELECTED_KEY);
    let active=nativeGetItem.call(localStorage,ACTIVE_KEY);
    const current=parse(nativeGetItem.call(localStorage,MAIN_KEY));
    if (!STORE_IDS.includes(selected)) selected=STORE_IDS.includes(active)?active:STORE_IDS[0];
    if (STORE_IDS.includes(active) && valid(current)) await dbPut(dbRef,active,current);
    let data=await dbGet(dbRef,selected);
    if (!valid(data) && active===selected && valid(current)) data=current;
    if (!valid(data)) throw new Error("尚未导入8家门店恢复数据，请先打开“恢复全部门店_容量安全.html”执行恢复。");
    purgePlanogramLocal();
    writeCurrent(selected,data);
    window.PLANOGRAM_INITIAL_DATA=clone(data);
    window.PLANOGRAM_STORE_CONTEXT={storeId:selected,storeName:STORE_NAMES[selected],isOriginalStore:selected===STORE_IDS[0],config:{name:STORE_NAMES[selected],meta:data.storeMeta||{}}};

    Storage.prototype.setItem=function(key,value) {
      try { nativeSetItem.call(this,key,value); } catch(error) {
        if (this===localStorage && key===MAIN_KEY) {
          const id=nativeGetItem.call(localStorage,ACTIVE_KEY)||selected;
          purgePlanogramLocal();
          nativeSetItem.call(localStorage,SELECTED_KEY,id);
          nativeSetItem.call(localStorage,ACTIVE_KEY,id);
          nativeSetItem.call(localStorage,MAIN_KEY,value);
        } else throw error;
      }
      if (this===localStorage && key===MAIN_KEY) {
        const id=nativeGetItem.call(localStorage,ACTIVE_KEY)||selected;
        const parsed=parse(value);
        if (STORE_IDS.includes(id) && valid(parsed)) {
          clearTimeout(saveTimer);
          saveTimer=setTimeout(()=>dbPut(dbRef,id,parsed).catch(console.error),120);
        }
      }
    };
    return {db:dbRef,selected,data};
  }
  window.PLANOGRAM_STORE_READY=prepare();

  async function switchStore(nextId) {
    if (!STORE_IDS.includes(nextId)) return;
    const currentId=nativeGetItem.call(localStorage,ACTIVE_KEY)||STORE_IDS[0];
    const current=parse(nativeGetItem.call(localStorage,MAIN_KEY));
    if (valid(current)) await dbPut(dbRef,currentId,current);
    const next=await dbGet(dbRef,nextId);
    if (!valid(next)) throw new Error(STORE_NAMES[nextId]+"恢复数据不存在");
    purgePlanogramLocal();
    writeCurrent(nextId,next);
    location.reload();
  }
  async function downloadAll() {
    const stores={};
    for (const id of STORE_IDS) { const data=await dbGet(dbRef,id); if (valid(data)) stores[id]=data; }
    downloadJson(`八家门店IndexedDB完整备份_${new Date().toISOString().replace(/[:.]/g,"-")}.json`,{type:"planogram-idb-all-store-backup",version:VERSION,createdAt:new Date().toISOString(),stores});
  }
  function lockCloud() {
    ["cloudPullBtn","cloudPushBtn","confirmResetBtn","exportCloudExcelBtn"].forEach(id=>{const el=document.getElementById(id);if(el){el.disabled=true;el.title="数据恢复期间云端写入和拉取均已锁定";}});
    const node=document.getElementById("cloudSyncStatus"); if(node) node.textContent="容量安全恢复模式：云端拉取与写入均已锁定。";
  }
  async function injectUi() {
    await window.PLANOGRAM_STORE_READY;
    const context=window.PLANOGRAM_STORE_CONTEXT;
    const titleRoot=document.querySelector(".topbar > div:first-child");
    const eyebrow=titleRoot?.querySelector(".eyebrow"); if(eyebrow) eyebrow.textContent=context.storeName;
    const holder=document.createElement("div"); holder.className="store-switcher";
    holder.innerHTML=`<label for="storeSelect">门店</label><select id="storeSelect">${STORE_IDS.map(id=>`<option value="${id}" ${id===context.storeId?"selected":""}>${STORE_NAMES[id]}</option>`).join("")}</select><button id="downloadIdbAllBtn" class="btn" type="button">备份全部8家门店</button>`;
    titleRoot?.appendChild(holder);
    holder.querySelector("#storeSelect")?.addEventListener("change",event=>{event.target.disabled=true;switchStore(event.target.value).catch(error=>{event.target.disabled=false;alert(error.message);});});
    holder.querySelector("#downloadIdbAllBtn")?.addEventListener("click",()=>downloadAll().catch(error=>alert(error.message)));
    lockCloud();
    const status=document.getElementById("statusBar"); if(status){status.textContent=`容量安全恢复已启用：8家门店保存在IndexedDB；当前为“${context.storeName}”，人工修改会自动保存。云端读写暂时锁定。`;status.classList.remove("error");}
  }
  window.addEventListener("planogram:app-ready",injectUi,{once:true});
  window.PLANOGRAM_IDB_DEBUG={version:VERSION,storeIds:STORE_IDS.slice(),switchStore,downloadAll};
})();
